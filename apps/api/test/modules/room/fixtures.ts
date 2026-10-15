import { eq } from "drizzle-orm";
import * as v from "valibot";
import {
  jobs,
  listings,
  realmMembers,
  realms,
  roomBlocks,
  roomMessageKeys,
  roomMessages,
  roomReports,
  rooms,
  type Tx,
  userKeys,
} from "@akashic/db";
import { RealmRole, RoomSubject } from "@akashic/lib/enums";
import { expectOk } from "@akashic/lib/testing";
import { createRoomServices } from "@/modules/room/room.module.ts";
import { clock, person, uniqueSlug } from "../../support/fixtures.ts";

export const TICKET_SECRET = "room-test-secret-".repeat(3);

/** One device's keys, long enough for the request schema. */
export const deviceKey = (fingerprint: string) => ({
  publicKey: `pk-${fingerprint}-`.padEnd(40, "p"),
  signingKey: `sk-${fingerprint}-`.padEnd(40, "s"),
  fingerprint,
});

/** A message wrapped for each of `fingerprints`. */
export const outgoing = (body: string, ...fingerprints: string[]) => ({
  body,
  iv: "iv-12345678",
  keys: fingerprints.map((fingerprint) => ({
    fingerprint,
    wrappedKey: `wrapped-for-${fingerprint}`.padEnd(16, "k"),
    iv: "iv-12345678",
  })),
});

/** The room services on `tx`, and the rows the scenarios start from. */
export function world(tx: Tx) {
  const services = createRoomServices({ db: tx, clock, ticketSecret: TICKET_SECRET });

  /** A realm with an admin founder and `members` plain members, inserted directly. */
  async function realm(members = 2) {
    const admin = await person(tx, "Founder");
    const slug = uniqueSlug();
    const [row] = await tx
      .insert(realms)
      .values({ slug, name: "Test realm", createdBy: admin })
      .returning({ id: realms.id });
    const id = row!.id;
    await tx.insert(realmMembers).values({ realmId: id, userId: admin, role: RealmRole.admin });
    const people: string[] = [];
    for (let i = 0; i < members; i++) {
      const member = await person(tx, `Member ${i}`);
      await tx.insert(realmMembers).values({ realmId: id, userId: member, role: RealmRole.member });
      people.push(member);
    }
    return { id, slug, admin, people };
  }

  /** A listing in the realm, inserted directly: the postings module isn't what's tested. */
  async function listing(realmId: string, sellerId: string) {
    const [row] = await tx
      .insert(listings)
      .values({ realmId, sellerId, title: "Bike", description: "Red.", priceCents: 1000 })
      .returning({ id: listings.id });
    return row!.id;
  }

  async function job(realmId: string, authorId: string) {
    const [row] = await tx
      .insert(jobs)
      .values({ realmId, authorId, title: "Logo", description: "A logo." })
      .returning({ id: jobs.id });
    return row!.id;
  }

  /** Two members of a fresh realm, a listing, and the room between them about it. */
  async function room() {
    const r = await realm(2);
    const [alice, bob] = r.people as [string, string];
    const subjectId = await listing(r.id, bob);
    const { id } = expectOk(
      await services.rooms.start(alice, {
        realmSlug: r.slug,
        subjectKind: RoomSubject.listing,
        subjectId,
        withUserId: bob,
      }),
    );
    return { ...r, alice, bob, subjectId, roomId: id };
  }

  /** Adds someone to a realm as a plain member. */
  async function join(realmId: string, userId: string) {
    await tx.insert(realmMembers).values({ realmId, userId, role: RealmRole.member });
  }

  return {
    ...services,
    tx,
    join,
    realm,
    listing,
    job,
    room,
    person: (name?: string) => person(tx, name),
    /** Publishes each [owner, fingerprint] pair as one of that person's devices. */
    async devices(...owners: [string, string][]) {
      for (const [userId, fingerprint] of owners) {
        await services.rooms.publishKey(userId, deviceKey(fingerprint));
      }
    },
    async messageRows(roomId: string) {
      return tx.select().from(roomMessages).where(eq(roomMessages.roomId, roomId));
    },
    async keyRows(messageId: string) {
      return tx.select().from(roomMessageKeys).where(eq(roomMessageKeys.messageId, messageId));
    },
    async roomRow(roomId: string) {
      const [row] = await tx.select().from(rooms).where(eq(rooms.id, roomId));
      return row!;
    },
    async blockRows(roomId: string) {
      return tx.select().from(roomBlocks).where(eq(roomBlocks.roomId, roomId));
    },
    async reportRows(roomId: string) {
      return tx.select().from(roomReports).where(eq(roomReports.roomId, roomId));
    },
    async keyRowsOf(userId: string) {
      return tx.select().from(userKeys).where(eq(userKeys.userId, userId));
    },
  };
}

export type World = ReturnType<typeof world>;

// The web app's schemas (akashic_records_fe/src/lib/api/rooms.ts), copied: every response the web
// app reads must parse with what the browser parses it with.
const Envelope = v.object({ fingerprint: v.string(), wrappedKey: v.string(), iv: v.string() });

export const Web = {
  PublicKeys: v.object({
    userId: v.string(),
    publicKey: v.string(),
    signingKey: v.nullable(v.string()),
    fingerprint: v.string(),
  }),
  RoomSummary: v.object({
    id: v.string(),
    realmId: v.string(),
    subjectKind: v.number(),
    subjectId: v.string(),
    otherId: v.string(),
    otherName: v.string(),
    lastMessageAt: v.nullable(v.string()),
    createdAt: v.string(),
  }),
  StoredMessage: v.object({
    id: v.string(),
    senderId: v.string(),
    body: v.string(),
    iv: v.string(),
    signature: v.nullable(v.string()),
    createdAt: v.string(),
    wrappedKey: v.nullable(v.string()),
    keyIv: v.nullable(v.string()),
    keys: v.optional(v.array(Envelope)),
  }),
  Opened: v.object({ id: v.string() }),
  Ticket: v.object({ ticket: v.string(), expiresInSeconds: v.number() }),
};
