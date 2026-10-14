import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { FgaType, type Authorizer, type Check } from "@akashic/authz";
import { createDb, realmMembers, realmModules, realms, user, type Tx } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import { RealmModule, RealmRole } from "@akashic/lib/enums";
import { silentLogger } from "@akashic/lib/log";
import type { AppEnv } from "@/http/env.ts";
import { problemHandler } from "@/http/problem.ts";
import {
  realmContext,
  requireModule,
  requireOn,
  requirePermission,
  type RealmEnv,
} from "@/http/realm-context.ts";

// Two realms, one retired, in a transaction that is rolled back. The caller is whoever the x-user
// header names; the authorizer grants "can_post" and "can_administer" to the realm's admin and
// nothing to anyone else.

const url = Bun.env.DATABASE_URL ?? "postgres://akashic:akashic@localhost:5432/akashic";
const database = createDb({
  url,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

interface World {
  call(
    method: string,
    path: string,
    as?: "admin" | "member",
  ): Promise<{ status: number; body: any }>;
  slugs: { live: string; retired: string };
  /** Each request's signal, and what the authorizer was handed, in order. */
  signals: { request: AbortSignal[]; checkMany: (AbortSignal | undefined)[] };
  /** The checks `requireOn` asked for. */
  checks: Check[];
}

async function inWorld(run: (world: World) => Promise<void>) {
  await withRollback(database.db, async (tx: Tx) => {
    const tag = Bun.randomUUIDv7().slice(-12);
    const [admin, member] = await tx
      .insert(user)
      .values([
        { name: "Admin", email: `rc-admin-${tag}@example.test` },
        { name: "Member", email: `rc-member-${tag}@example.test` },
      ])
      .returning({ id: user.id });
    const slugs = { live: `rc-live-${tag}`, retired: `rc-retired-${tag}` };
    const [liveRealm, retiredRealm] = await tx
      .insert(realms)
      .values([
        { slug: slugs.live, name: "Live", createdBy: admin!.id },
        { slug: slugs.retired, name: "Retired", createdBy: admin!.id, archivedAt: new Date() },
      ])
      .returning({ id: realms.id });
    await tx.insert(realmModules).values([
      { realmId: liveRealm!.id, module: RealmModule.events },
      { realmId: liveRealm!.id, module: RealmModule.jobs },
    ]);
    await tx.insert(realmMembers).values([
      { realmId: liveRealm!.id, userId: admin!.id, role: RealmRole.admin },
      { realmId: liveRealm!.id, userId: member!.id, role: RealmRole.member },
      { realmId: retiredRealm!.id, userId: admin!.id, role: RealmRole.admin },
    ]);

    const ids = { admin: admin!.id, member: member!.id };
    const signals: World["signals"] = { request: [], checkMany: [] };
    const checks: Check[] = [];
    const authorizer = {
      checkMany: async (
        asked: readonly { userId: string; relation: string }[],
        signal?: AbortSignal,
      ) => {
        signals.checkMany.push(signal);
        return asked.map(
          (check) =>
            check.userId === ids.admin && ["can_post", "can_administer"].includes(check.relation),
        );
      },
      // Only the object called "allowed" may be settled.
      check: async (check: Check) => {
        checks.push(check);
        return check.objectId === "allowed";
      },
    } as unknown as Authorizer;
    const settle = requireOn(authorizer, "can_settle", FgaType.job);

    const realm = new Hono<RealmEnv>()
      .use(realmContext({ db: tx, authorizer }))
      .get("/", (c) => c.json(c.var.realm))
      .post("/", (c) => c.text("restored"))
      .post("/jobs", requireModule(RealmModule.jobs), (c) => c.text("posted"))
      .post("/market", requireModule(RealmModule.market), (c) => c.text("listed"))
      .post("/moderate", requirePermission("moderate"), (c) => c.text("moderated"))
      .post("/jobs/:id/settle", settle, (c) => c.text("settled"))
      .post("/settle", settle, (c) => c.text("settled"));

    const app = new Hono<AppEnv>()
      .use(async (c, next) => {
        c.set("requestId", "r");
        const signal = new AbortController().signal;
        signals.request.push(signal);
        c.set("signal", signal);
        const as = c.req.header("x-user") as keyof typeof ids | undefined;
        c.set("user", as ? { id: ids[as], email: `${as}@example.test` } : null);
        await next();
      })
      .route("/realms/:slug", realm);
    app.onError(problemHandler(silentLogger()));

    await run({
      slugs,
      signals,
      checks,
      async call(method, path, as) {
        const response = await app.request(path, {
          method,
          headers: as ? { "x-user": as } : {},
        });
        const text = await response.text();
        return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text };
      },
    });
  });
}

describe.skipIf(!live)("realm context", () => {
  test("a visitor gets the realm with no role and no permissions", () =>
    inWorld(async ({ call, slugs }) => {
      const { status, body } = await call("GET", `/realms/${slugs.live}`);
      expect(status).toBe(200);
      expect(body.realmSlug).toBe(slugs.live);
      expect(body.realmRole).toBeNull();
      expect(body.realmModules).toEqual([RealmModule.jobs, RealmModule.events]);
      expect(Object.values(body.permissions).some(Boolean)).toBe(false);
    }));

  test("a signed-in caller gets their role and exactly what the authorizer grants", () =>
    inWorld(async ({ call, slugs }) => {
      const { body } = await call("GET", `/realms/${slugs.live}`, "admin");
      expect(body.realmRole).toBe(RealmRole.admin);
      expect(body.permissions).toMatchObject({ post: true, administer: true, moderate: false });
      expect((await call("GET", `/realms/${slugs.live}`, "member")).body.realmRole).toBe(
        RealmRole.member,
      );
    }));

  test("an unknown realm is a 404", () =>
    inWorld(async ({ call }) => {
      const { status, body } = await call("GET", `/realms/no-such-realm-${Bun.randomUUIDv7()}`);
      expect(status).toBe(404);
      expect(body.code).toBe("realm.not_found");
    }));

  test("a retired realm reads, refuses new content, but lets its admin restore it", () =>
    inWorld(async ({ call, slugs }) => {
      const read = await call("GET", `/realms/${slugs.retired}`, "admin");
      expect(read.status).toBe(200);
      // Retired: only administer survives, so the admin can still restore it.
      expect(read.body.permissions).toMatchObject({ post: false, administer: true });

      const refused = await call("POST", `/realms/${slugs.retired}/jobs`, "admin");
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("realm.archived");
      expect((await call("POST", `/realms/${slugs.retired}`, "admin")).body).toBe("restored");
      expect((await call("POST", `/realms/${slugs.live}/jobs`, "member")).body).toBe("posted");
    }));

  test("a module the realm doesn't run is a 404", () =>
    inWorld(async ({ call, slugs }) => {
      const { status, body } = await call("POST", `/realms/${slugs.live}/market`, "admin");
      expect(status).toBe(404);
      expect(body.code).toBe("realm.module_disabled");
      expect(body.detail).toBe("This realm does not run a marketplace.");
    }));

  test("a missing permission is a 403", () =>
    inWorld(async ({ call, slugs }) => {
      const { status, body } = await call("POST", `/realms/${slugs.live}/moderate`, "admin");
      expect(status).toBe(403);
      expect(body.code).toBe("realm.forbidden");
    }));

  test("the authorizer is asked under the request's signal", () =>
    inWorld(async ({ call, slugs, signals }) => {
      await call("GET", `/realms/${slugs.live}`, "admin");
      expect(signals.checkMany).toHaveLength(1);
      expect(signals.checkMany[0]).toBe(signals.request[0]);
    }));

  test("requireOn refuses without a caller, without an id, and on a denied check", () =>
    inWorld(async ({ call, slugs, checks }) => {
      for (const [path, as] of [
        [`/realms/${slugs.live}/jobs/allowed/settle`, undefined],
        [`/realms/${slugs.live}/settle`, "admin"],
        [`/realms/${slugs.live}/jobs/denied/settle`, "admin"],
      ] as const) {
        const { status, body } = await call("POST", path, as);
        expect(status).toBe(403);
        expect(body.code).toBe("realm.forbidden");
      }
      // Only the denied one reached the authorizer: the others were refused before asking.
      expect(checks.map((check) => check.objectId)).toEqual(["denied"]);
    }));

  test("requireOn lets an allowed check through, asking about the path's object", () =>
    inWorld(async ({ call, slugs, checks }) => {
      const { status, body } = await call(
        "POST",
        `/realms/${slugs.live}/jobs/allowed/settle`,
        "admin",
      );
      expect(status).toBe(200);
      expect(body).toBe("settled");
      expect(checks).toEqual([
        {
          userId: expect.any(String),
          relation: "can_settle",
          type: FgaType.job,
          objectId: "allowed",
        },
      ]);
    }));
});
