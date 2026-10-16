// The authorization model's vocabulary (authz/model.fga) and the port that answers it.

export const FgaType = {
	user: 'user',
	platform: 'platform',
	realm: 'realm',
	job: 'job',
	listing: 'listing',
	event: 'event',
	comment: 'comment',
} as const;
export type FgaType = (typeof FgaType)[keyof typeof FgaType];

/** The single platform object; platform admins are `admin` on it. */
export const PLATFORM_ID = 'akashic';

export const Relation = {
	platform: { administer: 'can_administer' },
	realm: {
		post: 'can_post',
		postJob: 'can_post_job',
		postEvent: 'can_post_event',
		participate: 'can_participate',
		moderate: 'can_moderate',
		vouch: 'can_vouch',
		administer: 'can_administer',
	},
	posting: { view: 'can_view', edit: 'can_edit', delete: 'can_delete', settle: 'can_settle' },
	event: { rsvp: 'can_rsvp' },
	comment: { delete: 'can_delete' },
} as const;

/** The relation for each RealmRole, indexed by its value. */
export const RANK_RELATION = ['member', 'verified', 'moderator', 'admin'] as const;

export interface Check {
	userId: string;
	relation: string;
	type: FgaType;
	objectId: string;
}

export type Subject = { userId: string } | { type: FgaType; objectId: string };

export interface Tuple {
	subject: Subject;
	relation: string;
	type: FgaType;
	objectId: string;
}

/**
 * Throws an `external` AppError when the authorization service can't answer. Each call stops
 * waiting once `signal` aborts, rejecting with the signal's reason rather than an AppError: being
 * told to stop is not the service failing.
 */
export interface Authorizer {
	check(check: Check, signal?: AbortSignal): Promise<boolean>;
	/** Answers in the order asked. */
	checkMany(checks: readonly Check[], signal?: AbortSignal): Promise<boolean[]>;
	/** Idempotent: duplicate writes and missing deletes are ignored. */
	write(
		changes: { writes?: readonly Tuple[]; deletes?: readonly Tuple[] },
		signal?: AbortSignal,
	): Promise<void>;
	/** Object ids of `type` the user has `relation` on. */
	listObjects(
		userId: string,
		relation: string,
		type: FgaType,
		signal?: AbortSignal,
	): Promise<string[]>;
}
