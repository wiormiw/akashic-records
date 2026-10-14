import { eq } from "drizzle-orm";
import * as v from "valibot";
import {
  comments,
  events,
  jobs,
  listings,
  realmMembers,
  realmModules,
  realms,
  type Tx,
} from "@akashic/db";
import { CommentSubject, RealmModule, RealmRole } from "@akashic/lib/enums";
import { createCommentService } from "@/modules/comments/comments.service.ts";
import { clock, outbox, person, uniqueSlug } from "../../support/fixtures.ts";

/** The comments service on `tx`, and the rows the scenarios start from. */
export function world(tx: Tx) {
  const service = createCommentService({ db: tx, clock });

  async function realm(members = 0) {
    const admin = await person(tx, "Founder");
    const slug = uniqueSlug();
    const [row] = await tx
      .insert(realms)
      .values({ slug, name: "Test realm", createdBy: admin })
      .returning({ id: realms.id });
    const id = row!.id;
    await tx.insert(realmModules).values(
      [RealmModule.events, RealmModule.jobs, RealmModule.market].map((module) => ({
        realmId: id,
        module,
      })),
    );
    await tx.insert(realmMembers).values({ realmId: id, userId: admin, role: RealmRole.admin });
    const people: string[] = [];
    for (let i = 0; i < members; i++) {
      const member = await person(tx, `Member ${i}`);
      await tx.insert(realmMembers).values({ realmId: id, userId: member, role: RealmRole.member });
      people.push(member);
    }
    return { id, slug, admin, people };
  }

  /** One posting of each kind, inserted directly: the postings module isn't what's tested. */
  async function postings(realmId: string, authorId: string, commentsEnabled = true) {
    const [event] = await tx
      .insert(events)
      .values({
        realmId,
        authorId,
        title: "Meetup",
        description: "Come along.",
        startsAt: new Date("2030-01-01T00:00:00Z"),
        commentsEnabled,
      })
      .returning({ id: events.id });
    const [job] = await tx
      .insert(jobs)
      .values({ realmId, authorId, title: "Commission", description: "Draw.", commentsEnabled })
      .returning({ id: jobs.id });
    const [listing] = await tx
      .insert(listings)
      .values({
        realmId,
        sellerId: authorId,
        title: "Print",
        description: "An A4 print.",
        priceCents: 1500,
        commentsEnabled,
      })
      .returning({ id: listings.id });
    return {
      event: { kind: CommentSubject.event, id: event!.id },
      job: { kind: CommentSubject.job, id: job!.id },
      listing: { kind: CommentSubject.listing, id: listing!.id },
    };
  }

  return {
    service,
    person: (name?: string) => person(tx, name),
    realm,
    postings,
    outbox: (type: string, realmId: string) => outbox(tx, type, realmId),
    async rows(subjectId: string) {
      return tx.select().from(comments).where(eq(comments.subjectId, subjectId));
    },
    async row(id: string) {
      const [row] = await tx.select().from(comments).where(eq(comments.id, id));
      return row;
    },
  };
}

// The web app's schema (akashic_records_fe/src/lib/api/realms.ts), copied: every response must
// parse with what the browser parses it with.
export const Web = {
  Comment: v.object({
    id: v.string(),
    body: v.string(),
    authorId: v.string(),
    authorName: v.string(),
    authorImage: v.nullable(v.string()),
    removed: v.boolean(),
    createdAt: v.string(),
  }),
};
