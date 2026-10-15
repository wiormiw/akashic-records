import { and, eq, type SQL, sql } from "drizzle-orm";
import type { NamedUser, Recall, Votes } from "@akashic/contracts";
import { type Executor, inTransaction, recalls, recallVotes } from "@akashic/db";
import { narrow, RealmRole, RecallKind, RecallStatus } from "@akashic/lib/enums";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok, type Result } from "@akashic/lib/result";
import { fromDate, toDate } from "@akashic/lib/time";
import { cannotCarry, majority, roleOf, sizeOf } from "./governance.seats.service.ts";
import type { NewRecall, RecallDeps, RecallOpened, RecallTally } from "./governance.types.ts";

// ---- Rules -----------------------------------------------------------------------------------

/**
 * Votes needed to recall a moderator. The membership needs a simple majority; fellow moderators
 * need 80%, so a clique can't remove a colleague who disagrees with them.
 */
export const recallThreshold = (kind: RecallKind, electorate: number): number =>
  kind === RecallKind.members ? majority(electorate) : Math.max(1, Math.ceil(electorate * 0.8));

/** Whether someone with `role` takes part in a recall of `kind`: a moderators' recall is theirs alone. */
export const mayTakePart = (kind: RecallKind, role: RealmRole | null): boolean =>
  kind === RecallKind.members || (role !== null && role >= RealmRole.moderator);

const notTheirs = () =>
  err(
    fail.forbidden(
      ErrorCode.realm.forbidden,
      "Only moderators propose or vote on a moderators' recall.",
    ),
  );

// ---- Queries ---------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const person = (id: unknown, name: unknown): NamedUser | null =>
  id ? { id: String(id), name: String(name ?? "") } : null;

const toRecall = (row: Row): Recall => ({
  id: String(row.id),
  realmId: String(row.realm_id),
  kind: narrow(RecallKind, Number(row.kind)),
  reason: String(row.reason),
  status: narrow(RecallStatus, Number(row.status)),
  agrees: Number(row.agrees),
  refusals: Number(row.refusals),
  subject: person(row.subject_id, row.subject_name),
  proposedBy: person(row.proposer_id, row.proposer_name),
  createdAt: fromDate(new Date(String(row.created_at))),
});

const selectRecalls = (where: SQL, tail: SQL = sql``) => sql`
  SELECT r.id, r.realm_id, r.kind, r.reason, r.status, r.created_at,
    s.id AS subject_id, s.name AS subject_name,
    p.id AS proposer_id, p.name AS proposer_name,
    count(v.*) FILTER (WHERE v.agree)::int AS agrees,
    count(v.*) FILTER (WHERE NOT v.agree)::int AS refusals
  FROM recall r
  LEFT JOIN "user" s ON s.id = r.subject_id
  LEFT JOIN "user" p ON p.id = r.proposed_by
  LEFT JOIN recall_vote v ON v.recall_id = r.id
  WHERE ${where}
  GROUP BY r.id, s.id, p.id
  ${tail}
`;

async function findRecall(db: Executor, id: string): Promise<Recall | undefined> {
  const [row] = (await db.execute(selectRecalls(sql`r.id = ${id}`))) as unknown as Row[];
  return row && toRecall(row);
}

