/**
 * Every deliberate failure is an AppError with a `kind` and a stable `code`. A service says what
 * went wrong; `httpStatusByKind` alone decides which HTTP status that becomes.
 */
export type ErrorKind =
	| 'validation'
	| 'not_found'
	| 'conflict'
	| 'unauthorized'
	| 'forbidden'
	| 'rate_limited'
	| 'external'
	| 'unavailable'
	| 'internal';

/** Client-facing codes. Add freely; never rename, clients switch on them. */
const base = {
	auth: {
		unauthenticated: 'auth.session.unauthenticated',
		sessionExpired: 'auth.session.expired',
		banned: 'auth.account.suspended',
	},
	common: {
		validation: 'common.request.validation_failed',
		cancelled: 'common.request.cancelled',
		rateLimited: 'common.request.rate_limited',
		payloadTooLarge: 'common.request.payload_too_large',
		timeout: 'common.request.timeout',
		unexpected: 'common.server.unexpected',
		forbidden: 'common.auth.forbidden',
		routeNotFound: 'common.route.not_found',
		unavailable: 'common.request.unavailable',
	},
	external: {
		aiUnavailable: 'external.ai.unavailable',
		aiNotConfigured: 'external.ai.not_configured',
		resendDeliveryFailed: 'external.resend.delivery_failed',
	},
} as const;

export interface ErrorOptions {
	details?: Record<string, unknown>;
	cause?: unknown;
}

export class AppError extends Error {
	readonly kind: ErrorKind;
	readonly code: string;
	/** Shown to the client, so never anything secret. */
	readonly details?: Readonly<Record<string, unknown>>;

	constructor(kind: ErrorKind, code: string, message: string, options: ErrorOptions = {}) {
		super(message, { cause: options.cause });
		this.name = 'AppError';
		this.kind = kind;
		this.code = code;
		if (options.details) this.details = options.details;
	}
}

/** Stable, client-facing codes. Clients switch on these; never rename one. */
export const ErrorCode = {
	...base,
	external: {
		...base.external,
		authzUnavailable: 'external.authz.unavailable',
		storageNotConfigured: 'external.storage.not_configured',
	},
	realm: {
		notFound: 'realm.not_found',
		forbidden: 'realm.forbidden',
		alreadyMember: 'realm.already_member',
		notMember: 'realm.not_member',
		duplicateSlug: 'realm.duplicate_slug',
		soleAdmin: 'realm.sole_admin',
		moduleDisabled: 'realm.module_disabled',
		archived: 'realm.archived',
	},
	// Named for events, and used for every posting kind: the strings are already on the wire.
	event: {
		notFound: 'event.not_found',
		alreadySettled: 'posting.already_settled',
		full: 'event.at_capacity',
		past: 'event.already_happened',
	},
} as const;

/**
 * A class for one stable error code. Its kind and code are literal types, so two errors are
 * never confused in a union, and it is an AppError, so the problem renderer handles it as is.
 */
export function defineError<const K extends ErrorKind, const C extends string>(
	kind: K,
	code: C,
	defaultMessage: string,
) {
	return class extends AppError {
		static readonly kind = kind;
		static readonly code = code;
		declare readonly kind: K;
		declare readonly code: C;
		constructor(message: string = defaultMessage, options?: ErrorOptions) {
			super(kind, code, message, options);
		}
	};
}

// One class per code. A code answered with different statuses at different sites gets one class
// per status (realm.not_member), so a union never holds two classes the compiler can't tell apart.

export const Unauthenticated = defineError(
	'unauthorized',
	ErrorCode.auth.unauthenticated,
	'Sign in to access this resource.',
);
export type Unauthenticated = InstanceType<typeof Unauthenticated>;
export const SessionExpired = defineError(
	'unauthorized',
	ErrorCode.auth.sessionExpired,
	'Your session has expired. Sign in again.',
);
export type SessionExpired = InstanceType<typeof SessionExpired>;
export const AccountSuspended = defineError(
	'forbidden',
	ErrorCode.auth.banned,
	'This account is suspended.',
);
export type AccountSuspended = InstanceType<typeof AccountSuspended>;

export const ValidationFailed = defineError(
	'validation',
	ErrorCode.common.validation,
	'Invalid request.',
);
export type ValidationFailed = InstanceType<typeof ValidationFailed>;
/** The 400 answered today for a body or file over its limit (the route-level 413 is another class). */
export const ContentTooLarge = defineError(
	'validation',
	ErrorCode.common.payloadTooLarge,
	'That is larger than allowed.',
);
export type ContentTooLarge = InstanceType<typeof ContentTooLarge>;
// Stopped before it finished, so retrying later can work: the same answer as a shutdown's.
export const RequestCancelled = defineError(
	'unavailable',
	ErrorCode.common.cancelled,
	'The request was cancelled.',
);
export type RequestCancelled = InstanceType<typeof RequestCancelled>;
export const ServiceUnavailable = defineError(
	'unavailable',
	ErrorCode.common.unavailable,
	'The server is shutting down. Try again shortly.',
);
export type ServiceUnavailable = InstanceType<typeof ServiceUnavailable>;
export const RateLimited = defineError(
	'rate_limited',
	ErrorCode.common.rateLimited,
	'Too many requests. Slow down.',
);
export type RateLimited = InstanceType<typeof RateLimited>;
export const RequestTimeout = defineError(
	'external',
	ErrorCode.common.timeout,
	'The request took too long.',
);
export type RequestTimeout = InstanceType<typeof RequestTimeout>;
export const UnexpectedError = defineError(
	'internal',
	ErrorCode.common.unexpected,
	'Unexpected error',
);
export type UnexpectedError = InstanceType<typeof UnexpectedError>;
export const Forbidden = defineError(
	'forbidden',
	ErrorCode.common.forbidden,
	'You do not have permission to do that.',
);
export type Forbidden = InstanceType<typeof Forbidden>;
export const RouteNotFound = defineError(
	'not_found',
	ErrorCode.common.routeNotFound,
	'No such route.',
);
export type RouteNotFound = InstanceType<typeof RouteNotFound>;

