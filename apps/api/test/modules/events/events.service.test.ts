import { afterAll, describe, expect, test } from "bun:test";
import { createDb, events, type Tx } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import { RealmModule, RsvpStatus } from "@akashic/lib/enums";
import { silentLogger } from "@akashic/lib/log";
import { expectErr, expectOk } from "@akashic/lib/testing";
import { clock, databaseUrl } from "../../support/fixtures.ts";
import { world } from "./fixtures.ts";

// The events service on the real database, each test in a transaction that is rolled back.

const database = createDb({
  url: databaseUrl,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const inWorld = (run: (w: ReturnType<typeof world>, tx: Tx) => Promise<void>) =>
  withRollback(database.db, (tx) => run(world(tx), tx));

const soon = () => clock.now().add({ hours: 48 });
// The listing's "upcoming" is judged by the database's own now(), not the service clock.
const reallySoon = () => Temporal.Now.instant().add({ hours: 48 });

describe.skipIf(!live)("posting an event", () => {
  test("stores it and publishes realm.posting_created", () =>
    inWorld(async (w) => {
      const { id: realmId, admin } = await w.realm();
      const { id } = expectOk(
        await w.service.post({
          realmId,
          authorId: admin,
          title: "Meetup",
          description: "Come along.",
          startsAt: soon(),
          capacity: 5,
        }),
      );
      expect(await w.eventRow(id)).toMatchObject({ realmId, authorId: admin, capacity: 5 });
      const published = await w.outbox("realm.posting_created", realmId);
      expect(published.map((e) => e.payload)).toEqual([
        { kind: "event", postingId: id, realmId, authorId: admin },
      ]);
    }));

  test("an event cannot start in the past, and nothing is written or published", () =>
    inWorld(async (w) => {
      const { id: realmId, admin } = await w.realm();
      expectErr(
        await w.service.post({
          realmId,
          authorId: admin,
          title: "Yesterday",
          description: "Too late.",
          startsAt: clock.now().subtract({ hours: 1 }),
        }),
        "event.already_happened",
      );
      expect(await w.service.browse(realmId, false, 10)).toEqual([]);
      expect(await w.outbox("realm.posting_created", realmId)).toEqual([]);
    }));
});

describe.skipIf(!live)("reading events", () => {
  test("lists a realm's events soonest first, upcoming only unless asked", () =>
    inWorld(async (w, tx) => {
      const { id: realmId, admin } = await w.realm();
      const other = await w.realm();
      const post = (title: string, startsAt: Temporal.Instant, realm = realmId) =>
        w.service.post({ realmId: realm, authorId: admin, title, description: "d", startsAt });
      const later = expectOk(await post("Later", reallySoon().add({ hours: 24 })));
      const sooner = expectOk(await post("Sooner", reallySoon()));
      expectOk(await post("Elsewhere", reallySoon(), other.id));
      // The service refuses a past start, so a finished event is written directly.
      await tx.insert(events).values({
        realmId,
        authorId: admin,
        title: "Done",
        description: "d",
        startsAt: new Date("2000-01-01T00:00:00Z"),
      });

      const upcoming = await w.service.browse(realmId, true, 10);
      expect(upcoming.map((e) => e.id)).toEqual([sooner.id, later.id]);
      const all = await w.service.browse(realmId, false, 10);
      expect(all.map((e) => e.title)).toEqual(["Done", "Sooner", "Later"]);
      expect(await w.service.browse(realmId, false, 1)).toHaveLength(1);
    }));

  test("reads one with its author, count and the viewer's own answer", () =>
    inWorld(async (w) => {
      const { id: realmId, admin, people } = await w.realm([RealmModule.events], 2);
      const { id } = expectOk(
        await w.service.post({
          realmId,
          authorId: admin,
          title: "Meetup",
          description: "Come along.",
          startsAt: soon(),
        }),
      );
      expectOk(await w.service.respond(realmId, id, people[0]!, RsvpStatus.going));
      expectOk(await w.service.respond(realmId, id, people[1]!, RsvpStatus.interested));

      const mine = expectOk(await w.service.read(realmId, id, people[1]!));
      expect(mine).toMatchObject({
        id,
        authorId: admin,
        authorName: "Founder",
        goingCount: 1,
        yourRsvp: RsvpStatus.interested,
        capacity: null,
        endsAt: null,
        commentsEnabled: true,
      });
      expect(expectOk(await w.service.read(realmId, id, admin)).yourRsvp).toBeNull();
    }));

  test("an event of another realm is not found, even by id", () =>
    inWorld(async (w) => {
      const a = await w.realm();
      const b = await w.realm([RealmModule.events], 1);
      const { id } = expectOk(
        await w.service.post({
          realmId: a.id,
          authorId: a.admin,
          title: "Meetup",
          description: "d",
          startsAt: soon(),
        }),
      );
      expectErr(await w.service.read(b.id, id, b.people[0]!), "event.not_found");
      expectErr(
        await w.service.respond(b.id, id, b.people[0]!, RsvpStatus.going),
        "event.not_found",
      );
      expectErr(await w.service.withdraw(b.id, id, b.people[0]!), "event.not_found");
      expect(await w.rsvpOf(id, b.people[0]!)).toBeNull();
    }));
});

describe.skipIf(!live)("RSVPs", () => {
  async function capped(w: ReturnType<typeof world>, capacity: number, members = 3) {
    const realm = await w.realm([RealmModule.events], members);
    const { id } = expectOk(
      await w.service.post({
        realmId: realm.id,
        authorId: realm.admin,
        title: "Small table",
        description: "Few seats.",
        startsAt: soon(),
        capacity,
      }),
    );
    return { ...realm, eventId: id };
  }

  test("an event at capacity refuses the next attendee", () =>
    inWorld(async (w) => {
      const { id, eventId, people } = await capped(w, 1);
      expectOk(await w.service.respond(id, eventId, people[0]!, RsvpStatus.going));
      expectErr(
        await w.service.respond(id, eventId, people[1]!, RsvpStatus.going),
        "event.at_capacity",
      );
      expect(await w.rsvpOf(eventId, people[1]!)).toBeNull();
    }));

  test("a full event still takes interested and declined, and keeps those going", () =>
    inWorld(async (w) => {
      const { id, eventId, people } = await capped(w, 1);
      expectOk(await w.service.respond(id, eventId, people[0]!, RsvpStatus.going));
      expectOk(await w.service.respond(id, eventId, people[1]!, RsvpStatus.interested));
      expectOk(await w.service.respond(id, eventId, people[2]!, RsvpStatus.declined));
      expectOk(await w.service.respond(id, eventId, people[0]!, RsvpStatus.going));
    }));

  test("changing an answer replaces it, and leaving going frees the place", () =>
    inWorld(async (w) => {
      const { id, eventId, people } = await capped(w, 1);
      expectOk(await w.service.respond(id, eventId, people[0]!, RsvpStatus.going));
      expectOk(await w.service.respond(id, eventId, people[0]!, RsvpStatus.declined));
      expect(await w.rsvpOf(eventId, people[0]!)).toBe(RsvpStatus.declined);
      expectOk(await w.service.respond(id, eventId, people[1]!, RsvpStatus.going));
    }));

  test("withdrawing reports whether there was an answer to clear", () =>
    inWorld(async (w) => {
      const { id, eventId, people } = await capped(w, 2);
      expect(expectOk(await w.service.withdraw(id, eventId, people[0]!))).toEqual({
        cleared: false,
      });
      expectOk(await w.service.respond(id, eventId, people[0]!, RsvpStatus.going));
      expect(expectOk(await w.service.withdraw(id, eventId, people[0]!))).toEqual({
        cleared: true,
      });
      expect(await w.rsvpOf(eventId, people[0]!)).toBeNull();
    }));
});
