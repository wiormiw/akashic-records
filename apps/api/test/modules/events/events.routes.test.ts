import { afterAll, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { Relation } from "@akashic/authz";
import { createDb } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import { RealmModule, RsvpStatus } from "@akashic/lib/enums";
import { silentLogger } from "@akashic/lib/log";
import { expectOk } from "@akashic/lib/testing";
import { eventsApp } from "./app.ts";
import { clock, databaseUrl, uniqueSlug } from "../../support/fixtures.ts";
import { Web, world } from "./fixtures.ts";

// Every events route through app.request, on the real database in a rolled-back transaction: the
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
  run: (s: ReturnType<typeof eventsApp> & { w: ReturnType<typeof world> }) => Promise<void>,
) => withRollback(database.db, (tx) => run({ ...eventsApp(tx), w: world(tx) }));

const { participate, postEvent } = Relation.realm;
const startsAt = () => clock.now().add({ hours: 48 }).toString();
// The listing's "upcoming" is judged by the database's own now(), not the service clock.
const reallySoon = () => Temporal.Now.instant().add({ hours: 48 }).toString();

describe.skipIf(!live)("listing events", () => {
  test("is public, parses as the web app reads it, and counts who is going", () =>
    scenario(async ({ call, grant, w }) => {
      const { slug, admin, people } = await w.realm([RealmModule.events], 1);
      grant(admin, postEvent);
      const posted = await call("POST", `/api/v1/realms/${slug}/events`, {
        as: admin,
        body: { title: "Meetup", description: "Come along.", startsAt: reallySoon(), capacity: 3 },
      });
      grant(people[0]!, participate);
      await call("PUT", `/api/v1/realms/${slug}/events/${posted.body.id}/rsvp`, {
        as: people[0]!,
        body: { status: RsvpStatus.going },
      });

      const list = await call("GET", `/api/public/v1/realms/${slug}/events?limit=3`);
      expect(list.status).toBe(200);
      const [teaser] = v.parse(v.array(Web.EventTeaser), list.body);
      expect(teaser).toMatchObject({
        id: posted.body.id,
        title: "Meetup",
        capacity: 3,
        imageUrl: null,
        goingCount: 1,
      });
    }));

  test("a realm without the events module is 404, a bad limit a validation failure", () =>
    scenario(async ({ call, w }) => {
      const { slug } = await w.realm([RealmModule.jobs]);
      const off = await call("GET", `/api/public/v1/realms/${slug}/events`);
      expect(off.status).toBe(404);
      expect(off.body.code).toBe("realm.module_disabled");
      const bad = await call("GET", `/api/public/v1/realms/${slug}/events?limit=0`);
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("common.request.validation_failed");
      const missing = await call("GET", `/api/public/v1/realms/${uniqueSlug("nobody")}/events`);
      expect(missing.body.code).toBe("realm.not_found");
    }));
});

