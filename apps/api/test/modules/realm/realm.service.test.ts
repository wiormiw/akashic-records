import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditEntries,
  createDb,
  realmModules,
  realmProposals,
  realms as realmTable,
  type Tx,
} from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import { AuditAction, ProposalStatus, RealmModule, RealmRole } from "@akashic/lib/enums";
import { ErrorCode } from "@akashic/lib/errors";
import { silentLogger } from "@akashic/lib/log";
import { expectErr, expectOk } from "@akashic/lib/testing";
import type { Embedder } from "@/integrations/embedder.ts";
import { databaseUrl, uniqueSlug, world } from "./fixtures.ts";

// The realm service on the real database, each test in a transaction that is rolled back.
// Skips when nothing answers at DATABASE_URL.

const database = createDb({
  url: databaseUrl,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const inWorld = (
  run: (w: ReturnType<typeof world>, tx: Tx) => Promise<void>,
  embedder?: Embedder,
) => withRollback(database.db, (tx) => run(world(tx, embedder), tx));

/** A pending proposal by a fresh account. */
async function proposed(w: ReturnType<typeof world>, slug = uniqueSlug("p")) {
  const proposer = await w.person("Proposer");
  const { id } = expectOk(
    await w.realms.propose({
      slug,
      name: "Printmakers",
      description: "Relief, intaglio and the rest.",
      modules: [RealmModule.market],
      rationale: "There is nowhere else for these people to meet and trade.",
      proposedBy: proposer,
    }),
  );
  return { id, proposer, slug };
}

const auditsOf = (tx: Tx, entityId: string) =>
  tx.select().from(auditEntries).where(eq(auditEntries.entityId, entityId));

describe.skipIf(!live)("realms", () => {
  test("founding makes the founder admin and announces both facts", () =>
    inWorld(async (w) => {
      const { id, slug, admin } = await w.realm([RealmModule.events, RealmModule.jobs]);
      expect(await w.roleOf(id, admin)).toBe(RealmRole.admin);
      expect((await w.outbox("realm.member_changed", id)).map((row) => row.payload)).toEqual([
        { realmId: id, userId: admin, role: RealmRole.admin },
      ]);
      expect(await w.outbox("realm.created", id)).toHaveLength(1);
      expect(expectOk(await w.realms.read(slug))).toMatchObject({
        id,
        memberCount: 1,
        modules: [RealmModule.jobs, RealmModule.events],
      });
    }));

  test("a taken slug is a conflict, and writes nothing", () =>
    inWorld(async (w) => {
      const founder = await w.person();
      const slug = uniqueSlug();
      expectOk(await w.realms.found(founder, { slug, name: "One", modules: [] }));
      expectErr(
        await w.realms.found(founder, { slug, name: "Two", modules: [] }),
        ErrorCode.realm.duplicateSlug,
      );
    }));

  test("unknown and repeated modules are dropped", () =>
    inWorld(async (w, tx) => {
      const founder = await w.person();
      const { id } = expectOk(
        await w.realms.found(founder, {
          slug: uniqueSlug(),
          name: "Modules",
          modules: [RealmModule.market, 99, RealmModule.market],
        }),
      );
      const rows = await tx.select().from(realmModules).where(eq(realmModules.realmId, id));
      expect(rows.map((row) => row.module)).toEqual([RealmModule.market]);
    }));

  test("founding seeds the centroid when a model answers", () =>
    inWorld(
      async (w, tx) => {
        const { id } = await w.realm();
        const [row] = await tx
          .select({ samples: realmTable.centroidSamples })
          .from(realmTable)
          .where(eq(realmTable.id, id));
        expect(row?.samples).toBe(1);
      },
      { available: true, embed: async () => Array.from({ length: 1536 }, () => 0.5) },
    ));

  test("an archived realm is not read, and not listed", () =>
    inWorld(async (w) => {
      const { id, slug, admin } = await w.realm();
      expect(expectOk(await w.realms.archive(id, admin, true))).toEqual({ archived: true });
      expectErr(await w.realms.read(slug), ErrorCode.realm.notFound);
      expect((await w.realms.browse()).some((realm) => realm.id === id)).toBe(false);
      expectOk(await w.realms.archive(id, admin, false));
      expect(expectOk(await w.realms.read(slug)).id).toBe(id);
    }));

  test("joining twice is a conflict, and announces once", () =>
    inWorld(async (w) => {
      const { id } = await w.realm();
      const member = await w.person();
      expect(expectOk(await w.realms.join(id, member))).toEqual({ joined: true });
      expectErr(await w.realms.join(id, member), ErrorCode.realm.alreadyMember);
      const changes = (await w.outbox("realm.member_changed", id)).filter(
        (row) => (row.payload as { userId: string }).userId === member,
      );
      expect(changes).toHaveLength(1);
    }));

  test("leaving announces the departure; a stranger can't leave", () =>
    inWorld(async (w) => {
      const { id, people } = await w.realm([], 1);
      const [member] = people as [string];
      expect(expectOk(await w.realms.leave(id, member, RealmRole.member))).toEqual({ left: true });
      expect(await w.roleOf(id, member)).toBeNull();
      expect((await w.outbox("realm.member_changed", id)).map((row) => row.payload)).toContainEqual(
        { realmId: id, userId: member, role: null },
      );
      expectErr(await w.realms.leave(id, member, null), ErrorCode.realm.notMember);
    }));

  test("the only admin can't leave; one of two can", () =>
    inWorld(async (w) => {
      const { id, admin, people } = await w.realm([], 1);
      expectErr(await w.realms.leave(id, admin, RealmRole.admin), ErrorCode.realm.soleAdmin);
      const [other] = people as [string];
      expectOk(
        await w.realms.changeRole(id, { id: admin, role: RealmRole.admin }, other, RealmRole.admin),
      );
      expectOk(await w.realms.leave(id, admin, RealmRole.admin));
    }));

  test("the roster lists staff first, with their names", () =>
    inWorld(async (w) => {
      const { id, admin, people } = await w.realm([], 2);
      const roster = await w.realms.roster(id);
      expect(roster.map((m) => m.userId)).toEqual([admin, ...people]);
      expect(roster[0]).toMatchObject({
        role: RealmRole.admin,
        name: "Founder",
        displayName: null,
      });
    }));

  test("an edit changes what was given, and records it", () =>
    inWorld(async (w, tx) => {
      const { id, slug, admin } = await w.realm([RealmModule.jobs]);
      expect(expectOk(await w.realms.edit(id, admin, {}))).toEqual({ changed: [] });
      expect(
        expectOk(
          await w.realms.edit(id, admin, {
            name: "Renamed",
            category: null,
            modules: [RealmModule.events],
          }),
        ),
      ).toEqual({ changed: ["name", "category", "modules"] });
      expect(expectOk(await w.realms.read(slug))).toMatchObject({
        name: "Renamed",
        category: null,
        modules: [RealmModule.events],
      });
      expect(await auditsOf(tx, id)).toEqual([
        expect.objectContaining({
          userId: admin,
          action: AuditAction.updated,
          changes: { name: "Renamed", category: null, modules: [RealmModule.events] },
        }),
      ]);
    }));

  test("archiving is recorded as a deletion, restoring as an update", () =>
    inWorld(async (w, tx) => {
      const { id, admin } = await w.realm();
      expectOk(await w.realms.archive(id, admin, true));
      expectOk(await w.realms.archive(id, admin, false));
      expect((await auditsOf(tx, id)).map((row) => row.action).sort()).toEqual(
        [AuditAction.updated, AuditAction.deleted].sort(),
      );
    }));
});

describe.skipIf(!live)("roles", () => {
  test("staff roles need an admin, anyone staff can vouch, and nobody changes their own", () =>
    inWorld(async (w, tx) => {
      const { id, admin, people } = await w.realm([], 2);
      const [mod, member] = people as [string, string];
      const asAdmin = { id: admin, role: RealmRole.admin };

      expectOk(await w.realms.changeRole(id, asAdmin, mod, RealmRole.moderator));
      expect(await w.roleOf(id, mod)).toBe(RealmRole.moderator);
      expect(await auditsOf(tx, mod)).toEqual([
        expect.objectContaining({
          userId: admin,
          entityType: "realm_member",
          action: AuditAction.roleChanged,
          changes: { realmId: id, role: RealmRole.moderator },
        }),
      ]);

      const asMod = { id: mod, role: RealmRole.moderator };
      expectErr(
        await w.realms.changeRole(id, asMod, member, RealmRole.moderator),
        ErrorCode.realm.forbidden,
      );
      expectOk(await w.realms.changeRole(id, asMod, member, RealmRole.verified));
      expect(await w.roleOf(id, member)).toBe(RealmRole.verified);
      expect((await w.outbox("realm.member_changed", id)).map((row) => row.payload)).toContainEqual(
        { realmId: id, userId: member, role: RealmRole.verified },
      );

      expectErr(
        await w.realms.changeRole(id, asAdmin, admin, RealmRole.member),
        ErrorCode.realm.forbidden,
      );
      expectErr(
        await w.realms.changeRole(id, asAdmin, Bun.randomUUIDv7(), RealmRole.verified),
        ErrorCode.realm.notMember,
      );
    }));
});

describe.skipIf(!live)("proposals", () => {
  test("one pending proposal at a time, and never for a taken slug", () =>
    inWorld(async (w) => {
      const { proposer, slug } = await proposed(w);
      expectErr(
        await w.realms.propose({
          slug: `${slug}-2`,
          name: "Again",
          modules: [],
          rationale: "x",
          proposedBy: proposer,
        }),
        ErrorCode.realm.duplicateSlug,
      );
      const { slug: taken } = await w.realm();
      expectErr(
        await w.realms.propose({
          slug: taken,
          name: "Taken",
          modules: [],
          rationale: "x",
          proposedBy: await w.person(),
        }),
        ErrorCode.realm.duplicateSlug,
      );
    }));

  test("a proposer sees their own, newest first; reviewers see what is pending", () =>
    inWorld(async (w) => {
      const { id, proposer } = await proposed(w);
      const [mine] = await w.realms.myProposals(proposer);
      expect(mine).toMatchObject({
        id,
        status: ProposalStatus.pending,
        modules: [RealmModule.market],
        proposedBy: { id: proposer, name: "Proposer" },
        decidedAt: null,
      });
      expect((await w.realms.pendingProposals()).some((p) => p.id === id)).toBe(true);
    }));

  test("approval founds the realm with its proposer as admin, announces it, and records the decision", () =>
    inWorld(async (w, tx) => {
      const { id, proposer, slug } = await proposed(w);
      const reviewer = await w.person("Reviewer");

      const { realmId } = expectOk(await w.realms.approve(id, reviewer));
      expect(await w.roleOf(realmId, proposer)).toBe(RealmRole.admin);
      expect((await w.outbox("realm.created", realmId)).length).toBe(1);
      expect((await w.outbox("realm.member_changed", realmId)).map((row) => row.payload)).toEqual([
        { realmId, userId: proposer, role: RealmRole.admin },
      ]);
      const [decided] = await tx.select().from(realmProposals).where(eq(realmProposals.id, id));
      expect(decided).toMatchObject({
        status: ProposalStatus.approved,
        decidedBy: reviewer,
        realmId,
      });
      expect(await auditsOf(tx, id)).toEqual([
        expect.objectContaining({
          userId: reviewer,
          action: AuditAction.updated,
          changes: { approved: true, slug, realmId },
        }),
      ]);
      expect(expectOk(await w.realms.read(slug)).modules).toEqual([RealmModule.market]);

      // Decided once.
      expectErr(await w.realms.approve(id, reviewer), ErrorCode.realm.duplicateSlug);
      expectErr(await w.realms.reject(id, reviewer, "too late"), ErrorCode.realm.notFound);
    }));

  test("approval is one transaction: a failure deciding it leaves no realm behind", () =>
    inWorld(async (w, tx) => {
      const { id, slug } = await proposed(w);
      // No such account, so recording the decision breaks a foreign key after the realm is written.
      await expect(w.realms.approve(id, Bun.randomUUIDv7())).rejects.toThrow();
      expect(await tx.select().from(realmTable).where(eq(realmTable.slug, slug))).toEqual([]);
      const [proposal] = await tx.select().from(realmProposals).where(eq(realmProposals.id, id));
      expect(proposal?.status).toBe(ProposalStatus.pending);
    }));

  test("a proposal that doesn't exist is not found", () =>
    inWorld(async (w) => {
      expectErr(
        await w.realms.approve(Bun.randomUUIDv7(), await w.person()),
        ErrorCode.realm.notFound,
      );
    }));

  test("a slug taken since the proposal was made founds nothing and decides nothing", () =>
    inWorld(async (w, tx) => {
      const { id, slug } = await proposed(w);
      const squatter = await w.person();
      expectOk(await w.realms.found(squatter, { slug, name: "Squatter", modules: [] }));

      expectErr(await w.realms.approve(id, await w.person()), ErrorCode.realm.duplicateSlug);
      const [proposal] = await tx.select().from(realmProposals).where(eq(realmProposals.id, id));
      expect(proposal).toMatchObject({ status: ProposalStatus.pending, realmId: null });
      expect(await auditsOf(tx, id)).toEqual([]);
    }));

  test("rejection records the note, and only once", () =>
    inWorld(async (w, tx) => {
      const { id, proposer } = await proposed(w);
      const reviewer = await w.person("Reviewer");
      expect(expectOk(await w.realms.reject(id, reviewer, "Too close to another"))).toEqual({ id });
      const [mine] = await w.realms.myProposals(proposer);
      expect(mine).toMatchObject({
        status: ProposalStatus.rejected,
        decisionNote: "Too close to another",
        realmId: null,
      });
      expect(mine?.decidedAt).not.toBeNull();
      expect(
        await tx
          .select()
          .from(auditEntries)
          .where(and(eq(auditEntries.entityId, id), eq(auditEntries.userId, reviewer))),
      ).toHaveLength(1);
      expectErr(await w.realms.reject(id, reviewer, "again"), ErrorCode.realm.notFound);
      expectErr(await w.realms.approve(id, reviewer), ErrorCode.realm.duplicateSlug);
    }));
});