export const AiUnavailable = defineError(
	'external',
	ErrorCode.external.aiUnavailable,
	'The AI service is unavailable.',
);
export type AiUnavailable = InstanceType<typeof AiUnavailable>;
export const AiNotConfigured = defineError(
	'external',
	ErrorCode.external.aiNotConfigured,
	'This deployment has no AI service configured.',
);
export type AiNotConfigured = InstanceType<typeof AiNotConfigured>;
export const DeliveryFailed = defineError(
	'external',
	ErrorCode.external.resendDeliveryFailed,
	'The email could not be delivered.',
);
export type DeliveryFailed = InstanceType<typeof DeliveryFailed>;
export const AuthzUnavailable = defineError(
	'external',
	ErrorCode.external.authzUnavailable,
	'Could not check your permissions just now.',
);
export type AuthzUnavailable = InstanceType<typeof AuthzUnavailable>;
export const StorageNotConfigured = defineError(
	'external',
	ErrorCode.external.storageNotConfigured,
	'This deployment stores no uploads. Paste an image URL instead.',
);
export type StorageNotConfigured = InstanceType<typeof StorageNotConfigured>;

export const RealmNotFound = defineError('not_found', ErrorCode.realm.notFound, 'No such realm.');
export type RealmNotFound = InstanceType<typeof RealmNotFound>;
export const RealmForbidden = defineError(
	'forbidden',
	ErrorCode.realm.forbidden,
	'You cannot do that in this realm.',
);
export type RealmForbidden = InstanceType<typeof RealmForbidden>;
export const AlreadyMember = defineError(
	'conflict',
	ErrorCode.realm.alreadyMember,
	'You are already in this realm.',
);
export type AlreadyMember = InstanceType<typeof AlreadyMember>;
/** realm.not_member as a 404: the person (or, for room keys, their device keys) isn't there. */
export const MemberNotFound = defineError(
	'not_found',
	ErrorCode.realm.notMember,
	'That person is not in this realm.',
);
export type MemberNotFound = InstanceType<typeof MemberNotFound>;
/** realm.not_member as a 400: a seat named for someone who holds none, or can't be given one. */
export const NoSeatInRealm = defineError(
	'validation',
	ErrorCode.realm.notMember,
	'They do not hold a seat in this realm.',
);
export type NoSeatInRealm = InstanceType<typeof NoSeatInRealm>;
/** realm.not_member as a 403: a room needs both people in the posting's realm. */
export const NotBothMembers = defineError(
	'forbidden',
	ErrorCode.realm.notMember,
	'Both people have to be in the realm the posting belongs to.',
);
export type NotBothMembers = InstanceType<typeof NotBothMembers>;
export const DuplicateSlug = defineError(
	'conflict',
	ErrorCode.realm.duplicateSlug,
	'That name is already taken.',
);
export type DuplicateSlug = InstanceType<typeof DuplicateSlug>;
export const SoleAdmin = defineError(
	'conflict',
	ErrorCode.realm.soleAdmin,
	"This is the realm's only admin. Promote someone else first.",
);
export type SoleAdmin = InstanceType<typeof SoleAdmin>;
/** A 404, not a 403: a realm that doesn't run a module looks like it has no such route. */
export const ModuleDisabled = defineError(
	'not_found',
	ErrorCode.realm.moduleDisabled,
	'This realm does not run that.',
);
export type ModuleDisabled = InstanceType<typeof ModuleDisabled>;
export const RealmArchived = defineError(
	'conflict',
	ErrorCode.realm.archived,
	'This realm has been retired. Its contents are readable, but nothing new can be posted.',
);
export type RealmArchived = InstanceType<typeof RealmArchived>;

// The event.* codes cover every posting kind; the strings are already on the wire.
export const EventNotFound = defineError(
	'not_found',
	ErrorCode.event.notFound,
	'No such posting in this realm.',
);
export type EventNotFound = InstanceType<typeof EventNotFound>;
export const PostingSettled = defineError(
	'conflict',
	ErrorCode.event.alreadySettled,
	'That has already been settled.',
);
export type PostingSettled = InstanceType<typeof PostingSettled>;
export const EventFull = defineError('conflict', ErrorCode.event.full, 'This event is full.');
export type EventFull = InstanceType<typeof EventFull>;
export const EventInPast = defineError(
	'validation',
	ErrorCode.event.past,
	'An event cannot start in the past.',
);
export type EventInPast = InstanceType<typeof EventInPast>;
