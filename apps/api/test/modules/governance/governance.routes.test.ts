import { afterAll, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { Relation } from "@akashic/authz";
import { createDb } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import {
  RealmModule,
  RealmRole,
  RecallKind,
  RecallStatus,
  TakedownStatus,
} from "@akashic/lib/enums";
import { silentLogger } from "@akashic/lib/log";
import { expectOk } from "@akashic/lib/testing";
import { databaseUrl } from "../../support/fixtures.ts";
import { governanceApp } from "./app.ts";
import { Web, world, type World } from "./fixtures.ts";

// Every governance route through app.request, on the real database in a rolled-back transaction:
// the happy path parses with the web app's schema where it has one, and each group has its
// refusals.

const database = createDb({
  url: databaseUrl,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const scenario = (run: (s: ReturnType<typeof governanceApp> & { w: World }) => Promise<void>) =>
  withRollback(database.db, (tx) => run({ ...governanceApp(tx), w: world(tx) }));

const { participate, moderate, administer } = Relation.realm;
const REASON = "Not doing the job.";

describe.skipIf(!live)("standings and upvotes", () => {
  test("members upvote and withdraw, and read the standings as the web app does", () =>
    scenario(async ({ call, grant, w }) => {
      const { slug, people } = await w.realm(4);
      const [candidate, ...voters] = people as [string, ...string[]];
      for (const voter of voters) grant(voter, participate);
      const path = `/api/v1/realms/${slug}/members/${candidate}/upvote`;

      for (const voter of voters.slice(0, 2)) {
        expect((await call("POST", path, { as: voter })).status).toBe(200);
      }
      const third = await call("POST", path, { as: voters[2]! });
      expect(third).toEqual({
        status: 200,
        body: { upvotes: 3, seats: 1, seated: [candidate], unseated: [] },
      });

      const standings = await call("GET", `/api/v1/realms/${slug}/standings`, { as: voters[0]! });
      expect(standings.status).toBe(200);
      expect(v.parse(Web.Standings, standings.body)).toMatchObject({
        seats: 1,
        minimum: 3,
        members: expect.arrayContaining([
          expect.objectContaining({ userId: candidate, upvotes: 3, seated: true }),
        ]),
      });

      const withdrawn = await call("DELETE", path, { as: voters[0]! });
      expect(withdrawn).toEqual({
        status: 200,
        body: { upvotes: 2, seated: [], unseated: [candidate] },
      });
    }));

  test("signed out 401, no election module 404, no permission 403, a bad id 400", () =>
    scenario(async ({ call, grant, w }) => {
      const { slug, people } = await w.realm(2);
      const off = await w.realm(1, [RealmModule.events]);
      const [candidate, voter] = people as [string, string];
      const path = `/api/v1/realms/${slug}/members/${candidate}/upvote`;

      expect((await call("POST", path)).status).toBe(401);
      expect((await call("GET", `/api/v1/realms/${slug}/standings`)).status).toBe(401);
      const forbidden = await call("POST", path, { as: voter });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe("realm.forbidden");

      grant(off.people[0]!, participate);
      const disabled = await call("GET", `/api/v1/realms/${off.slug}/standings`, {
        as: off.people[0]!,
      });
      expect(disabled.status).toBe(404);
      expect(disabled.body.code).toBe("realm.module_disabled");

      grant(voter, participate);
      const malformed = await call("POST", `/api/v1/realms/${slug}/members/nobody/upvote`, {
        as: voter,
      });
      expect(malformed.status).toBe(400);
      const self = await call("POST", `/api/v1/realms/${slug}/members/${voter}/upvote`, {
        as: voter,
      });
      expect(self.status).toBe(400);
      expect(self.body.code).toBe("common.request.validation_failed");
    }));
});

describe.skipIf(!live)("removing a seat", () => {
  test("an administrator takes a seat away; anyone else is 403, a short reason 400", () =>
    scenario(async ({ call, grant, w }) => {
      const { slug, id, admin, people } = await w.realm(1);
      const [moderator] = people as [string];
      await w.setRole(id, moderator, RealmRole.moderator);
      const path = `/api/v1/realms/${slug}/members/${moderator}/seat`;

      grant(moderator, participate, moderate);
      const forbidden = await call("DELETE", path, { as: moderator, body: { reason: REASON } });
      expect(forbidden.status).toBe(403);

      grant(admin, administer);
      expect((await call("DELETE", path, { as: admin, body: { reason: "short" } })).status).toBe(
        400,
      );
      expect(await call("DELETE", path, { as: admin, body: { reason: `  ${REASON}  ` } })).toEqual({
        status: 200,
        body: { removed: true },
      });
      expect(await w.roleOf(id, moderator)).toBe(RealmRole.member);
      expect((await w.audits(moderator))[0]?.changes).toMatchObject({ reason: REASON });
    }));
});

describe.skipIf(!live)("recalls", () => {
  test("a member proposes (201), everyone reads it as the web app does, and votes carry it", () =>
    scenario(async ({ call, grant, w }) => {
      const { slug, id, admin, people } = await w.realm(2);
      const [moderator, member] = people as [string, string];
      await w.setRole(id, moderator, RealmRole.moderator);
      grant(member, participate);
      grant(admin, participate);

      const proposed = await call("POST", `/api/v1/realms/${slug}/recalls`, {
        as: member,
        body: { userId: moderator, kind: RecallKind.members, reason: REASON },
      });
      expect(proposed.status).toBe(201);
      expect(proposed.body).toEqual({ id: expect.any(String), electorate: 3, needed: 2 });

      const listed = await call("GET", `/api/v1/realms/${slug}/recalls`, { as: admin });
      expect(listed.status).toBe(200);
      expect(v.parse(v.array(Web.Recall), listed.body)).toEqual([
        expect.objectContaining({ id: proposed.body.id, realmId: id, agrees: 1 }),
      ]);

      const vote = await call("POST", `/api/v1/realms/${slug}/recalls/${proposed.body.id}/vote`, {
        as: admin,
        body: { agree: true },
      });
      expect(vote).toEqual({
        status: 200,
        body: { status: RecallStatus.carried, agrees: 2, refusals: 0, needed: 2 },
      });
      expect(await w.memberChanges(id)).toEqual([
        { realmId: id, userId: moderator, role: RealmRole.member },
      ]);
    }));

  test("voting through another realm's URL is 404 and counts nothing; a bad kind is 400", () =>
    scenario(async ({ call, grant, w }) => {
      const home = await w.realm(2);
      const elsewhere = await w.realm(0);
      const [moderator, member] = home.people as [string, string];
      await w.setRole(home.id, moderator, RealmRole.moderator);
      const { id: recallId } = expectOk(
        await w.recalls.proposeRecall(home.id, moderator, RecallKind.members, REASON, member),
      );
      grant(elsewhere.admin, participate);

      const foreign = await call(
        "POST",
        `/api/v1/realms/${elsewhere.slug}/recalls/${recallId}/vote`,
        { as: elsewhere.admin, body: { agree: true } },
      );
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe("realm.not_found");
      expect((await w.recalls.openRecalls(home.id, 1))[0]).toMatchObject({ agrees: 1 });

      grant(member, participate);
      const badKind = await call("POST", `/api/v1/realms/${home.slug}/recalls`, {
        as: member,
        body: { userId: moderator, kind: 7, reason: REASON },
      });
      expect(badKind.status).toBe(400);
      expect((await call("GET", `/api/v1/realms/${home.slug}/recalls`)).status).toBe(401);
    }));
});

describe.skipIf(!live)("takedowns", () => {
  test("a moderator proposes (201), moderators read it as the web app does, and vote", () =>
    scenario(async ({ call, grant, w }) => {
      const { slug, id, admin, people } = await w.realm(3, []);
      const [author, ...moderators] = people as [string, ...string[]];
      for (const moderator of moderators) {
        await w.setRole(id, moderator, RealmRole.moderator);
        grant(moderator, moderate);
      }
      grant(admin, moderate);
      const commentId = await w.comment(id, author);

      const proposed = await call("POST", `/api/v1/realms/${slug}/takedowns`, {
        as: admin,
        body: { commentId, reason: "Breaks the rules." },
      });
      expect(proposed.status).toBe(201);
      expect(proposed.body).toEqual({
        id: expect.any(String),
        carried: false,
        agrees: 1,
        needed: 2,
      });

      const listed = await call("GET", `/api/v1/realms/${slug}/takedowns`, {
        as: moderators[0]!,
      });
      expect(listed.status).toBe(200);
      expect(v.parse(v.array(Web.Takedown), listed.body)).toEqual([
        expect.objectContaining({ id: proposed.body.id, realmId: id, needed: 2, agrees: 1 }),
      ]);

      const vote = await call("POST", `/api/v1/realms/${slug}/takedowns/${proposed.body.id}/vote`, {
        as: moderators[0]!,
        body: { agree: true },
      });
      expect(vote).toEqual({
        status: 200,
        body: { status: TakedownStatus.carried, agrees: 2, refusals: 0, needed: 2 },
      });
      expect((await w.commentRow(commentId))?.removedAt).not.toBeNull();
    }));

  test("another realm's comment is 404 and changes nothing; a non-moderator is 403", () =>
    scenario(async ({ call, grant, w }) => {
      const home = await w.realm(1, []);
      const elsewhere = await w.realm(1, []);
      const commentId = await w.comment(elsewhere.id, elsewhere.people[0]!);
      const body = { commentId, reason: "Breaks the rules." };

      const forbidden = await call("POST", `/api/v1/realms/${home.slug}/takedowns`, {
        as: home.people[0]!,
        body,
      });
      expect(forbidden.status).toBe(403);

      grant(home.admin, moderate);
      const foreign = await call("POST", `/api/v1/realms/${home.slug}/takedowns`, {
        as: home.admin,
        body,
      });
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe("realm.not_found");
      expect(await w.takedownRows(home.id)).toEqual([]);
      expect(await w.takedownRows(elsewhere.id)).toEqual([]);
      expect((await w.commentRow(commentId))?.removedAt).toBeNull();
    }));
});
