import * as v from "valibot";
import type { RealmRole } from "@akashic/lib/enums";

// The events the outbox carries: each type, the schema of its payload, and a builder. Publishers
// build with the builders and consumers parse with the schemas, so the two sides cannot drift
// apart silently. Type strings and field names are stored in outbox rows and on the broker:
// never rename one.

/** What a builder returns: plain data, assignable to the outbox's DomainEvent. */
export interface EventOf<T extends string, P> {
  type: T;
  payload: P;
}

const Id = v.pipe(v.string(), v.minLength(1));

// Membership lives in Postgres; OpenFGA holds a copy, written by the consumer of these.
export const RealmEvent = {
  created: "realm.created",
  memberChanged: "realm.member_changed",
  postingCreated: "realm.posting_created",
} as const;

/** What a posting-created event can describe. */
export const PostingKinds = ["job", "listing", "event", "comment"] as const;
export type PostingKind = (typeof PostingKinds)[number];

export const RealmEventPayload = {
  [RealmEvent.created]: v.object({ realmId: Id }),
  /** `role` null means the member left. */
  [RealmEvent.memberChanged]: v.object({
    realmId: Id,
    userId: Id,
    role: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  }),
  [RealmEvent.postingCreated]: v.object({
    kind: v.picklist(PostingKinds),
    postingId: Id,
    realmId: Id,
    authorId: Id,
  }),
} as const;

export type RealmEventPayload<E extends keyof typeof RealmEventPayload> = v.InferOutput<
  (typeof RealmEventPayload)[E]
>;

type RealmEventOf<E extends keyof typeof RealmEventPayload> = EventOf<E, RealmEventPayload<E>>;

export const realmEvents = {
  created: (realmId: string): RealmEventOf<typeof RealmEvent.created> => ({
    type: RealmEvent.created,
    payload: { realmId },
  }),

  /** `role` null means the member left. */
  memberChanged: (
    realmId: string,
    userId: string,
    role: RealmRole | null,
  ): RealmEventOf<typeof RealmEvent.memberChanged> => ({
    type: RealmEvent.memberChanged,
    payload: { realmId, userId, role },
  }),

  postingCreated: (
    kind: PostingKind,
    posting: { postingId: string; realmId: string; authorId: string },
  ): RealmEventOf<typeof RealmEvent.postingCreated> => ({
    type: RealmEvent.postingCreated,
    payload: { kind, ...posting },
  }),
};

/** Mail other features ask for; the mail consumer sends it. */
export const MAIL_REQUESTED = "mail.requested";

export const MailRequestedPayload = v.object({
  to: v.pipe(v.string(), v.minLength(1)),
  subject: v.string(),
  html: v.string(),
  link: v.nullable(v.string()),
});
export type MailRequested = v.InferOutput<typeof MailRequestedPayload>;

export const mailRequested = (
  message: MailRequested,
): EventOf<typeof MAIL_REQUESTED, MailRequested> => ({
  type: MAIL_REQUESTED,
  payload: message,
});
