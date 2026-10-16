import type { MiddlewareHandler } from 'hono';
import type { Authorizer } from '@akashic/authz';
import type { RealmEnv } from '@/http/realm-context.ts';
import type { CommentService } from './comments.service.ts';
import type { Executor } from '@akashic/db';
import type { CommentSubject } from '@akashic/lib/enums';
import type { Clock } from '@akashic/lib/time';

export interface CommentsDeps {
	db: Executor;
	clock: Clock;
}

/** The posting a thread hangs under. */
export interface Subject {
	kind: CommentSubject;
	id: string;
}

/** A posted comment's id. */
export interface PostedComment {
	id: string;
}

/** Confirms a comment was soft-deleted. */
export interface RemovedComment {
	removed: true;
}

/** What the comments routes are built from. */
export interface CommentsRoutesDeps {
	comments: CommentService;
	realmContext: MiddlewareHandler<RealmEnv>;
	/** Asks who may delete a comment: its author, or a moderator of its realm. */
	authorizer: Authorizer;
}

/** What the comments module is built from: just what its routes need. */
export type CommentsModuleDeps = CommentsRoutesDeps;
