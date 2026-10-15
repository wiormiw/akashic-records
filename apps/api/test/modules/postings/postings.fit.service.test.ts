import { afterAll, describe, expect, test } from "bun:test";
import { createDb } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import { JobStatus, JobType, ListingStatus } from "@akashic/lib/enums";
import { silentLogger } from "@akashic/lib/log";
import { expectErr, expectOk } from "@akashic/lib/testing";
import type { Embedder } from "@/integrations/embedder.ts";
import {
  cosineDistance,
  judge,
  nudge,
  stillLearning,
} from "@/modules/postings/postings.fit.service.ts";
import type { NewJob } from "@/modules/postings/postings.types.ts";
import { databaseUrl } from "../../support/fixtures.ts";
import { BELONGS, CENTROID, closeTo, embedderOf, FAR, UNCERTAIN, vec, world } from "./fixtures.ts";

// The fit rules alone, then the fit service on the real database in a rolled-back transaction:
// posting judged against the realm's centroid, and a moderator's call on the review queue.

const database = createDb({
  url: databaseUrl,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const inWorld = (run: (w: ReturnType<typeof world>) => Promise<void>, embedder?: Embedder) =>
  withRollback(database.db, (tx) => run(world(tx, embedder)));

describe("realm fit rules", () => {
  test("distance is 0 for the same direction, 1 at right angles, 2 for a zero vector", () => {
    expect(cosineDistance([1, 0], [2, 0])).toBeCloseTo(0, 10);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 10);
    expect(cosineDistance([0, 0], [0, 0])).toBe(2);
  });

  test("close belongs; far is refused only once the realm has learned; between is uncertain", () => {
    expect(judge(0.1, 0)).toBe("belongs");
    expect(judge(0.18, 30)).toBe("uncertain");
    expect(judge(0.9, 30)).toBe("doesNotBelong");
    expect(judge(0.9, 3)).toBe("uncertain");
    expect(stillLearning(24)).toBe(true);
    expect(stillLearning(25)).toBe(false);
  });

  test("a nudge moves the centroid a little towards the posting and keeps it unit length", () => {
    const moved = nudge([1, 0], [0, 1]);
    expect(Math.hypot(...moved)).toBeCloseTo(1, 10);
    expect(moved[1]!).toBeGreaterThan(0);
    expect(moved[0]!).toBeGreaterThan(moved[1]!);
  });
});

const job = (realmId: string, authorId: string): NewJob => ({
  realmId,
  authorId,
  title: "Draw a banner",
  description: "For the summer meet.",
  type: JobType.commission,
  currency: "IDR",
});

describe.skipIf(!live)("posting, judged for fit", () => {
  test("a realm with no centroid takes anything, and learns nothing", () =>
    inWorld(async (w) => {
      const realm = await w.realm();
      expectOk(await w.jobs.post(job(realm.id, realm.admin)));
      expect(await w.queue(realm.id)).toEqual([]);
      expect(await w.centroid(realm.id)).toEqual({ centroid: null, samples: 0 });
    }, embedderOf(FAR)));

  test("a young realm takes even a far posting, and moves its centroid towards it", () =>
    inWorld(async (w) => {
      const realm = await w.realm({ centroid: CENTROID, samples: 3 });
      expectOk(await w.jobs.post(job(realm.id, realm.admin)));
      const taught = await w.centroid(realm.id);
      expect(closeTo(taught.centroid, nudge(CENTROID, FAR))).toBe(true);
      expect(taught.samples).toBe(4);
      expect(await w.queue(realm.id)).toEqual([]);
    }, embedderOf(FAR)));

  test("a realm that has learned refuses a far posting, storing and announcing nothing", () =>
    inWorld(async (w) => {
      const realm = await w.realm({ centroid: CENTROID, samples: 30 });
      expectErr(await w.jobs.post(job(realm.id, realm.admin)), "common.request.validation_failed");
      expect(await w.jobsIn(realm.id)).toEqual([]);
      expect(await w.outbox("realm.posting_created", realm.id)).toEqual([]);
      expect(await w.queue(realm.id)).toEqual([]);
    }, embedderOf(FAR)));

  test("an uncertain posting is stored, then queued for a moderator under its new id", () =>
    inWorld(async (w) => {
      const realm = await w.realm({ centroid: CENTROID, samples: 30 });
      const { id } = expectOk(await w.jobs.post(job(realm.id, realm.admin)));
      const queued = await w.queue(realm.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ subjectId: id, kept: null });
      expect(queued[0]!.distance).toBeCloseTo(0.18, 5);
      // Not a young realm, so not taught either.
      expect((await w.centroid(realm.id)).samples).toBe(30);

      // Listings go through the same check.
      const listing = expectOk(
        await w.listings.post({
          realmId: realm.id,
          sellerId: realm.admin,
          title: "Print",
          description: "An A4 print.",
          priceCents: 1500,
          currency: "IDR",
        }),
      );
      expect((await w.queue(realm.id)).map((entry) => entry.subjectId)).toContain(listing.id);
    }, embedderOf(UNCERTAIN)));

  test("a posting that clearly belongs is stored and neither queued nor taught", () =>
    inWorld(async (w) => {
      const realm = await w.realm({ centroid: CENTROID, samples: 30 });
      expectOk(await w.jobs.post(job(realm.id, realm.admin)));
      expect(await w.queue(realm.id)).toEqual([]);
      expect((await w.centroid(realm.id)).samples).toBe(30);
    }, embedderOf(BELONGS)));

  test("without a model, the fit check steps aside", () =>
    inWorld(async (w) => {
      const realm = await w.realm({ centroid: CENTROID, samples: 30 });
      expectOk(await w.jobs.post(job(realm.id, realm.admin)));
      expect(await w.queue(realm.id)).toEqual([]);
    }, embedderOf(null)));

  test("a stored posting is announced, with who posted it where", () =>
    inWorld(async (w) => {
      const realm = await w.realm();
      const { id } = expectOk(await w.jobs.post(job(realm.id, realm.admin)));
      expect(await w.outbox("realm.posting_created", realm.id)).toEqual([
        { payload: { kind: "job", postingId: id, realmId: realm.id, authorId: realm.admin } },
      ]);
    }));
});

