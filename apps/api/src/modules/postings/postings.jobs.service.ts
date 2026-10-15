import { and, desc, eq } from "drizzle-orm";
import type { Job, JobSummary } from "@akashic/contracts";
import { type Executor, inTransaction, jobs, user } from "@akashic/db";
import { CommentSubject, JobStatus } from "@akashic/lib/enums";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok, type Result } from "@akashic/lib/result";
import { fromDate, toDate } from "@akashic/lib/time";
import { hasOpenInterest, requireMember, settleInterest } from "./postings.interest.service.ts";
import type {
  Hired,
  JobForViewer,
  JobStatusSet,
  NewJob,
  Posted,
  PostingAreaDeps,
} from "./postings.types.ts";

const noJob = () => fail.notFound(ErrorCode.event.notFound, "No such posting in this realm.");
const settled = () =>
  fail.conflict(ErrorCode.event.alreadySettled, "This posting is no longer available.");

/** One job of the realm; undefined for another realm's. */
async function findJob(db: Executor, realmId: string, jobId: string): Promise<Job | undefined> {
  const [row] = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      description: jobs.description,
      type: jobs.type,
      budgetCents: jobs.budgetCents,
      currency: jobs.currency,
      status: jobs.status,
      hiringFlow: jobs.hiringFlow,
      hiredUserId: jobs.hiredUserId,
      commentsEnabled: jobs.commentsEnabled,
      authorId: jobs.authorId,
      authorName: user.name,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .innerJoin(user, eq(user.id, jobs.authorId))
    .where(and(eq(jobs.id, jobId), eq(jobs.realmId, realmId)))
    .limit(1);
  return row && { ...row, createdAt: fromDate(row.createdAt) };
}

/** Jobs: the board, a posting, its status, and hiring. */
export function createJobService(deps: PostingAreaDeps) {
  const { db, clock, fit } = deps;

  return {
    /** A realm's jobs, newest first. */
    async browse(realmId: string, openOnly: boolean, limit: number): Promise<JobSummary[]> {
      const rows = await db
        .select({
          id: jobs.id,
          title: jobs.title,
          type: jobs.type,
          budgetCents: jobs.budgetCents,
          currency: jobs.currency,
          status: jobs.status,
          createdAt: jobs.createdAt,
        })
        .from(jobs)
        .where(
          and(eq(jobs.realmId, realmId), openOnly ? eq(jobs.status, JobStatus.open) : undefined),
        )
        .orderBy(desc(jobs.createdAt))
        .limit(limit);
      return rows.map((row) => ({ ...row, createdAt: fromDate(row.createdAt) }));
    },

    async read(realmId: string, jobId: string, viewerId: string): Promise<Result<JobForViewer>> {
      const job = await findJob(db, realmId, jobId);
      if (!job) return err(noJob());
      const subject = { kind: CommentSubject.job, id: jobId };
      return ok({ ...job, viewerInterested: await hasOpenInterest(db, subject, viewerId) });
    },

    post: (job: NewJob): Promise<Result<Posted>> =>
      fit.admit({ ...job, type: "job", kind: CommentSubject.job }, async (tx) => {
        const [created] = await tx.insert(jobs).values(job).returning({ id: jobs.id });
        if (!created) throw new Error("job insert returned no row");
        return created.id;
      }),

    async setStatus(
      realmId: string,
      jobId: string,
      status: JobStatus,
    ): Promise<Result<JobStatusSet>> {
      const updated = await db
        .update(jobs)
        .set({ status, updatedAt: toDate(clock.now()) })
        .where(and(eq(jobs.id, jobId), eq(jobs.realmId, realmId)))
        .returning({ id: jobs.id });
      return updated.length > 0 ? ok({ status }) : err(noJob());
    },

    /** Hires one applicant: fills the job and settles every other application. */
    async hire(
      realmId: string,
      jobId: string,
      actorId: string,
      hiredUserId: string,
    ): Promise<Result<Hired>> {
      const job = await findJob(db, realmId, jobId);
      if (!job) return err(noJob());
      if (job.authorId !== actorId) {
        return err(
          fail.forbidden(ErrorCode.realm.forbidden, "Only the person who posted it can hire."),
        );
      }
      if (job.status !== JobStatus.open) return err(settled());
      const member = await requireMember(db, realmId, hiredUserId);
      if (!member.ok) return member;
      const subject = { kind: CommentSubject.job, id: jobId };
      if (!(await hasOpenInterest(db, subject, hiredUserId))) {
        return err(
          fail.validation(
            ErrorCode.common.validation,
            "That person has not applied, or has withdrawn.",
          ),
        );
      }

      return inTransaction(db, async (tx) => {
        // Only an open job fills: of two hires at once, the second finds it filled and settles
        // nothing.
        const filled = await tx
          .update(jobs)
          .set({
            status: JobStatus.filled,
            hiredUserId,
            hiredAt: toDate(clock.now()),
            updatedAt: toDate(clock.now()),
          })
          .where(
            and(eq(jobs.id, jobId), eq(jobs.realmId, realmId), eq(jobs.status, JobStatus.open)),
          )
          .returning({ id: jobs.id });
        if (filled.length === 0) return err(settled());
        await settleInterest(tx, subject, hiredUserId);
        return ok({ hiredUserId });
      });
    },
  };
}
