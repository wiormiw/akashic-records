import { afterAll, describe, expect, test } from "bun:test";
import { eq, or } from "drizzle-orm";
import { createDb, rooms, type Tx, userKeys } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import { RoomSubject } from "@akashic/lib/enums";
import { ErrorCode } from "@akashic/lib/errors";
import { silentLogger } from "@akashic/lib/log";
import { expectErr, expectOk } from "@akashic/lib/testing";
import { toDate } from "@akashic/lib/time";
import { policy } from "@/config.ts";
import { createTickets } from "@/modules/room/room.service.ts";
import { clock, databaseUrl } from "../../support/fixtures.ts";
import { deviceKey, TICKET_SECRET, world, type World } from "./fixtures.ts";

const NOW = Temporal.Instant.from("2026-06-01T12:00:00Z");
const ROOM = "01a0d6ac-0000-7000-8000-000000000001";
const USER = "01a0d6ac-0000-7000-8000-0000000000aa";

describe("socket tickets", () => {
  const tickets = createTickets({ secret: TICKET_SECRET, ttl: { seconds: 60 } });

  test("a ticket names its room and user until it expires", () => {
    const ticket = tickets.issue(ROOM, USER, NOW);
    expect(tickets.read(ticket, NOW)).toEqual({ roomId: ROOM, userId: USER });
    expect(tickets.read(ticket, NOW.add({ seconds: 60 }))).toEqual({ roomId: ROOM, userId: USER });
    expect(tickets.read(ticket, NOW.add({ seconds: 61 }))).toBeNull();
  });

  test("a forged, re-signed or malformed ticket is refused", () => {
    const ticket = tickets.issue(ROOM, USER, NOW);
    const [room, user, expires, signature] = ticket.split(":") as [string, string, string, string];
    // Another user, or a later expiry, under the same signature.
    expect(tickets.read(`${room}:${ROOM}:${expires}:${signature}`, NOW)).toBeNull();
    expect(tickets.read(`${room}:${user}:${Number(expires) + 1}:${signature}`, NOW)).toBeNull();
    // Signed with another secret.
    const other = createTickets({ secret: "another-secret-".repeat(3), ttl: { seconds: 60 } });
    expect(tickets.read(other.issue(ROOM, USER, NOW), NOW)).toBeNull();
    // A flipped signature character, missing fields, extra fields.
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    expect(tickets.read(`${room}:${user}:${expires}:${flipped}`, NOW)).toBeNull();
    expect(tickets.read(`${room}:${user}:${expires}`, NOW)).toBeNull();
    expect(tickets.read(`${ticket}:extra`, NOW)).toBeNull();
    expect(tickets.read("", NOW)).toBeNull();
  });
});

// The room access service on the real database, each test in a transaction that is rolled back.

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

const about = (realmSlug: string, subjectId: string, withUserId: string) => ({
  realmSlug,
  subjectKind: RoomSubject.listing,
  subjectId,
  withUserId,
});

describe.skipIf(!live)("opening a room", () => {
  test("two members of the realm get a room about the posting, the same one either way", () =>
    inWorld(async (w) => {
      const { id, slug, people } = await w.realm(2);
      const [ann, bob] = people as [string, string];
      const listing = await w.listing(id, bob);

      const { id: roomId } = expectOk(await w.rooms.start(ann, about(slug, listing, bob)));
      expect(await w.roomRow(roomId)).toMatchObject({
        realmId: id,
        subjectKind: RoomSubject.listing,
        subjectId: listing,
        // The pair is stored ordered.
        lowUserId: ann < bob ? ann : bob,
        highUserId: ann < bob ? bob : ann,
      });
      expect(expectOk(await w.rooms.start(bob, about(slug, listing, ann))).id).toBe(roomId);
    }));

  test("a room about a job is about that job", () =>
    inWorld(async (w) => {
      const { id, slug, people } = await w.realm(2);
      const [ann, bob] = people as [string, string];
      const job = await w.job(id, bob);
      const { id: roomId } = expectOk(
        await w.rooms.start(ann, {
          realmSlug: slug,
          subjectKind: RoomSubject.job,
          subjectId: job,
          withUserId: bob,
        }),
      );
      expect(await w.roomRow(roomId)).toMatchObject({ subjectKind: RoomSubject.job });
    }));

  test("each way it is refused, opening nothing", () =>
    inWorld(async (w, tx) => {
      const { id, slug, people } = await w.realm(1);
      const [ann] = people as [string];
      const bob = await w.person("Outsider");
      const carol = await w.person("Carol");
      const listing = await w.listing(id, ann);
      const before = (await tx.select().from(rooms)).length;

      expectErr(await w.rooms.start(ann, about(slug, listing, ann)), ErrorCode.common.validation);
      expectErr(
        await w.rooms.start(ann, about("no-such-realm", listing, bob)),
        ErrorCode.realm.notFound,
      );
      // The other person, or the caller, isn't in the realm.
      expectErr(await w.rooms.start(ann, about(slug, listing, bob)), ErrorCode.realm.notMember);
      expectErr(await w.rooms.start(carol, about(slug, listing, ann)), ErrorCode.realm.notMember);
      expect((await tx.select().from(rooms)).length).toBe(before);
    }));

  test("a posting in another realm, or none at all, is not found, opening nothing", () =>
    inWorld(async (w, tx) => {
      const { id, slug, admin, people } = await w.realm(1);
      const [ann] = people as [string];
      const elsewhere = await w.realm(1);
      const foreign = await w.listing(elsewhere.id, elsewhere.people[0]!);
      const job = await w.job(id, admin);
      const before = (await tx.select().from(rooms)).length;

      expectErr(await w.rooms.start(ann, about(slug, foreign, admin)), ErrorCode.event.notFound);
      expectErr(
        await w.rooms.start(ann, about(slug, Bun.randomUUIDv7(), admin)),
        ErrorCode.event.notFound,
      );
      // A job's id named as a listing is not a listing.
      expectErr(await w.rooms.start(ann, about(slug, job, admin)), ErrorCode.event.notFound);
      expect((await tx.select().from(rooms)).length).toBe(before);
    }));

  test("the daily cap counts the last 24 hours and stops the next room at the limit", () =>
    inWorld(async (w, tx) => {
      const { id, slug, people } = await w.realm(1);
      const [ann] = people as [string];
      const others: string[] = [];
      for (let i = 0; i < policy.rooms.roomsPerDay; i++) {
        const other = await w.person(`Other ${i}`);
        others.push(other);
      }
      const listing = await w.listing(id, ann);
      // Rooms opened just now, directly; the realm's membership isn't what is counted.
      await tx.insert(rooms).values(
        others.slice(0, -1).map((other) => ({
          realmId: id,
          subjectKind: RoomSubject.listing,
          subjectId: listing,
          lowUserId: ann < other ? ann : other,
          highUserId: ann < other ? other : ann,
        })),
      );
      const bob = others.at(-1)!;
      const extra = await w.person("Extra");
      await w.join(id, bob);
      await w.join(id, extra);

      // One under the cap: this one opens.
      expectOk(await w.rooms.start(ann, about(slug, listing, bob)));
      // At the cap: the next is refused.
      expectErr(
        await w.rooms.start(ann, about(slug, listing, extra)),
        ErrorCode.common.rateLimited,
      );
      // Rooms older than a day don't count: age them all past the window.
      await tx
        .update(rooms)
        .set({ createdAt: toDate(clock.now().subtract({ hours: 25 })) })
        .where(or(eq(rooms.lowUserId, ann), eq(rooms.highUserId, ann)));
      expectOk(await w.rooms.start(ann, about(slug, listing, extra)));
    }));
});