describe.skipIf(!live)("posting and reading one event", () => {
  test("a poster creates it (201, id only), a member reads it in full", () =>
    scenario(async ({ call, grant, w }) => {
      const { slug, id: realmId, admin, people } = await w.realm([RealmModule.events], 1);
      grant(admin, postEvent);
      grant(people[0]!, participate);
      const created = await call("POST", `/api/v1/realms/${slug}/events`, {
        as: admin,
        body: {
          title: "  Meetup  ",
          description: "Come along.",
          startsAt: startsAt(),
          endsAt: clock.now().add({ hours: 50 }).toString(),
          location: " Cafe ",
          imageUrl: "https://example.test/banner.png",
        },
      });
      expect(created.status).toBe(201);
      expect(Object.keys(created.body)).toEqual(["id"]);
      expect((await w.outbox("realm.posting_created", realmId)).length).toBe(1);

      const one = await call("GET", `/api/v1/realms/${slug}/events/${created.body.id}`, {
        as: people[0]!,
      });
      expect(one.status).toBe(200);
      expect(v.parse(Web.EventDetail, one.body)).toMatchObject({
        id: created.body.id,
        title: "Meetup",
        location: "Cafe",
        imageUrl: "https://example.test/banner.png",
        authorId: admin,
        authorName: "Founder",
        yourRsvp: null,
        goingCount: 0,
      });
    }));

  test("signed out is 401, no permission is 403, a past start is 400", () =>
    scenario(async ({ call, grant, w }) => {
      const { slug, admin, people } = await w.realm([RealmModule.events], 1);
      const body = { title: "Meetup", description: "Come along.", startsAt: startsAt() };

      const anon = await call("POST", `/api/v1/realms/${slug}/events`, { body });
      expect(anon.status).toBe(401);
      const forbidden = await call("POST", `/api/v1/realms/${slug}/events`, {
        as: people[0]!,
        body,
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe("realm.forbidden");

      grant(admin, postEvent);
      const past = await call("POST", `/api/v1/realms/${slug}/events`, {
        as: admin,
        body: { ...body, startsAt: clock.now().subtract({ hours: 1 }).toString() },
      });
      expect(past.status).toBe(400);
      expect(past.body.code).toBe("event.already_happened");
      const short = await call("POST", `/api/v1/realms/${slug}/events`, {
        as: admin,
        body: { ...body, title: "ab" },
      });
      expect(short.body.code).toBe("common.request.validation_failed");
    }));

  test("an event of another realm, or none, is 404 event.not_found", () =>
    scenario(async ({ call, grant, w }) => {
      const a = await w.realm([RealmModule.events]);
      const b = await w.realm([RealmModule.events], 1);
      grant(b.people[0]!, participate);
      const { id } = expectOk(
        await w.service.post({
          realmId: a.id,
          authorId: a.admin,
          title: "Meetup",
          description: "d",
          startsAt: clock.now().add({ hours: 48 }),
        }),
      );
      const foreign = await call("GET", `/api/v1/realms/${b.slug}/events/${id}`, {
        as: b.people[0]!,
      });
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe("event.not_found");
      const none = await call("GET", `/api/v1/realms/${b.slug}/events/${Bun.randomUUIDv7()}`, {
        as: b.people[0]!,
      });
      expect(none.body.code).toBe("event.not_found");
      const malformed = await call("GET", `/api/v1/realms/${b.slug}/events/nope`, {
        as: b.people[0]!,
      });
      expect(malformed.body.code).toBe("common.request.validation_failed");
    }));
});

describe.skipIf(!live)("RSVP routes", () => {
  async function oneSeat(s: Parameters<Parameters<typeof scenario>[0]>[0]) {
    const { call, grant, w } = s;
    const realm = await w.realm([RealmModule.events], 2);
    for (const member of realm.people) grant(member, participate);
    const { id } = expectOk(
      await w.service.post({
        realmId: realm.id,
        authorId: realm.admin,
        title: "Small table",
        description: "One seat.",
        startsAt: clock.now().add({ hours: 48 }),
        capacity: 1,
      }),
    );
    return {
      ...realm,
      eventId: id,
      rsvp: (as: string, status: number) =>
        call("PUT", `/api/v1/realms/${realm.slug}/events/${id}/rsvp`, { as, body: { status } }),
    };
  }

  test("answer, see it, withdraw it", () =>
    scenario(async (s) => {
      const { slug, eventId, people, rsvp } = await oneSeat(s);
      const going = await rsvp(people[0]!, RsvpStatus.going);
      expect(going.status).toBe(200);
      expect(going.body).toEqual({ status: RsvpStatus.going });

      const read = await s.call("GET", `/api/v1/realms/${slug}/events/${eventId}`, {
        as: people[0]!,
      });
      expect(v.parse(Web.EventDetail, read.body)).toMatchObject({
        yourRsvp: RsvpStatus.going,
        goingCount: 1,
      });

      const gone = await s.call("DELETE", `/api/v1/realms/${slug}/events/${eventId}/rsvp`, {
        as: people[0]!,
      });
      expect(gone.status).toBe(200);
      expect(gone.body).toEqual({ cleared: true });
      const again = await s.call("DELETE", `/api/v1/realms/${slug}/events/${eventId}/rsvp`, {
        as: people[0]!,
      });
      expect(again.body).toEqual({ cleared: false });
    }));

  test("a full event is 409 event.at_capacity", () =>
    scenario(async (s) => {
      const { people, rsvp } = await oneSeat(s);
      expect((await rsvp(people[0]!, RsvpStatus.going)).status).toBe(200);
      const full = await rsvp(people[1]!, RsvpStatus.going);
      expect(full.status).toBe(409);
      expect(full.body.code).toBe("event.at_capacity");
    }));

  test("signed out is 401, no permission is 403, a bad status is a validation failure", () =>
    scenario(async (s) => {
      const { slug, eventId, people, admin, rsvp } = await oneSeat(s);
      const url = `/api/v1/realms/${slug}/events/${eventId}/rsvp`;
      expect((await s.call("PUT", url, { body: { status: 0 } })).status).toBe(401);
      expect((await s.call("DELETE", url)).status).toBe(401);
      // The admin holds no participate grant here.
      const forbidden = await rsvp(admin, RsvpStatus.going);
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe("realm.forbidden");
      const bad = await rsvp(people[0]!, 9);
      expect(bad.body.code).toBe("common.request.validation_failed");
    }));

  test("an RSVP from another realm's URL is 404 and writes nothing", () =>
    scenario(async (s) => {
      const { eventId, people } = await oneSeat(s);
      const other = await s.w.realm([RealmModule.events]);
      s.grant(people[0]!, participate);
      const crossed = await s.call("PUT", `/api/v1/realms/${other.slug}/events/${eventId}/rsvp`, {
        as: people[0]!,
        body: { status: RsvpStatus.going },
      });
      expect(crossed.status).toBe(404);
      expect(crossed.body.code).toBe("event.not_found");
      expect(await s.w.rsvpOf(eventId, people[0]!)).toBeNull();
    }));
});
