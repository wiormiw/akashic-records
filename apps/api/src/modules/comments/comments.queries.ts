import { and, asc, eq } from "drizzle-orm";
import { comments, events, type Executor, jobs, listings, user } from "@akashic/db";
import { CommentSubject } from "@akashic/lib/enums";
import { fromDate } from "@akashic/lib/time";

export interface Subject {
  kind: CommentSubject;
  id: string;
}

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
export async function threadOpen(
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
export async function listThread(db: Executor, subject: Subject, limit: number) {
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
