import * as v from "valibot";
import { iso, Timestamp, trimmedAsSent } from "./common.ts";

// The comments API contract. (Services hold a Temporal.Instant; the presenter renders it.)

export const CommentBody = v.object({ body: trimmedAsSent({ minLength: 1, maxLength: 2000 }) });

/** A comment as the service holds it. A removed one has an empty body. */
export interface CommentEntry {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  authorImage: string | null;
  removed: boolean;
  createdAt: Temporal.Instant;
}

/** A removed comment keeps its place in the thread, with its words gone. */
export const CommentView = v.object({
  id: v.string(),
  body: v.string(),
  authorId: v.string(),
  authorName: v.string(),
  authorImage: v.nullable(v.string()),
  removed: v.boolean(),
  createdAt: Timestamp,
});

export const RemovedView = v.object({ removed: v.literal(true) });

export function presentComment(comment: CommentEntry): v.InferInput<typeof CommentView> {
  return {
    id: comment.id,
    body: comment.body,
    authorId: comment.authorId,
    authorName: comment.authorName,
    authorImage: comment.authorImage,
    removed: comment.removed,
    createdAt: iso(comment.createdAt),
  };
}
