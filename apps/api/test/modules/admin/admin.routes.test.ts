import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import { createDb, realmMembers } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import { AuditAction, RealmRole } from "@akashic/lib/enums";
import { ErrorCode } from "@akashic/lib/errors";
import { silentLogger } from "@akashic/lib/log";
import { databaseUrl } from "../../support/fixtures.ts";
import { adminApp } from "./app.ts";
import { Web, world, type World } from "./fixtures.ts";

// Every admin route through app.request, on the real database in a rolled-back transaction: the
// happy path parses with the web app's schema, and the surface refuses everyone else with 404.

const database = createDb({
  url: databaseUrl,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const scenario = (run: (s: ReturnType<typeof adminApp> & { w: World }) => Promise<void>) =>
  withRollback(database.db, (tx) => run({ ...adminApp(tx), w: world(tx) }));

const NOT_FOUND = ErrorCode.common.routeNotFound;
const A = "/api/v1/admin";

describe.skipIf(!live)("the overview, realms, audit and reports", () => {
  test("each answers the web app's shape to a platform admin", () =>
    scenario(async ({ call, grants, w }) => {
      const boss = await w.person("Boss");
      grants.platform.add(boss);
      const { slug, id } = await w.realm(1, 1);
      const reporter = await w.person();
      const accused = await w.person();
      const report = await w.report(reporter, accused);

      const overview = await call("GET", A, { as: boss });
      expect(overview.status).toBe(200);
      expect(v.parse(Web.Overview, overview.body).realms).toBeGreaterThanOrEqual(2);

      const realms = await call("GET", `${A}/realms?limit=200`, { as: boss });
      expect(realms.status).toBe(200);
      const listed = v.parse(v.array(Web.PlatformRealm), realms.body);
      expect(listed.find((r) => r.slug === slug)).toMatchObject({ id, memberCount: 2 });

      const reports = await call("GET", `${A}/reports?state=open&limit=200`, { as: boss });
      expect(reports.status).toBe(200);
      const open = v.parse(v.array(Web.Report), reports.body);
      expect(open.find((r) => r.id === report)).toMatchObject({
        senderMatches: true,
        reviewedAt: null,
      });

      const reviewed = await call("POST", `${A}/reports/${report}/review`, { as: boss });
      expect(reviewed).toEqual({ status: 200, body: { id: report } });
      const again = await call("POST", `${A}/reports/${report}/review`, { as: boss });
      expect(again.status).toBe(404);

      const audit = await call("GET", `${A}/audit?entityType=room_report&limit=200`, { as: boss });
      expect(audit.status).toBe(200);
      const entries = v.parse(v.array(Web.AuditEntry), audit.body);
      expect(entries.find((e) => e.entityId === report)).toMatchObject({
        action: AuditAction.moderated,
        actor: { id: boss },
      });
    }));

  test("the report state defaults to open and rejects anything else", () =>
    scenario(async ({ call, grants, w }) => {
      const boss = await w.person();
      grants.platform.add(boss);
      expect((await call("GET", `${A}/reports`, { as: boss })).status).toBe(200);
      const bad = await call("GET", `${A}/reports?state=nope`, { as: boss });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe(ErrorCode.common.validation);
    }));
});

describe.skipIf(!live)("accounts and bans", () => {
  test("searches accounts, suspends one with a reason and lifts it", () =>
    scenario(async ({ call, grants, w }) => {
      const boss = await w.person("Boss");
      grants.platform.add(boss);
      const target = await w.account("Searchable Zyxwv");

      const found = await call(
        "GET",
        `${A}/accounts?limit=200&q=${encodeURIComponent(target.email)}`,
        {
          as: boss,
        },
      );
      expect(found.status).toBe(200);
      expect(v.parse(v.array(Web.PlatformAccount), found.body)).toMatchObject([
        { id: target.id, bannedAt: null, realmCount: 0 },
      ]);

      const banned = await call("POST", `${A}/accounts/${target.id}/ban`, {
        as: boss,
        body: { banned: true, reason: "Spam.", until: "2026-06-02T00:00:00Z" },
      });
      expect(banned).toEqual({ status: 200, body: { banned: true } });
      const after = await call("GET", `${A}/accounts?q=${encodeURIComponent(target.email)}`, {
        as: boss,
      });
      expect(v.parse(v.array(Web.PlatformAccount), after.body)[0]).toMatchObject({
        banReason: "Spam.",
        bannedUntil: "2026-06-02T00:00:00Z",
      });

      const lifted = await call("POST", `${A}/accounts/${target.id}/ban`, {
        as: boss,
        body: { banned: false },
      });
      expect(lifted).toEqual({ status: 200, body: { banned: false } });
    }));

  test("refuses a self-ban, a missing reason and an unknown account", () =>
    scenario(async ({ call, grants, w }) => {
      const boss = await w.person();
      const target = await w.account();
      grants.platform.add(boss);
      const self = await call("POST", `${A}/accounts/${boss}/ban`, {
        as: boss,
        body: { banned: true, reason: "Oops." },
      });
      expect(self.body.code).toBe(ErrorCode.common.validation);
      const noReason = await call("POST", `${A}/accounts/${target.id}/ban`, {
        as: boss,
        body: { banned: true },
      });
      expect(noReason.body.code).toBe(ErrorCode.common.validation);
      const ghost = await call("POST", `${A}/accounts/${Bun.randomUUIDv7()}/ban`, {
        as: boss,
        body: { banned: true, reason: "Spam." },
      });
      expect(ghost.status).toBe(404);
      const short = await call("POST", `${A}/accounts/${target.id}/ban`, {
        as: boss,
        body: { banned: true, reason: "no" },
      });
      expect(short.status).toBe(400);
    }));
});

describe.skipIf(!live)("granting realm admin", () => {
  test("201 with the member's name, and the member is admin", () =>
    scenario(async ({ call, grants, w }) => {
      const boss = await w.person("Boss");
      grants.platform.add(boss);
      const { slug, id } = await w.realm(0, 0);
      const target = await w.account("Heir");

      const granted = await call("POST", `${A}/realms/${slug}/admins`, {
        as: boss,
        body: { email: target.email },
      });
      expect(granted).toEqual({
        status: 201,
        body: { realmId: id, userId: target.id, name: "Heir" },
      });
      const [row] = await w.tx
        .select()
        .from(realmMembers)
        .where(eq(realmMembers.userId, target.id));
      expect(row).toMatchObject({ realmId: id, role: RealmRole.admin });
    }));

  test("an unknown realm or account is 404 with its own code; a bad email is 400", () =>
    scenario(async ({ call, grants, w }) => {
      const boss = await w.person();
      grants.platform.add(boss);
      const { slug } = await w.realm();
      const noRealm = await call("POST", `${A}/realms/nowhere-xyz/admins`, {
        as: boss,
        body: { email: "a@example.test" },
      });
      expect(noRealm.status).toBe(404);
      expect(noRealm.body.code).toBe("realm.not_found");
      const noAccount = await call("POST", `${A}/realms/${slug}/admins`, {
        as: boss,
        body: { email: "nobody@example.test" },
      });
      expect(noAccount.status).toBe(404);
      expect(noAccount.body.code).toBe(NOT_FOUND);
      const bad = await call("POST", `${A}/realms/${slug}/admins`, {
        as: boss,
        body: { email: "not-an-email" },
      });
      expect(bad.status).toBe(400);
    }));
});

describe.skipIf(!live)("refusals", () => {
  const someId = Bun.randomUUIDv7();
  const routes = [
    ["GET", A, undefined],
    ["GET", `${A}/realms`, undefined],
    ["GET", `${A}/audit`, undefined],
    ["GET", `${A}/reports`, undefined],
    ["GET", `${A}/accounts`, undefined],
    ["POST", `${A}/reports/${someId}/review`, undefined],
    ["POST", `${A}/accounts/${someId}/ban`, { banned: false }],
    ["POST", `${A}/realms/some-realm/admins`, { email: "a@example.test" }],
  ] as const;

  test("everyone but a platform admin gets 404, as if the routes weren't there", () =>
    scenario(async ({ call, w }) => {
      const someone = await w.person();
      for (const [method, path, body] of routes) {
        const refused = await call(method, path, { as: someone, body });
        expect(refused.status).toBe(404);
        expect(refused.body.code).toBe(NOT_FOUND);
      }
    }));

  test("without a session, 401", () =>
    scenario(async ({ call }) => {
      for (const [method, path, body] of routes) {
        expect((await call(method, path, { body })).status).toBe(401);
      }
    }));

  test("validation runs before the platform check, as it always did", () =>
    scenario(async ({ call, w }) => {
      const someone = await w.person();
      const bad = await call("POST", `${A}/realms/some-realm/admins`, {
        as: someone,
        body: { email: "nope" },
      });
      expect(bad.status).toBe(400);
      expect((await call("GET", `${A}/realms?limit=0`, { as: someone })).status).toBe(400);
      expect((await call("POST", `${A}/reports/not-a-uuid/review`, { as: someone })).status).toBe(
        400,
      );
    }));
});