const POSTING = vec(0, 1);

describe.skipIf(!live)("fit review", () => {
  test("the queue shows a realm's undecided entries only", () =>
    inWorld(async (w) => {
      const realm = await w.realm();
      const elsewhere = await w.realm();
      const { job: mine } = await w.seed(realm.id, realm.admin);
      const { job: theirs } = await w.seed(elsewhere.id, elsewhere.admin);
      const entry = await w.queued(realm.id, mine, null);
      await w.queued(elsewhere.id, theirs, null);

      expect((await w.fit.reviewQueue(realm.id)).map((r) => r.id)).toEqual([entry]);
      expectOk(await w.fit.decide(realm.id, entry, realm.admin, true));
      expect(await w.fit.reviewQueue(realm.id)).toEqual([]);
    }));

  test("keeping a posting teaches the realm's centroid, and touches nothing else", () =>
    inWorld(async (w) => {
      const realm = await w.realm({ centroid: CENTROID, samples: 3 });
      const { job } = await w.seed(realm.id, realm.admin);
      const entry = await w.queued(realm.id, job, POSTING);

      expect(expectOk(await w.fit.decide(realm.id, entry, realm.admin, true))).toEqual({
        kept: true,
      });
      const learned = await w.centroid(realm.id);
      expect(closeTo(learned.centroid, nudge(CENTROID, POSTING))).toBe(true);
      expect(learned.samples).toBe(4);
      expect((await w.job(job.id))?.status).toBe(JobStatus.open);
      expect((await w.queue(realm.id))[0]).toMatchObject({ kept: true, keptBy: realm.admin });
    }));

  test("there is nothing to learn from without an embedding or a centroid", () =>
    inWorld(async (w) => {
      const taught = await w.realm({ centroid: CENTROID, samples: 3 });
      const { job } = await w.seed(taught.id, taught.admin);
      const bare = await w.queued(taught.id, job, null);
      expectOk(await w.fit.decide(taught.id, bare, taught.admin, true));
      const unchanged = await w.centroid(taught.id);
      expect(closeTo(unchanged.centroid, CENTROID)).toBe(true);
      expect(unchanged.samples).toBe(3);

      const blank = await w.realm();
      const other = await w.seed(blank.id, blank.admin);
      const entry = await w.queued(blank.id, other.job, POSTING);
      expectOk(await w.fit.decide(blank.id, entry, blank.admin, true));
      expect(await w.centroid(blank.id)).toEqual({ centroid: null, samples: 0 });
    }));

  test("rejecting closes a job and removes a listing; an event has nothing to take down", () =>
    inWorld(async (w) => {
      const realm = await w.realm({ centroid: CENTROID, samples: 3 });
      const { job, listing } = await w.seed(realm.id, realm.admin);
      const event = await w.event(realm.id, realm.admin);

      const forJob = await w.queued(realm.id, job, POSTING);
      expectOk(await w.fit.decide(realm.id, forJob, realm.admin, false));
      expect((await w.job(job.id))?.status).toBe(JobStatus.closed);

      const forListing = await w.queued(realm.id, listing, null);
      expectOk(await w.fit.decide(realm.id, forListing, realm.admin, false));
      expect((await w.listing(listing.id))?.status).toBe(ListingStatus.removed);

      const forEvent = await w.queued(realm.id, event, null);
      expectOk(await w.fit.decide(realm.id, forEvent, realm.admin, false));
      const centroid = await w.centroid(realm.id);
      expect(closeTo(centroid.centroid, CENTROID)).toBe(true);
      expect(centroid.samples).toBe(3);
    }));

  test("an entry already decided, never there, or of another realm is a 404", () =>
    inWorld(async (w) => {
      const realm = await w.realm();
      const elsewhere = await w.realm();
      const { job } = await w.seed(elsewhere.id, elsewhere.admin);
      const entry = await w.queued(elsewhere.id, job, null);

      const missing = expectErr(
        await w.fit.decide(realm.id, Bun.randomUUIDv7(), realm.admin, true),
        "event.not_found",
      );
      expect(missing.kind).toBe("not_found");
      // Another realm's entry is invisible here, and its posting is left alone.
      expectErr(await w.fit.decide(realm.id, entry, realm.admin, false), "event.not_found");
      expect((await w.job(job.id))?.status).toBe(JobStatus.open);
      expect((await w.queue(elsewhere.id))[0]?.kept).toBeNull();

      expectOk(await w.fit.decide(elsewhere.id, entry, elsewhere.admin, true));
      expectErr(await w.fit.decide(elsewhere.id, entry, elsewhere.admin, false), "event.not_found");
      expect((await w.job(job.id))?.status).toBe(JobStatus.open);
    }));
});
