import type { CommentEntry } from '@akashic/contracts';
import { realmEvents } from '@akashic/contracts/events';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
	audit,
	comments,
	events,
	type Executor,
	inTransaction,
	jobs,
	listings,
	publish,
	user,
} from '@akashic/db';
import { first, one } from '@akashic/db/sql';
import { AuditAction, CommentSubject } from '@akashic/lib/enums';
import { EventNotFound, RealmForbidden } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { fromDate, toDate } from '@akashic/lib/time';
import type {
	AddCommentError,
	CommentsDeps,
	PostedComment,
	RemoveCommentError,
	RemovedComment,
	Subject,
	ThreadError,
} from './comments.types.ts';

const THREAD_LIMIT = 200;

// The table that holds each kind of commentable posting.
const subjectTable = {
	[CommentSubject.event]: events,
	[CommentSubject.listing]: listings,
	[CommentSubject.job]: jobs,
};

/**
 * Whether the thread under a posting accepts comments. Undefined when the posting doesn't exist
 * in the realm, so a posting of another realm is indistinguishable from none.
 */
async function threadOpen(
	db: Executor,
	realmId: string,
	subject: Subject,
	lock = false,
): Promise<boolean | undefined> {
	const table = subjectTable[subject.kind];
	const query = db
		.select({ open: table.commentsEnabled })
		.from(table)
		.where(and(eq(table.id, subject.id), eq(table.realmId, realmId)));
	// FOR SHARE: a concurrent switch-off (an UPDATE) waits for this comment, or this waits for it.
	return first(await (lock ? query.for('share') : query))?.open;
}

/** A thread oldest first, with each author's name and picture. */
async function listThread(db: Executor, subject: Subject, limit: number): Promise<CommentEntry[]> {
	const rows = await db
		.select({
			id: comments.id,
			body: comments.body,
			authorId: comments.authorId,
			authorName: user.name,
			authorImage: user.image,
			removedAt: comments.removedAt,
			createdAt: comments.createdAt,
		})
		.from(comments)
		.innerJoin(user, eq(user.id, comments.authorId))
		.where(and(eq(comments.subjectKind, subject.kind), eq(comments.subjectId, subject.id)))
		.orderBy(asc(comments.createdAt))
		.limit(limit);
	return rows.map((row) => ({
		id: row.id,
		authorId: row.authorId,
		authorName: row.authorName,
		authorImage: row.authorImage,
		// A removed comment keeps its place but not its words.
		body: row.removedAt ? '' : row.body,
		removed: row.removedAt !== null,
		createdAt: fromDate(row.createdAt),
	}));
}

const noSubject = () => new EventNotFound('No such thing in this realm.');

export function createCommentService(deps: CommentsDeps) {
	const { db, clock } = deps;

	return {
		/** The thread under a posting of this realm; a posting of another realm is not found. */
		async thread(realmId: string, subject: Subject): Promise<Result<CommentEntry[], ThreadError>> {
			if ((await threadOpen(db, realmId, subject)) === undefined) return err(noSubject());
			return ok(await listThread(db, subject, THREAD_LIMIT));
		},

		async add(
			realmId: string,
			subject: Subject,
			authorId: string,
			body: string,
		): Promise<Result<PostedComment, AddCommentError>> {
			return inTransaction(db, async (tx) => {
				// Checked under the posting's lock, so turning comments off can't slip past it.
				const open = await threadOpen(tx, realmId, subject, true);
				if (open === undefined) return err(noSubject());
				if (!open) return err(new RealmForbidden('Comments are off for this.'));
				const created = one(
					await tx
						.insert(comments)
						.values({ realmId, subjectKind: subject.kind, subjectId: subject.id, authorId, body })
						.returning({ id: comments.id }),
					'comment insert',
				);
				await publish(
					tx,
					[realmEvents.postingCreated('comment', { postingId: created.id, realmId, authorId })],
					clock.now(),
				);
				return ok({ id: created.id });
			});
		},

		/**
		 * Soft delete: the comment keeps its place in the thread. The route has checked the actor may
		 * (its author, or a moderator); a moderator removing someone else's is recorded.
		 */
		remove(
			realmId: string,
			commentId: string,
			actorId: string,
		): Promise<Result<RemovedComment, RemoveCommentError>> {
			return inTransaction(db, async (tx) => {
				const ofRealm = and(eq(comments.id, commentId), eq(comments.realmId, realmId));
				// Only a comment still standing: removing it again keeps the first removal's time
				// and record.
				const removed = first(
					await tx
						.update(comments)
						.set({ removedAt: toDate(clock.now()) })
						.where(and(ofRealm, isNull(comments.removedAt)))
						.returning({ authorId: comments.authorId }),
				);
				if (!removed) {
					const exists =
						(
							await tx
								.select({ one: sql`1` })
								.from(comments)
								.where(ofRealm)
								.limit(1)
						).length > 0;
					return exists
						? ok({ removed: true as const })
						: err(new EventNotFound('No such comment in this realm.'));
				}
				if (removed.authorId !== actorId) {
					await audit(tx, {
						actorId,
						entityType: 'comment',
						entityId: commentId,
						action: AuditAction.deleted,
						changes: { by: 'moderator' },
					});
				}
				return ok({ removed: true as const });
			});
		},
	};
}
