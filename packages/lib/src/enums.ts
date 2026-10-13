// Stored as smallint. Values are pinned: append new members, never renumber.

type ValueOf<T> = T[keyof T];

/** Rank inside one realm. Mirrors RANK_RELATION in @akashic/authz. */
export const RealmRole = { member: 0, verified: 1, moderator: 2, admin: 3 } as const;
export type RealmRole = ValueOf<typeof RealmRole>;

/** Optional features a realm switches on. */
export const RealmModule = { jobs: 0, events: 1, market: 2, election: 3 } as const;
export type RealmModule = ValueOf<typeof RealmModule>;

export const RsvpStatus = { going: 0, interested: 1, declined: 2 } as const;
export type RsvpStatus = ValueOf<typeof RsvpStatus>;

export const JobType = { commission: 0, freelance: 1, fullTime: 2 } as const;
export type JobType = ValueOf<typeof JobType>;

export const JobStatus = { open: 0, closed: 1, filled: 2 } as const;
export type JobStatus = ValueOf<typeof JobStatus>;

export const ListingStatus = { active: 0, sold: 1, removed: 2 } as const;
export type ListingStatus = ValueOf<typeof ListingStatus>;

/** What a comment, interest or fit-queue row is attached to. */
export const CommentSubject = { event: 0, listing: 1, job: 2 } as const;
export type CommentSubject = ValueOf<typeof CommentSubject>;

export const InterestStatus = { open: 0, withdrawn: 1, accepted: 2, declined: 3 } as const;

export const ProposalStatus = { pending: 0, approved: 1, rejected: 2 } as const;
export type ProposalStatus = ValueOf<typeof ProposalStatus>;

export const TakedownStatus = { open: 0, carried: 1, refused: 2 } as const;
export type TakedownStatus = ValueOf<typeof TakedownStatus>;

/** Who votes on a recall: the whole membership, or only the moderators. */
export const RecallKind = { members: 0, moderators: 1 } as const;
export type RecallKind = ValueOf<typeof RecallKind>;

export const RecallStatus = { open: 0, carried: 1, refused: 2 } as const;
export type RecallStatus = ValueOf<typeof RecallStatus>;

export const RoomSubject = { job: 0, listing: 1 } as const;
export type RoomSubject = ValueOf<typeof RoomSubject>;

export const AuditAction = {
  created: 0,
  updated: 1,
  deleted: 2,
  roleChanged: 3,
  moderated: 4,
} as const;
export type AuditAction = ValueOf<typeof AuditAction>;

/** Narrows a raw column value, failing loudly on anything the code doesn't know. */
export function narrow<E extends Record<string, number>>(members: E, value: number): ValueOf<E> {
  if (!Object.values(members).includes(value)) {
    throw new RangeError(`${value} is not one of ${Object.values(members).join(", ")}`);
  }
  return value as ValueOf<E>;
}
