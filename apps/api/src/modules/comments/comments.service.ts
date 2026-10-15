import { type CommentEntry, realmEvents } from "@akashic/contracts";
import { and, asc, eq } from "drizzle-orm";
import {
  comments,
  events,
  type Executor,
  inTransaction,
  jobs,
  listings,
  publish,
  user,
} from "@akashic/db";
import { CommentSubject } from "@akashic/lib/enums";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok, type Result } from "@akashic/lib/result";
import { fromDate, toDate } from "@akashic/lib/time";
import type { CommentsDeps, PostedComment, RemovedComment, Subject } from "./comments.types.ts";

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
): Promise<boolean | undefined> {
  const table = subjectTable[subject.kind];
  const [row] = await db
    .select({ open: table.commentsEnabled })
    .from(table)
    .where(and(eq(table.id, subject.id), eq(table.realmId, realmId)))
    .limit(1);
  return row?.open;
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
    body: row.removedAt ? "" : row.body,
    removed: row.removedAt !== null,
    createdAt: fromDate(row.createdAt),
  }));
}

const noSubject = () => fail.notFound(ErrorCode.event.notFound, "No such thing in this realm.");

export function createCommentService(deps: CommentsDeps) {
  const { db, clock } = deps;

  return {
    /** The thread under a posting of this realm; a posting of another realm is not found. */
    async thread(realmId: string, subject: Subject): Promise<Result<CommentEntry[]>> {
      if ((await threadOpen(db, realmId, subject)) === undefined) return err(noSubject());
      return ok(await listThread(db, subject, THREAD_LIMIT));
    },

    async add(
      realmId: string,
      subject: Subject,
      authorId: string,
      body: string,
    ): Promise<Result<PostedComment>> {
      const open = await threadOpen(db, realmId, subject);
      if (open === undefined) return err(noSubject());
      if (!open)
        return err(fail.forbidden(ErrorCode.realm.forbidden, "Comments are off for this."));

      return inTransaction(db, async (tx) => {
        const [created] = await tx
          .insert(comments)
          .values({ realmId, subjectKind: subject.kind, subjectId: subject.id, authorId, body })
          .returning({ id: comments.id });
        if (!created) throw new Error("comment insert returned no row");
        await publish(
          tx,
          [realmEvents.postingCreated("comment", { postingId: created.id, realmId, authorId })],
          clock.now(),
        );
        return ok({ id: created.id });
      });
    },

    /** Soft delete: the comment keeps its place in the thread. */
    async remove(realmId: string, commentId: string): Promise<Result<RemovedComment>> {
      const removed = await db
        .update(comments)
        .set({ removedAt: toDate(clock.now()) })
        .where(and(eq(comments.id, commentId), eq(comments.realmId, realmId)))
        .returning({ id: comments.id });
      if (removed.length === 0) {
        return err(fail.notFound(ErrorCode.event.notFound, "No such comment in this realm."));
      }
      return ok({ removed: true as const });
    },
  };
}

export type CommentService = ReturnType<typeof createCommentService>;
