import * as v from "valibot";
import { narrow, ProposalStatus, RealmModule, RealmRole } from "@akashic/lib/enums";
import { iso, isoOrNull, oneOf, Slug, Timestamp, trimmedAsSent } from "./common.ts";

// The realms API contract: what realms, membership and proposals accept and answer.

const modules = v.array(oneOf(RealmModule));
const name = trimmedAsSent({ minLength: 2, maxLength: 80 });
const description = trimmedAsSent({ maxLength: 500 });
const category = trimmedAsSent({ maxLength: 40 });

export const CreateRealmBody = v.object({
  slug: Slug,
  name,
  description: v.optional(description),
  category: v.optional(category),
  modules: v.optional(modules, []),
});
export type CreateRealmBody = v.InferOutput<typeof CreateRealmBody>;

export const ProposeRealmBody = v.object({
  ...CreateRealmBody.entries,
  rationale: trimmedAsSent({ minLength: 40, maxLength: 1000 }),
});

export const UpdateRealmBody = v.pipe(
  v.object({
    name: v.optional(name),
    description: v.optional(v.nullable(description)),
    category: v.optional(v.nullable(category)),
    modules: v.optional(modules),
  }),
  v.check((edit) => Object.keys(edit).length > 0, "Provide at least one field to update."),
);
export type RealmEdit = v.InferOutput<typeof UpdateRealmBody>;

export const RejectProposalBody = v.object({
  note: trimmedAsSent({ minLength: 4, maxLength: 500 }),
});

export const RoleBody = v.object({ role: oneOf(RealmRole) });

/** `?archived=true` (or none) retires, `?archived=false` restores; any other value is refused. */
export const ArchiveQuery = v.object({
  archived: v.pipe(
    v.optional(v.union([v.boolean(), v.picklist(["true", "false"])]), true),
    v.transform((value) => value === true || value === "true"),
  ),
});

/** The permission names clients see, e.g. `realm.post_job`. */
const WIRE_NAME = {
  post: "realm.post",
  postJob: "realm.post_job",
  postEvent: "realm.post_event",
  participate: "realm.participate",
  moderate: "realm.moderate",
  vouch: "realm.vouch",
  administer: "realm.administer",
} as const;

/** What the caller may do in a realm, as the realm context answers it. */
export type RealmPermissions = Record<keyof typeof WIRE_NAME, boolean>;

/** A realm as the directory lists it. */
export interface RealmSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  memberCount: number;
  modules: number[];
}

export interface Member {
  userId: string;
  role: number;
  displayName: string | null;
  name: string;
  image: string | null;
  joinedAt: Temporal.Instant;
}

export interface Proposal {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  modules: number[];
  rationale: string;
  proposedBy: { id: string; name: string; email: string };
  status: number;
  decisionNote: string | null;
  decidedAt: Temporal.Instant | null;
  realmId: string | null;
  createdAt: Temporal.Instant;
}

export const RealmSummaryView = v.object({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  description: v.nullable(v.string()),
  category: v.nullable(v.string()),
  memberCount: v.pipe(v.number(), v.integer()),
  modules: v.array(oneOf(RealmModule)),
});

export const FoundedView = v.object({ id: v.string(), slug: v.string() });

/** The caller's place in a realm: their rank, and what it lets them do. */
export const StandingView = v.object({
  role: v.nullable(oneOf(RealmRole)),
  permissions: v.array(oneOf(WIRE_NAME)),
});

export const MemberView = v.object({
  userId: v.string(),
  role: oneOf(RealmRole),
  displayName: v.nullable(v.string()),
  name: v.string(),
  image: v.nullable(v.string()),
  joinedAt: Timestamp,
});

export const ProposalView = v.object({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  description: v.nullable(v.string()),
  category: v.nullable(v.string()),
  modules: v.array(oneOf(RealmModule)),
  rationale: v.string(),
  proposedBy: v.nullable(v.object({ id: v.string(), name: v.string(), email: v.string() })),
  status: oneOf(ProposalStatus),
  decisionNote: v.nullable(v.string()),
  decidedAt: v.nullable(Timestamp),
  realmId: v.nullable(v.string()),
  createdAt: Timestamp,
});

export const JoinedView = v.object({ joined: v.literal(true) });
export const LeftView = v.object({ left: v.literal(true) });
export const EditedView = v.object({ changed: v.array(v.string()) });
export const ArchivedView = v.object({ archived: v.boolean() });
export const RoleChangedView = v.object({ userId: v.string(), role: oneOf(RealmRole) });
export const ApprovedView = v.object({ realmId: v.string() });
export const RejectedView = v.object({ id: v.string() });

const moduleList = (values: number[]) => values.map((value) => narrow(RealmModule, value));

export const presentRealmSummary = (r: RealmSummary): v.InferInput<typeof RealmSummaryView> => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  category: r.category,
  memberCount: r.memberCount,
  modules: moduleList(r.modules),
});

export const presentStanding = (
  role: RealmRole | null,
  permissions: RealmPermissions,
): v.InferInput<typeof StandingView> => ({
  role,
  permissions: (Object.keys(WIRE_NAME) as (keyof RealmPermissions)[])
    .filter((permission) => permissions[permission])
    .map((permission) => WIRE_NAME[permission]),
});

export const presentMember = (m: Member): v.InferInput<typeof MemberView> => ({
  userId: m.userId,
  role: narrow(RealmRole, m.role),
  displayName: m.displayName,
  name: m.name,
  image: m.image,
  joinedAt: iso(m.joinedAt),
});

export const presentProposal = (p: Proposal): v.InferInput<typeof ProposalView> => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  description: p.description,
  category: p.category,
  modules: moduleList(p.modules),
  rationale: p.rationale,
  proposedBy: { id: p.proposedBy.id, name: p.proposedBy.name, email: p.proposedBy.email },
  status: narrow(ProposalStatus, p.status),
  decisionNote: p.decisionNote,
  decidedAt: isoOrNull(p.decidedAt),
  realmId: p.realmId,
  createdAt: iso(p.createdAt),
});
