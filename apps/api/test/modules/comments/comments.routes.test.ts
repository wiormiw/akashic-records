import { afterAll, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { Relation } from "@akashic/authz";
import { createDb } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import { silentLogger } from "@akashic/lib/log";
import { commentsApp } from "./app.ts";
import { databaseUrl } from "../../support/fixtures.ts";
import { Web, world } from "./fixtures.ts";

// Every comments route through app.request, on the real database in a rolled-back transaction: the
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
  run: (s: ReturnType<typeof commentsApp> & { w: ReturnType<typeof world> }) => Promise<void>,
) => withRollback(database.db, (tx) => run({ ...commentsApp(tx), w: world(tx) }));

const { participate, moderate } = Relation.realm;

describe.skipIf(!live)("a thread", () => {
  test("a member adds a comment (201, id only) and reads it as the web app does", () =>
    scenario(async ({ call, grant, w }) => {
      const { slug, id: realmId, admin, people } = await w.realm(1);
      const { event, listing, job } = await w.postings(realmId, admin);
      grant(people[0]!, participate);

      for (const [segment, subject] of [
        ["events", event],
        ["listings", listing],
        ["jobs", job],
      ] as const) {
        const created = await call(
          "POST",
          `/api/v1/realms/${slug}/${segment}/${subject.id}/comments`,
          {
            as: people[0]!,
            body: { body: "  Still available?  " },
          },
        );
        expect(created.status).toBe(201);
        expect(Object.keys(created.body)).toEqual(["id"]);
      }
      expect((await w.outbox("realm.posting_created", realmId)).length).toBe(3);

      const thread = await call("GET", `/api/v1/realms/${slug}/events/${event.id}/comments`, {
        as: people[0]!,
      });
      expect(thread.status).toBe(200);
      expect(v.parse(v.array(Web.Comment), thread.body)).toMatchObject([
        {
          body: "Still available?",
          authorId: people[0],
          authorName: "Member 0",
          authorImage: null,
          removed: false,
        },
      ]);
    }));

  test("signed out is 401, no permission 403, a blank body 400, comments off 403", () =>
    scenario(async ({ call, grant, w }) => {
      const { slug, id: realmId, admin, people } = await w.realm(1);
      const { event } = await w.postings(realmId, admin);
      const closed = await w.postings(realmId, admin, false);
      const path = `/api/v1/realms/${slug}/events/${event.id}/comments`;
      const body = { body: "Hi" };

      expect((await call("POST", path, { body })).status).toBe(401);
      expect((await call("GET", path)).status).toBe(401);
      const forbidden = await call("POST", path, { as: people[0]!, body });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe("realm.forbidden");

      grant(people[0]!, participate);
      const blank = await call("POST", path, { as: people[0]!, body: { body: "   " } });
      expect(blank.status).toBe(400);
      expect(blank.body.code).toBe("common.request.validation_failed");
      const off = await call("POST", `/api/v1/realms/${slug}/events/${closed.event.id}/comments`, {
        as: people[0]!,
        body,
      });
      expect(off.status).toBe(403);
      expect(off.body.code).toBe("realm.forbidden");
    }));

  test("a posting of another realm is 404 to comment on or read, and nothing is written", () =>
    scenario(async ({ call, grant, w }) => {
      const home = await w.realm(1);
      const elsewhere = await w.realm(1);
      const foreign = await w.postings(elsewhere.id, elsewhere.admin);
      grant(home.people[0]!, participate);

      for (const [segment, subject] of [
        ["events", foreign.event],
        ["listings", foreign.listing],
        ["jobs", foreign.job],
      ] as const) {
        const path = `/api/v1/realms/${home.slug}/${segment}/${subject.id}/comments`;
        const posted = await call("POST", path, { as: home.people[0]!, body: { body: "Hi" } });
        expect(posted.status).toBe(404);
        expect(posted.body.code).toBe("event.not_found");
        expect((await call("GET", path, { as: home.people[0]! })).status).toBe(404);
        expect(await w.rows(subject.id)).toEqual([]);
      }
      expect((await w.outbox("realm.posting_created", home.id)).length).toBe(0);
    }));
});

describe.skipIf(!live)("removing a comment", () => {
  test("a moderator removes it (200), and it stays in the thread without its words", () =>
    scenario(async ({ call, grant, w }) => {
      const { slug, id: realmId, admin, people } = await w.realm(1);
      const { event } = await w.postings(realmId, admin);
      grant(people[0]!, participate);
      grant(admin, participate, moderate);
      const created = await call("POST", `/api/v1/realms/${slug}/events/${event.id}/comments`, {
        as: people[0]!,
        body: { body: "Rude words" },
      });

      const removed = await call("DELETE", `/api/v1/realms/${slug}/comments/${created.body.id}`, {
        as: admin,
      });
      expect(removed.status).toBe(200);
      expect(removed.body).toEqual({ removed: true });

      const thread = await call("GET", `/api/v1/realms/${slug}/events/${event.id}/comments`, {
        as: admin,
      });
      expect(v.parse(v.array(Web.Comment), thread.body)).toMatchObject([
        { body: "", removed: true },
      ]);
    }));

  test("signed out is 401, a member without moderate is 403, a bad id 400", () =>
    scenario(async ({ call, grant, w }) => {
      const { slug, id: realmId, admin, people } = await w.realm(1);
      const { event } = await w.postings(realmId, admin);
      grant(people[0]!, participate);
      const created = await call("POST", `/api/v1/realms/${slug}/events/${event.id}/comments`, {
        as: people[0]!,
        body: { body: "Mine" },
      });
      const path = `/api/v1/realms/${slug}/comments/${created.body.id}`;

      expect((await call("DELETE", path)).status).toBe(401);
      const forbidden = await call("DELETE", path, { as: people[0]! });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe("realm.forbidden");
      const bad = await call("DELETE", `/api/v1/realms/${slug}/comments/nope`, { as: admin });
      expect(bad.status).toBe(400);
      expect((await w.row(created.body.id))?.removedAt).toBeNull();
    }));

  test("a comment of another realm is 404 and stays, even for a moderator here", () =>
    scenario(async ({ call, grant, w }) => {
      const home = await w.realm();
      const elsewhere = await w.realm(1);
      const { event } = await w.postings(elsewhere.id, elsewhere.admin);
      grant(elsewhere.people[0]!, participate);
      grant(home.admin, moderate);
      const created = await call(
        "POST",
        `/api/v1/realms/${elsewhere.slug}/events/${event.id}/comments`,
        { as: elsewhere.people[0]!, body: { body: "Theirs" } },
      );

      const refused = await call(
        "DELETE",
        `/api/v1/realms/${home.slug}/comments/${created.body.id}`,
        {
          as: home.admin,
        },
      );
      expect(refused.status).toBe(404);
      expect(refused.body.code).toBe("event.not_found");
      expect((await w.row(created.body.id))?.removedAt).toBeNull();
    }));
});