describe.skipIf(!live)("device keys", () => {
  test("publishing adds a device, republishing refreshes it, and the keys list oldest first", () =>
    inWorld(async (w) => {
      const ann = await w.person("Ann");
      expectErr(await w.rooms.keysOf(ann), ErrorCode.realm.notMember);

      expect(await w.rooms.publishKey(ann, deviceKey("ann-phone-1"))).toEqual({ published: true });
      expect(await w.rooms.publishKey(ann, deviceKey("ann-laptop-1"))).toEqual({ published: true });
      await w.rooms.publishKey(ann, { ...deviceKey("ann-phone-1"), signingKey: "s".repeat(40) });
      // One transaction stamps both alike; the laptop is made the older device.
      await w.tx
        .update(userKeys)
        .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
        .where(eq(userKeys.fingerprint, "ann-laptop-1"));

      const keys = expectOk(await w.rooms.keysOf(ann));
      expect(keys.map((key) => key.fingerprint)).toEqual(["ann-laptop-1", "ann-phone-1"]);
      expect(keys[1]).toEqual({
        userId: ann,
        ...deviceKey("ann-phone-1"),
        signingKey: "s".repeat(40),
      });
    }));
});

describe.skipIf(!live)("the inbox, tickets and admission", () => {
  test("the inbox shows each room from the caller's side, most recent first", () =>
    inWorld(async (w) => {
      const first = await w.room();
      const { id, slug } = first;
      const carol = await w.person("Carol");
      await w.join(id, carol);
      const listing = await w.listing(id, carol);
      const { id: second } = expectOk(
        await w.rooms.start(first.alice, about(slug, listing, carol)),
      );

      // The first room spoke more recently.
      const at = (iso: string) => new Date(iso);
      await w.tx
        .update(rooms)
        .set({ lastMessageAt: at("2026-06-01T11:00:00Z") })
        .where(eq(rooms.id, first.roomId));
      await w.tx
        .update(rooms)
        .set({ lastMessageAt: at("2026-06-01T10:00:00Z") })
        .where(eq(rooms.id, second));

      const inbox = await w.rooms.inbox(first.alice);
      expect(inbox.map((room) => room.id)).toEqual([first.roomId, second]);
      expect(inbox[0]).toMatchObject({ otherId: first.bob, otherName: "Member 1" });
      expect(inbox[0]?.lastMessageAt?.toString()).toBe("2026-06-01T11:00:00Z");
      expect(inbox[1]).toMatchObject({ otherId: carol, otherName: "Carol" });
      expect((await w.rooms.inbox(first.bob)).map((room) => room.otherId)).toEqual([first.alice]);
    }));

  test("a participant gets a ticket that admits them to that room only; anyone else gets none", () =>
    inWorld(async (w) => {
      const { roomId, alice, bob } = await w.room();
      const other = await w.room();
      const stranger = await w.person("Stranger");

      const { ticket, expiresInSeconds } = expectOk(await w.rooms.ticket(roomId, alice));
      expect(expiresInSeconds).toBe(policy.rooms.ticketTtlSeconds);
      expect(await w.rooms.admit(roomId, ticket)).toEqual({ roomId, userId: alice });
      expect(await w.rooms.admit(other.roomId, ticket)).toBeNull();
      expect(await w.rooms.admit(roomId, "forged")).toBeNull();

      expectErr(await w.rooms.ticket(roomId, stranger), ErrorCode.event.notFound);
      expectOk(await w.rooms.ticket(roomId, bob));
    }));
});
