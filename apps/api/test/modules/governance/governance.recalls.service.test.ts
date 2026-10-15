import { afterAll, describe, expect, test } from "bun:test";
import { createDb, type Tx } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import { RealmRole, RecallKind, RecallStatus } from "@akashic/lib/enums";
import { ErrorCode } from "@akashic/lib/errors";
import { silentLogger } from "@akashic/lib/log";
import { expectErr, expectOk } from "@akashic/lib/testing";
import { mayTakePart, recallThreshold } from "@/modules/governance/governance.recalls.service.ts";
import { databaseUrl } from "../../support/fixtures.ts";
import { world, type World } from "./fixtures.ts";

describe("recall threshold", () => {
  test("members recall by majority, moderators by eighty percent", () => {
    expect(recallThreshold(RecallKind.members, 10)).toBe(6);
    expect(recallThreshold(RecallKind.moderators, 10)).toBe(8);
    expect(recallThreshold(RecallKind.moderators, 0)).toBe(1);
  });
});

describe("who takes part in a recall", () => {
  test("anyone in a members' recall; only moderators and admins in a moderators' one", () => {
    expect(mayTakePart(RecallKind.members, RealmRole.member)).toBe(true);
    expect(mayTakePart(RecallKind.moderators, RealmRole.member)).toBe(false);
    expect(mayTakePart(RecallKind.moderators, RealmRole.verified)).toBe(false);
    expect(mayTakePart(RecallKind.moderators, null)).toBe(false);
    expect(mayTakePart(RecallKind.moderators, RealmRole.moderator)).toBe(true);
    expect(mayTakePart(RecallKind.moderators, RealmRole.admin)).toBe(true);
  });
});

// The recalls service on the real database, each test in a transaction that is rolled back.

