import { type CommentEntry, realmEvents } from "@akashic/contracts";
import { comments, type Executor, inTransaction, publish } from "@akashic/db";
import { and, eq } from "drizzle-orm";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok, type Result } from "@akashic/lib/result";
import type { Clock } from "@akashic/lib/time";
import { listThread, type Subject, threadOpen } from "./comments.queries.ts";

const THREAD_LIMIT = 200;

export interface CommentsDeps {
  db: Executor;
  clock: Clock;
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
    ): Promise<Result<{ id: string }>> {
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
    async remove(realmId: string, commentId: string): Promise<Result<{ removed: true }>> {
      const removed = await db
        .update(comments)
        .set({ removedAt: new Date() })
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
