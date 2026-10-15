import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb, jobs } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import { InterestStatus, JobStatus, JobType } from "@akashic/lib/enums";
import { silentLogger } from "@akashic/lib/log";
import { expectErr, expectOk } from "@akashic/lib/testing";
import { toDate } from "@akashic/lib/time";
import { clock, databaseUrl } from "../../support/fixtures.ts";
import { world } from "./fixtures.ts";

// The jobs service on the real database, each test in a transaction that is rolled back.

const database = createDb({
  url: databaseUrl,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const inWorld = (run: (w: ReturnType<typeof world>) => Promise<void>) =>
  withRollback(database.db, (tx) => run(world(tx)));

describe.skipIf(!live)("the job board", () => {
  test("lists a realm's jobs newest first, open only unless asked, within the limit", () =>
    inWorld(async (w) => {
      const realm = await w.realm();
      const elsewhere = await w.realm();
      const first = await w.seed(realm.id, realm.admin);
      const second = await w.seed(realm.id, realm.admin);
      await w.seed(elsewhere.id, elsewhere.admin);
      // Within one transaction now() is fixed: date the first an hour back to order them.
      await w.tx
        .update(jobs)
        .set({ createdAt: new Date(Date.now() - 3_600_000) })
        .where(eq(jobs.id, first.job.id));
      expectOk(await w.jobs.setStatus(realm.id, second.job.id, JobStatus.closed));

      expect((await w.jobs.browse(realm.id, true, 20)).map((j) => j.id)).toEqual([first.job.id]);
      expect((await w.jobs.browse(realm.id, false, 20)).map((j) => j.id)).toEqual([
        second.job.id,
        first.job.id,
      ]);
      expect(await w.jobs.browse(realm.id, false, 1)).toHaveLength(1);
    }));

  test("reads a job with its author and whether the viewer applied", () =>
    inWorld(async (w) => {
      const realm = await w.realm({ members: 1 });
      const { job } = await w.seed(realm.id, realm.admin);
      const reader = realm.people[0]!;
      expect(expectOk(await w.jobs.read(realm.id, job.id, reader))).toMatchObject({
        id: job.id,
        authorId: realm.admin,
        authorName: "Founder",
        type: JobType.commission,
        status: JobStatus.open,
        viewerInterested: false,
      });
      expectOk(await w.interest.show(realm.id, job, reader, undefined));
      expect(expectOk(await w.jobs.read(realm.id, job.id, reader)).viewerInterested).toBe(true);
    }));

  test("a job of another realm is not found to read or to change, and stays as it was", () =>
    inWorld(async (w) => {
      const realm = await w.realm();
      const elsewhere = await w.realm();
      const { job } = await w.seed(elsewhere.id, elsewhere.admin);
      expectErr(await w.jobs.read(realm.id, job.id, realm.admin), "event.not_found");
      expectErr(await w.jobs.setStatus(realm.id, job.id, JobStatus.closed), "event.not_found");
      expect((await w.job(job.id))?.status).toBe(JobStatus.open);
    }));
});

describe.skipIf(!live)("hiring", () => {
  /** A job by the founder, with two members who applied. */
  async function ready(w: ReturnType<typeof world>) {
    const realm = await w.realm({ members: 2 });
    const { job } = await w.seed(realm.id, realm.admin);
    const [chosen, other] = realm.people as [string, string];
    expectOk(await w.interest.show(realm.id, job, chosen, "Me!"));
    expectOk(await w.interest.show(realm.id, job, other, undefined));
    return { realm, job, chosen, other };
  }

  test("the author hires an applicant; every other application is settled, and only once", () =>
    inWorld(async (w) => {
      const { realm, job, chosen, other } = await ready(w);
      expect(expectOk(await w.jobs.hire(realm.id, job.id, realm.admin, chosen))).toEqual({
        hiredUserId: chosen,
      });
      expect(await w.job(job.id)).toMatchObject({
        status: JobStatus.filled,
        hiredUserId: chosen,
        hiredAt: toDate(clock.now()),
        updatedAt: toDate(clock.now()),
      });
      expect(await w.interestOf(job.id, chosen)).toBe(InterestStatus.accepted);
      expect(await w.interestOf(job.id, other)).toBe(InterestStatus.declined);
      expectErr(await w.jobs.hire(realm.id, job.id, realm.admin, other), "posting.already_settled");
    }));

  test("each way it is refused", () =>
    inWorld(async (w) => {
      const { realm, job, chosen, other } = await ready(w);
      const outsider = await w.person("Outsider");
      expectErr(
        await w.jobs.hire(realm.id, Bun.randomUUIDv7(), realm.admin, chosen),
        "event.not_found",
      );
      expectErr(await w.jobs.hire(realm.id, job.id, other, chosen), "realm.forbidden");
      expectErr(await w.jobs.hire(realm.id, job.id, realm.admin, outsider), "realm.not_member");
      expectOk(await w.interest.drop(realm.id, job, chosen));
      expectErr(
        await w.jobs.hire(realm.id, job.id, realm.admin, chosen),
        "common.request.validation_failed",
      );
      expectOk(await w.jobs.setStatus(realm.id, job.id, JobStatus.closed));
      expectErr(await w.jobs.hire(realm.id, job.id, realm.admin, other), "posting.already_settled");
      // Nobody was settled by any refusal.
      expect(await w.interestOf(job.id, other)).toBe(InterestStatus.open);
    }));

  test("a job of another realm can't be hired for from here", () =>
    inWorld(async (w) => {
      const { realm, job, chosen } = await ready(w);
      const here = await w.realm();
      expectErr(await w.jobs.hire(here.id, job.id, realm.admin, chosen), "event.not_found");
      expect((await w.job(job.id))?.status).toBe(JobStatus.open);
      expect(await w.interestOf(job.id, chosen)).toBe(InterestStatus.open);
    }));
});
