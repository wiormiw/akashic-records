/**
 * Every deliberate failure is an AppError with a `kind` and a stable `code`. A service says what
 * went wrong; `httpStatusByKind` alone decides which HTTP status that becomes.
 */
export type ErrorKind =
  | "validation"
  | "not_found"
  | "conflict"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "external"
  | "internal";

/** Client-facing codes. Add freely; never rename, clients switch on them. */
const base = {
  auth: {
    unauthenticated: "auth.session.unauthenticated",
    sessionExpired: "auth.session.expired",
    banned: "auth.account.suspended",
  },
  common: {
    validation: "common.request.validation_failed",
    cancelled: "common.request.cancelled",
    rateLimited: "common.request.rate_limited",
    payloadTooLarge: "common.request.payload_too_large",
    timeout: "common.request.timeout",
    unexpected: "common.server.unexpected",
    forbidden: "common.auth.forbidden",
    routeNotFound: "common.route.not_found",
  },
  external: {
    aiUnavailable: "external.ai.unavailable",
    aiNotConfigured: "external.ai.not_configured",
    resendDeliveryFailed: "external.resend.delivery_failed",
  },
} as const;

interface ErrorOptions {
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
    this.name = "AppError";
    this.kind = kind;
    this.code = code;
    if (options.details) this.details = options.details;
  }
}

const make = (kind: ErrorKind) => (code: string, message: string, options?: ErrorOptions) =>
  new AppError(kind, code, message, options);

/** `throw fail.conflict(code, message)`: the constructor picks the kind. */
export const fail = {
  validation: make("validation"),
  notFound: make("not_found"),
  conflict: make("conflict"),
  unauthorized: make("unauthorized"),
  forbidden: make("forbidden"),
  rateLimited: make("rate_limited"),
  external: make("external"),
  internal: make("internal"),
} as const;

/** Stable, client-facing codes. Clients switch on these; never rename one. */
export const ErrorCode = {
  ...base,
  external: {
    ...base.external,
    authzUnavailable: "external.authz.unavailable",
    storageNotConfigured: "external.storage.not_configured",
  },
  realm: {
    notFound: "realm.not_found",
    forbidden: "realm.forbidden",
    alreadyMember: "realm.already_member",
    notMember: "realm.not_member",
    duplicateSlug: "realm.duplicate_slug",
    soleAdmin: "realm.sole_admin",
    moduleDisabled: "realm.module_disabled",
    archived: "realm.archived",
  },
  // Named for events, and used for every posting kind: the strings are already on the wire.
  event: {
    notFound: "event.not_found",
    alreadySettled: "posting.already_settled",
    full: "event.at_capacity",
    past: "event.already_happened",
  },
} as const;