/** Records the vote, replacing the voter's earlier one, and answers the tally after it. */
async function castVote(
  db: Executor,
  recallId: string,
  voterId: string,
  agree: boolean,
): Promise<Votes> {
  await db
    .insert(recallVotes)
    .values({ recallId, voterId, agree })
    .onConflictDoUpdate({ target: [recallVotes.recallId, recallVotes.voterId], set: { agree } });
  const [row] = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE agree)::int AS agrees,
           count(*) FILTER (WHERE NOT agree)::int AS refusals
    FROM recall_vote WHERE recall_id = ${recallId}
  `)) as unknown as Votes[];
  return { agrees: Number(row?.agrees ?? 0), refusals: Number(row?.refusals ?? 0) };
}

/** Only an open recall resolves; false when it was already settled, by a concurrent vote say. */
async function resolve(db: Executor, id: string, status: RecallStatus, at: Date): Promise<boolean> {
  const updated = await db
    .update(recalls)
    .set({ status, resolvedAt: at })
    .where(and(eq(recalls.id, id), eq(recalls.status, RecallStatus.open)))
    .returning({ id: recalls.id });
  return updated.length > 0;
}

/** Undefined when a recall is already open against that member. */
async function openRecall(db: Executor, recall: NewRecall): Promise<string | undefined> {
  const [created] = await db
    .insert(recalls)
    .values(recall)
    .onConflictDoNothing()
    .returning({ id: recalls.id });
  return created?.id;
}

// ---- Service ---------------------------------------------------------------------------------

export function createRecallService(deps: RecallDeps) {
  const { db, clock, seats } = deps;

  return {
    async openRecalls(realmId: string, limit: number): Promise<Recall[]> {
      const rows = (await db.execute(
        selectRecalls(
          sql`r.realm_id = ${realmId} AND r.status = ${RecallStatus.open}`,
          sql`ORDER BY r.created_at ASC LIMIT ${limit}`,
        ),
      )) as unknown as Row[];
      return rows.map(toRecall);
    },

    async proposeRecall(
      realmId: string,
      subjectId: string,
      kind: RecallKind,
      reason: string,
      proposerId: string,
    ): Promise<Result<RecallOpened>> {
      // The electorate is the moderators; anyone else proposing would cast a vote they don't hold.
      if (!mayTakePart(kind, await roleOf(db, realmId, proposerId))) return notTheirs();
      const seat = await seats.requireSeatHolder(
        realmId,
        subjectId,
        "Admins are not recalled. Their standing comes from running the realm, not from a seat.",
      );
      if (!seat.ok) return seat;
      return inTransaction(db, async (tx) => {
        const size = await sizeOf(tx, realmId);
        const electorate = kind === RecallKind.members ? size.members : size.moderators;
        const id = await openRecall(tx, {
          realmId,
          subjectId,
          kind,
          reason,
          proposedBy: proposerId,
        });
        if (!id) {
          return err(
            fail.conflict(
              ErrorCode.realm.alreadyMember,
              "A recall is already open against them. Vote on it instead.",
            ),
          );
        }
        await castVote(tx, id, proposerId, true);
        return ok({ id, electorate, needed: recallThreshold(kind, electorate) });
      });
    },

    async voteOnRecall(
      realmId: string,
      recallId: string,
      voterId: string,
      agree: boolean,
    ): Promise<Result<RecallTally>> {
      const recall = await findRecall(db, recallId);
      // Scoped to the realm in the path, so a member elsewhere can't vote here.
      if (!recall || recall.realmId !== realmId)
        return err(fail.notFound(ErrorCode.realm.notFound, "No such recall."));
      if (recall.status !== RecallStatus.open) {
        return err(fail.conflict(ErrorCode.realm.alreadyMember, "That recall is already settled."));
      }
      if (!mayTakePart(recall.kind, await roleOf(db, realmId, voterId))) return notTheirs();

      return inTransaction<RecallTally>(db, async (tx) => {
        const size = await sizeOf(tx, realmId);
        const electorate = recall.kind === RecallKind.members ? size.members : size.moderators;
        const needed = recallThreshold(recall.kind, electorate);
        const { agrees, refusals } = await castVote(tx, recallId, voterId, agree);
        const now = toDate(clock.now());

        if (agrees >= needed) {
          const subjectId = recall.subject?.id;
          // A concurrent vote that resolved it first has done the unseating already.
          if ((await resolve(tx, recallId, RecallStatus.carried, now)) && subjectId) {
            await seats.unseat(tx, realmId, subjectId, {
              actorId: voterId,
              changes: {
                by: `recall.${recall.kind === RecallKind.members ? "members" : "moderators"}`,
                reason: recall.reason,
                agrees,
              },
            });
          }
          return ok({ status: RecallStatus.carried, agrees, refusals, needed });
        }
        if (cannotCarry(refusals, electorate, needed)) {
          await resolve(tx, recallId, RecallStatus.refused, now);
          return ok({ status: RecallStatus.refused, agrees, refusals, needed });
        }
        return ok({ status: RecallStatus.open, agrees, refusals, needed });
      });
    },
  };
}
