import { afterAll, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { createDb } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import { ProposalStatus, RealmModule, RealmRole } from "@akashic/lib/enums";
import { silentLogger } from "@akashic/lib/log";
import { realmApp } from "./app.ts";
import { databaseUrl, uniqueSlug, Web, world } from "./fixtures.ts";

// Every realm route through app.request, on the real database in a rolled-back transaction: the
// happy path parses with the web app's schema, and each group has its refusal.

const database = createDb({
  url: databaseUrl,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const scenario = (
  run: (s: ReturnType<typeof realmApp> & { w: ReturnType<typeof world> }) => Promise<void>,
) => withRollback(database.db, (tx) => run({ ...realmApp(tx), w: world(tx) }));

const rationale = "There is nowhere else for these people to meet and trade.";

describe.skipIf(!live)("public realm routes", () => {
  test("the directory and one realm parse as the web app reads them", () =>
    scenario(async ({ call, w }) => {
      const { id, slug } = await w.realm([RealmModule.events]);

      const list = await call("GET", "/api/public/v1/realms");
      expect(list.status).toBe(200);
      expect(v.is(v.array(Web.RealmSummary), list.body)).toBe(true);

      const one = await call("GET", `/api/public/v1/realms/${slug}`);
      expect(one.status).toBe(200);
      expect(v.parse(Web.RealmSummary, one.body)).toEqual({
        id,
        slug,
        name: "Test realm",
        description: null,
        category: null,
        memberCount: 1,
        modules: [RealmModule.events],
      });
    }));

  test("an unknown realm is 404, a malformed slug is a validation failure", () =>
    scenario(async ({ call }) => {
      const missing = await call("GET", `/api/public/v1/realms/${uniqueSlug("nobody")}`);
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("realm.not_found");
      const bad = await call("GET", "/api/public/v1/realms/Not_A_Slug");
      expect(bad.body.code).toBe("common.request.validation_failed");
    }));
});

describe.skipIf(!live)("proposal routes", () => {
  test("propose, then see it among mine", () =>
    scenario(async ({ call, w }) => {
      const proposer = await w.person("Proposer");
      const slug = uniqueSlug("p");
      const created = await call("POST", "/api/v1/proposals", {
        as: proposer,
        body: { slug, name: "  Printmakers  ", rationale, modules: [RealmModule.market] },
      });
      expect(created.status).toBe(201);
      expect(Object.keys(created.body)).toEqual(["id"]);

      const mine = await call("GET", "/api/v1/proposals/mine", { as: proposer });
      expect(mine.status).toBe(200);
      const [proposal] = v.parse(v.array(Web.Proposal), mine.body);
      expect(proposal).toMatchObject({
        id: created.body.id,
        slug,
        name: "Printmakers",
        description: null,
        status: ProposalStatus.pending,
        modules: [RealmModule.market],
      });
    }));

  test("without a session, 401; with a short rationale, a validation failure", () =>
    scenario(async ({ call, w }) => {
      const body = { slug: uniqueSlug("p"), name: "Printmakers", rationale };
      const anonymous = await call("POST", "/api/v1/proposals", { body });
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.code).toBe("auth.session.unauthenticated");

      const short = await call("POST", "/api/v1/proposals", {
        as: await w.person(),
        body: { ...body, rationale: `   ${"x".repeat(30)}          ` },
      });
      expect(short.body.code).toBe("common.request.validation_failed");
    }));
});

describe.skipIf(!live)("membership routes", () => {
  test("standing, join, roster, role, edit, archive and leave", () =>
    scenario(async ({ call, grants, w }) => {
      const { id, slug, admin } = await w.realm([RealmModule.jobs]);
      const newcomer = await w.person("Newcomer");
      grants.realm.set(admin, new Set(["can_participate", "can_vouch", "can_administer"]));
      grants.realm.set(newcomer, new Set(["can_participate"]));
      const base = `/api/v1/realms/${slug}`;

      const before = await call("GET", `${base}/me`, { as: newcomer });
      expect(before.status).toBe(200);
      expect(v.parse(Web.Standing, before.body)).toEqual({
        role: null,
        permissions: ["realm.participate"],
      });

      const joined = await call("POST", `${base}/join`, { as: newcomer });
      expect(joined.status).toBe(201);
      expect(joined.body).toEqual({ joined: true });
      const again = await call("POST", `${base}/join`, { as: newcomer });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("realm.already_member");

      const after = await call("GET", `${base}/me`, { as: newcomer });
      expect(after.body.role).toBe(RealmRole.member);

      const roster = await call("GET", `${base}/members`, { as: newcomer });
      expect(roster.status).toBe(200);
      expect(v.parse(v.array(Web.Member), roster.body).map((m) => m.userId)).toEqual([
        admin,
        newcomer,
      ]);

      const vouched = await call("PATCH", `${base}/members/${newcomer}`, {
        as: admin,
        body: { role: RealmRole.verified },
      });
      expect(vouched.status).toBe(200);
      expect(vouched.body).toEqual({ userId: newcomer, role: RealmRole.verified });

      const edited = await call("PATCH", base, {
        as: admin,
        body: { description: "  Prints  ", modules: [RealmModule.events] },
      });
      expect(edited.status).toBe(200);
      expect(edited.body).toEqual({ changed: ["description", "modules"] });
      const empty = await call("PATCH", base, { as: admin, body: {} });
      expect(empty.body.code).toBe("common.request.validation_failed");

      const retired = await call("DELETE", base, { as: admin });
      expect(retired.body).toEqual({ archived: true });
      const restored = await call("DELETE", `${base}?archived=false`, { as: admin });
      expect(restored.status).toBe(200);
      expect(restored.body).toEqual({ archived: false });

      const left = await call("POST", `${base}/leave`, { as: newcomer });
      expect(left.status).toBe(200);
      expect(left.body).toEqual({ left: true });
      const soleAdmin = await call("POST", `${base}/leave`, { as: admin });
      expect(soleAdmin.status).toBe(409);
      expect(soleAdmin.body.code).toBe("realm.sole_admin");

      expect(id).toBeString();
    }));

  test("without the permission, 403; without a session, 401; an unknown realm, 404", () =>
    scenario(async ({ call, w }) => {
      const { slug, people } = await w.realm([], 1);
      const [member] = people as [string];
      const base = `/api/v1/realms/${slug}`;

      for (const [method, path, body] of [
        ["GET", `${base}/members`, undefined],
        ["PATCH", `${base}/members/${member}`, { role: RealmRole.verified }],
        ["PATCH", base, { name: "Taken over" }],
        ["DELETE", base, undefined],
      ] as const) {
        const refused = await call(method, path, { as: member, body });
        expect(refused.status).toBe(403);
        expect(refused.body.code).toBe("realm.forbidden");
      }

      const anonymous = await call("POST", `${base}/join`);
      expect(anonymous.status).toBe(401);
      const unknown = await call("POST", `/api/v1/realms/${uniqueSlug("nobody")}/join`, {
        as: member,
      });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe("realm.not_found");
    }));
});

describe.skipIf(!live)("validation comes before the realm's guards", () => {
  test("a non-admin's malformed edit is a validation failure, not a refusal", () =>
    scenario(async ({ call, w }) => {
      const { slug, people } = await w.realm([], 1);
      const [member] = people as [string];
      const bad = await call("PATCH", `/api/v1/realms/${slug}`, {
        as: member,
        body: { modules: ["jobs"] },
      });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("common.request.validation_failed");
      const fine = await call("PATCH", `/api/v1/realms/${slug}`, {
        as: member,
        body: { name: "Taken over" },
      });
      expect(fine.status).toBe(403);
    }));

  test("a malformed slug on the realm root is a validation failure, not 404", () =>
    scenario(async ({ call, w }) => {
      const someone = await w.person();
      for (const [method, body] of [
        ["PATCH", { name: "Renamed" }],
        ["DELETE", undefined],
      ] as const) {
        const bad = await call(method, "/api/v1/realms/Not_A_Slug", { as: someone, body });
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe("common.request.validation_failed");
      }
    }));
});

describe.skipIf(!live)("platform administration routes", () => {
  test("found directly, and approve and reject proposals", () =>
    scenario(async ({ call, grants, w }) => {
      const reviewer = await w.person("Reviewer");
      grants.platform.add(reviewer);

      const slug = uniqueSlug();
      const founded = await call("POST", "/api/v1/realms", {
        as: reviewer,
        body: { slug, name: "Founded" },
      });
      expect(founded.status).toBe(201);
      expect(founded.body).toEqual({ id: expect.any(String), slug });

      const [first, second] = [await w.person("One"), await w.person("Two")];
      const ids: string[] = [];
      for (const proposer of [first, second]) {
        const created = await call("POST", "/api/v1/proposals", {
          as: proposer,
          body: { slug: uniqueSlug("p"), name: "Proposed", rationale },
        });
        ids.push(created.body.id);
      }

      const pending = await call("GET", "/api/v1/admin/proposals", { as: reviewer });
      expect(pending.status).toBe(200);
      const listed = v.parse(v.array(Web.Proposal), pending.body).map((p) => p.id);
      expect(listed).toEqual(expect.arrayContaining(ids));

      const approved = await call("POST", `/api/v1/admin/proposals/${ids[0]}/approve`, {
        as: reviewer,
      });
      expect(approved.status).toBe(201);
      expect(approved.body).toEqual({ realmId: expect.any(String) });
      expect(await w.roleOf(approved.body.realmId, first)).toBe(RealmRole.admin);

      const rejected = await call("POST", `/api/v1/admin/proposals/${ids[1]}/reject`, {
        as: reviewer,
        body: { note: "Too close to another realm" },
      });
      expect(rejected.status).toBe(200);
      expect(rejected.body).toEqual({ id: ids[1] });
    }));

  test("anyone else gets 404, as if the routes weren't there", () =>
    scenario(async ({ call, w }) => {
      const someone = await w.person();
      for (const [method, path, body] of [
        ["GET", "/api/v1/admin/proposals", undefined],
        ["POST", `/api/v1/admin/proposals/${Bun.randomUUIDv7()}/approve`, undefined],
        ["POST", `/api/v1/admin/proposals/${Bun.randomUUIDv7()}/reject`, { note: "nope" }],
        ["POST", "/api/v1/realms", { slug: uniqueSlug(), name: "Mine now" }],
      ] as const) {
        const refused = await call(method, path, { as: someone, body });
        expect(refused.status).toBe(404);
        expect(refused.body.code).toBe("common.route.not_found");
      }
    }));
});