const database = createDb({
  url: databaseUrl,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const inWorld = (run: (w: World, tx: Tx) => Promise<void>) =>
  withRollback(database.db, (tx) => run(world(tx), tx));

const REASON = "Not doing the job.";

/**
 * A members' recall in a realm of five (the founder, a moderator and three members): a majority
 * is three, so three agrees carry it and three refusals make carrying impossible. The first
 * member proposes it, which counts as their agreeing vote.
 */
async function openRecall(w: World) {
  const realm = await w.realm(4);
  const [moderator, proposer, ...others] = realm.people as [string, string, ...string[]];
  await w.setRole(realm.id, moderator, RealmRole.moderator);
  const recall = expectOk(
    await w.recalls.proposeRecall(realm.id, moderator, RecallKind.members, REASON, proposer),
  );
  return { ...realm, moderator, proposer, voters: [realm.admin, ...others], recall };
}

describe.skipIf(!live)("proposing a recall", () => {
  test("opens it with the proposer's vote, and says what carrying it needs", () =>
    inWorld(async (w) => {
      const { id, recall, moderator, proposer } = await openRecall(w);
      expect(recall).toMatchObject({ electorate: 5, needed: 3 });

      const [listed] = await w.recalls.openRecalls(id, 50);
      expect(listed).toMatchObject({
        id: recall.id,
        realmId: id,
        subject: { id: moderator, name: "Member 0" },
        proposedBy: { id: proposer, name: "Member 1" },
        kind: RecallKind.members,
        reason: REASON,
        status: RecallStatus.open,
        agrees: 1,
        refusals: 0,
      });
    }));

  test("the moderators' electorate is everyone who moderates, at eighty percent", () =>
    inWorld(async (w) => {
      const { id, admin, people } = await w.realm(2);
      const [moderator] = people as [string];
      await w.setRole(id, moderator, RealmRole.moderator);
      expect(
        expectOk(
          await w.recalls.proposeRecall(id, moderator, RecallKind.moderators, REASON, admin),
        ),
      ).toMatchObject({ electorate: 2, needed: 2 });
    }));

  test("one open recall per moderator; admins and members can't be recalled", () =>
    inWorld(async (w) => {
      const { id, moderator, proposer, admin, voters } = await openRecall(w);
      expectErr(
        await w.recalls.proposeRecall(id, moderator, RecallKind.members, REASON, voters[1]!),
        ErrorCode.realm.alreadyMember,
      );
      expectErr(
        await w.recalls.proposeRecall(id, admin, RecallKind.members, REASON, proposer),
        ErrorCode.common.validation,
      );
      expectErr(
        await w.recalls.proposeRecall(id, voters[1]!, RecallKind.members, REASON, proposer),
        ErrorCode.realm.notMember,
      );
      expect(await w.recalls.openRecalls(id, 50)).toHaveLength(1);
    }));
});

describe.skipIf(!live)("a moderators' recall", () => {
  test("a member can neither propose one nor vote on one; a moderator can", () =>
    inWorld(async (w) => {
      const { id, admin, people } = await w.realm(3);
      const [subject, colleague, member] = people as [string, string, string];
      await w.setRole(id, subject, RealmRole.moderator);
      await w.setRole(id, colleague, RealmRole.moderator);

      expectErr(
        await w.recalls.proposeRecall(id, subject, RecallKind.moderators, REASON, member),
        ErrorCode.realm.forbidden,
      );
      expect(await w.recalls.openRecalls(id, 50)).toEqual([]);

      const recall = expectOk(
        await w.recalls.proposeRecall(id, subject, RecallKind.moderators, REASON, admin),
      );
      expectErr(
        await w.recalls.voteOnRecall(id, recall.id, member, true),
        ErrorCode.realm.forbidden,
      );
      expect((await w.recalls.openRecalls(id, 50))[0]).toMatchObject({ agrees: 1, refusals: 0 });
      expect(expectOk(await w.recalls.voteOnRecall(id, recall.id, colleague, false))).toMatchObject(
        { refusals: 1 },
      );
    }));
});

describe.skipIf(!live)("voting on a recall", () => {
  test("the vote that reaches a majority carries it and unseats the moderator", () =>
    inWorld(async (w) => {
      const { id, recall, moderator, voters } = await openRecall(w);
      await w.upvotes(id, moderator, voters);

      expect(expectOk(await w.recalls.voteOnRecall(id, recall.id, voters[0]!, true))).toEqual({
        status: RecallStatus.open,
        agrees: 2,
        refusals: 0,
        needed: 3,
      });
      expect(expectOk(await w.recalls.voteOnRecall(id, recall.id, voters[1]!, false)).status).toBe(
        RecallStatus.open,
      );
      expect(expectOk(await w.recalls.voteOnRecall(id, recall.id, voters[2]!, true))).toEqual({
        status: RecallStatus.carried,
        agrees: 3,
        refusals: 1,
        needed: 3,
      });
      expect((await w.recallRow(recall.id))?.status).toBe(RecallStatus.carried);
      expect(await w.roleOf(id, moderator)).toBe(RealmRole.member);
      expect(await w.endorsementsOf(id, moderator)).toEqual([]);
      // Membership changed, so OpenFGA hears about it, and the change is on the record.
      expect(await w.memberChanges(id)).toEqual([
        { realmId: id, userId: moderator, role: RealmRole.member },
      ]);
      expect(await w.audits(moderator)).toEqual([
        expect.objectContaining({
          userId: voters[2],
          entityId: moderator,
          changes: expect.objectContaining({ by: "recall.members", reason: REASON, agrees: 3 }),
        }),
      ]);
    }));

  test("carrying it refills the seat, and every role change is announced in the same vote", () =>
    inWorld(async (w) => {
      const { id, recall, moderator, voters } = await openRecall(w);
      const [, , waiting] = voters as [string, string, string];
      // Waiting has the upvotes for a seat but the realm has only one, and it was taken.
      await w.upvotes(id, waiting, [voters[0]!, voters[1]!, moderator]);

      await w.recalls.voteOnRecall(id, recall.id, voters[0]!, true);
      expect(expectOk(await w.recalls.voteOnRecall(id, recall.id, voters[1]!, true)).status).toBe(
        RecallStatus.carried,
      );
      expect(await w.roleOf(id, waiting)).toBe(RealmRole.moderator);
      expect(await w.memberChanges(id)).toEqual([
        { realmId: id, userId: moderator, role: RealmRole.member },
        { realmId: id, userId: waiting, role: RealmRole.moderator },
      ]);
    }));

  test("short of a majority it stays open and nothing changes", () =>
    inWorld(async (w) => {
      const { id, recall, moderator, voters } = await openRecall(w);
      await w.recalls.voteOnRecall(id, recall.id, voters[0]!, true);
      await w.recalls.voteOnRecall(id, recall.id, voters[1]!, false);
      expect(expectOk(await w.recalls.voteOnRecall(id, recall.id, voters[2]!, false))).toEqual({
        status: RecallStatus.open,
        agrees: 2,
        refusals: 2,
        needed: 3,
      });
      expect(await w.roleOf(id, moderator)).toBe(RealmRole.moderator);
      expect(await w.memberChanges(id)).toEqual([]);
      expect(await w.audits(moderator)).toEqual([]);
    }));

  test("once refusals leave too few voters to carry it, it is refused and nobody is unseated", () =>
    inWorld(async (w) => {
      const { id, recall, moderator, voters } = await openRecall(w);
      for (const voter of voters.slice(0, 2)) {
        await w.recalls.voteOnRecall(id, recall.id, voter, false);
      }
      expect(expectOk(await w.recalls.voteOnRecall(id, recall.id, moderator, false))).toEqual({
        status: RecallStatus.refused,
        agrees: 1,
        refusals: 3,
        needed: 3,
      });
      expect((await w.recallRow(recall.id))?.status).toBe(RecallStatus.refused);
      expect(await w.roleOf(id, moderator)).toBe(RealmRole.moderator);
      expect(await w.memberChanges(id)).toEqual([]);
    }));

  test("a voter changing their mind replaces their vote", () =>
    inWorld(async (w) => {
      const { id, recall, voters } = await openRecall(w);
      await w.recalls.voteOnRecall(id, recall.id, voters[0]!, true);
      expect(
        expectOk(await w.recalls.voteOnRecall(id, recall.id, voters[0]!, false)),
      ).toMatchObject({ agrees: 1, refusals: 1 });
    }));

  test("a recall from another realm is not found and changes nothing; a settled one is refused", () =>
    inWorld(async (w) => {
      const home = await openRecall(w);
      const elsewhere = await w.realm(1);
      // Scoped to the realm in the URL, so a member of one realm can't vote in another.
      expectErr(
        await w.recalls.voteOnRecall(elsewhere.id, home.recall.id, elsewhere.admin, true),
        ErrorCode.realm.notFound,
      );
      expect((await w.recalls.openRecalls(home.id, 50))[0]).toMatchObject({ agrees: 1 });
      expectErr(
        await w.recalls.voteOnRecall(home.id, Bun.randomUUIDv7(), home.admin, true),
        ErrorCode.realm.notFound,
      );

      for (const voter of home.voters.slice(0, 2)) {
        await w.recalls.voteOnRecall(home.id, home.recall.id, voter, true);
      }
      expectErr(
        await w.recalls.voteOnRecall(home.id, home.recall.id, home.voters[2]!, true),
        ErrorCode.realm.alreadyMember,
      );
    }));

  test("a carried recall unseats the moderator (three members: two carry it)", () =>
    inWorld(async (w) => {
      const { id, admin, people } = await w.realm(2);
      const [moderator, member] = people as [string, string];
      await w.setRole(id, moderator, RealmRole.moderator);
      const recall = expectOk(
        await w.recalls.proposeRecall(id, moderator, RecallKind.members, REASON, member),
      );
      expect(expectOk(await w.recalls.voteOnRecall(id, recall.id, admin, true)).status).toBe(
        RecallStatus.carried,
      );
      expect(await w.roleOf(id, moderator)).toBe(RealmRole.member);
    }));
});
