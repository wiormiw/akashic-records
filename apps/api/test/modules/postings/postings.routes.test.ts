import { afterAll, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { FgaType, Relation } from "@akashic/authz";
import { createDb } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import {
  CommentSubject,
  InterestStatus,
  JobStatus,
  JobType,
  ListingStatus,
  RealmModule,
} from "@akashic/lib/enums";
import { silentLogger } from "@akashic/lib/log";
import type { Embedder } from "@/integrations/embedder.ts";
import { postingsApp } from "./app.ts";
import { databaseUrl } from "../../support/fixtures.ts";
import { CENTROID, embedderOf, FAR, UNCERTAIN, Web, world } from "./fixtures.ts";

// Every postings route through app.request, on the real database in a rolled-back transaction:
// each happy path parses with the web app's schema, each group has its refusals, and an id from
// another realm is never acted on through this realm's URL.

const database = createDb({
  url: databaseUrl,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

type Scene = ReturnType<typeof postingsApp> & { w: ReturnType<typeof world> };
const scenario = (run: (s: Scene) => Promise<void>, embedder: Embedder = embedderOf()) =>
  withRollback(database.db, (tx) => run({ ...postingsApp(tx, embedder), w: world(tx, embedder) }));

const { participate, moderate, postJob, post } = Relation.realm;
const { edit, settle } = Relation.posting;

const newJob = { title: "  Draw a banner ", description: "For the meet.", currency: "IDR" };
const newListing = {
  title: "Print",
  description: "An A4 print.",
  priceCents: 1500,
  currency: "IDR",
  imageUrl: "https://example.test/print.png",
};

describe.skipIf(!live)("browsing (public)", () => {
  test("anyone lists jobs and listings, as the web app parses them", () =>
    scenario(async ({ call, w }) => {
      const realm = await w.realm();
      await w.seed(realm.id, realm.admin);

      const jobs = await call("GET", `/api/public/v1/realms/${realm.slug}/jobs?show=all&limit=5`);
      expect(jobs.status).toBe(200);
      expect(v.parse(v.array(Web.JobTeaser), jobs.body)).toMatchObject([
        { title: "Commission", type: JobType.commission, status: JobStatus.open },
      ]);
      const listings = await call("GET", `/api/public/v1/realms/${realm.slug}/listings`);
      expect(listings.status).toBe(200);
      expect(v.parse(v.array(Web.ListingTeaser), listings.body)).toMatchObject([
        { title: "Print", priceCents: 1500, imageUrl: null },
      ]);
    }));

  test("a realm without the module is 404, and a bad query 400", () =>
    scenario(async ({ call, w }) => {
      const realm = await w.realm();
      await w.disable(realm.id, RealmModule.market);
      const off = await call("GET", `/api/public/v1/realms/${realm.slug}/listings`);
      expect(off.status).toBe(404);
      expect(off.body.code).toBe("realm.module_disabled");
      const bad = await call("GET", `/api/public/v1/realms/${realm.slug}/jobs?show=some`);
      expect(bad.status).toBe(400);
    }));
});

describe.skipIf(!live)("jobs", () => {
  test("post (201, id only), read as JobDetail, close, and hire", () =>
    scenario(async ({ call, grant, grantOn, w }) => {
      const realm = await w.realm({ members: 1 });
      const applicant = realm.people[0]!;
      grant(realm.admin, participate, postJob);
      grant(applicant, participate);

      const created = await call("POST", `/api/v1/realms/${realm.slug}/jobs`, {
        as: realm.admin,
        body: newJob,
      });
      expect(created.status).toBe(201);
      expect(Object.keys(created.body)).toEqual(["id"]);
      const path = `/api/v1/realms/${realm.slug}/jobs/${created.body.id}`;

      const read = await call("GET", path, { as: applicant });
      expect(read.status).toBe(200);
      expect(v.parse(Web.JobDetail, read.body)).toMatchObject({
        title: "Draw a banner",
        budgetCents: null,
        hiringFlow: null,
        hiredUserId: null,
        authorName: "Founder",
        viewerInterested: false,
      });

      grantOn(realm.admin, edit, FgaType.job, created.body.id);
      grantOn(realm.admin, settle, FgaType.job, created.body.id);
      const closed = await call("PATCH", path, {
        as: realm.admin,
        body: { status: JobStatus.closed },
      });
      expect(closed.status).toBe(200);
      expect(closed.body).toEqual({ status: JobStatus.closed });
      await call("PATCH", path, { as: realm.admin, body: { status: JobStatus.open } });

      expect(
        (await call("POST", `${path}/interest`, { as: applicant, body: { note: "Me!" } })).status,
      ).toBe(201);
      const hired = await call("POST", `${path}/hire`, {
        as: realm.admin,
        body: { userId: applicant },
      });
      expect(hired.status).toBe(200);
      expect(hired.body).toEqual({ hiredUserId: applicant });
      const again = await call("POST", `${path}/hire`, {
        as: realm.admin,
        body: { userId: applicant },
      });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("posting.already_settled");
    }));

  test("signed out 401, no permission 403, a bad body 400, filled is not a status to set", () =>
    scenario(async ({ call, grant, w }) => {
      const realm = await w.realm({ members: 1 });
      const { job } = await w.seed(realm.id, realm.admin);
      const member = realm.people[0]!;
      const posting = `/api/v1/realms/${realm.slug}/jobs`;

      expect((await call("POST", posting, { body: newJob })).status).toBe(401);
      const forbidden = await call("POST", posting, { as: member, body: newJob });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe("realm.forbidden");
      expect((await call("GET", `${posting}/${job.id}`, { as: member })).status).toBe(403);
      // Without can_edit on the job itself, even the realm's founder is refused.
      const patch = await call("PATCH", `${posting}/${job.id}`, {
        as: realm.admin,
        body: { status: JobStatus.closed },
      });
      expect(patch.status).toBe(403);

      grant(member, postJob);
      const short = await call("POST", posting, { as: member, body: { ...newJob, title: "ab" } });
      expect(short.status).toBe(400);
      expect(short.body.code).toBe("common.request.validation_failed");
      const filled = await call("PATCH", `${posting}/${job.id}`, {
        as: realm.admin,
        body: { status: JobStatus.filled },
      });
      expect(filled.status).toBe(400);
    }));

  test("a far posting in a realm that has learned is refused 400, and nothing is stored", () =>
    scenario(async ({ call, grant, w }) => {
      const realm = await w.realm({ centroid: CENTROID, samples: 30 });
      grant(realm.admin, postJob);
      const refused = await call("POST", `/api/v1/realms/${realm.slug}/jobs`, {
        as: realm.admin,
        body: newJob,
      });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("common.request.validation_failed");
      expect(await w.jobsIn(realm.id)).toEqual([]);
    }, embedderOf(FAR)));

  test("a job of another realm is 404 through this realm's URL, and is left alone", () =>
    scenario(async ({ call, grant, grantOn, w }) => {
      const home = await w.realm();
      const elsewhere = await w.realm({ members: 1 });
      const { job } = await w.seed(elsewhere.id, elsewhere.admin);
      const applicant = elsewhere.people[0]!;
      expect((await w.interest.show(elsewhere.id, job, applicant, undefined)).ok).toBe(true);
      grant(elsewhere.admin, participate);
      grantOn(elsewhere.admin, edit, FgaType.job, job.id);
      grantOn(elsewhere.admin, settle, FgaType.job, job.id);
      // The founder of the other realm is a member here too, so only the realm check stops them.
      await w.join(home.id, elsewhere.admin);
      const path = `/api/v1/realms/${home.slug}/jobs/${job.id}`;

      for (const [method, url, body] of [
        ["GET", path, undefined],
        ["PATCH", path, { status: JobStatus.closed }],
        ["POST", `${path}/hire`, { userId: applicant }],
      ] as const) {
        const answer = await call(method, url, { as: elsewhere.admin, body });
        expect(answer.status).toBe(404);
        expect(answer.body.code).toBe("event.not_found");
      }
      expect((await w.job(job.id))?.status).toBe(JobStatus.open);
      expect(await w.interestOf(job.id, applicant)).toBe(InterestStatus.open);
    }));
});

describe.skipIf(!live)("listings", () => {
  test("post (201), read as ListingDetail, mark sold, and deal", () =>
    scenario(async ({ call, grant, grantOn, w }) => {
      const realm = await w.realm({ members: 1 });
      const buyer = realm.people[0]!;
      grant(realm.admin, participate, post);
      grant(buyer, participate);

      const created = await call("POST", `/api/v1/realms/${realm.slug}/listings`, {
        as: realm.admin,
        body: newListing,
      });
      expect(created.status).toBe(201);
      expect(Object.keys(created.body)).toEqual(["id"]);
      const path = `/api/v1/realms/${realm.slug}/listings/${created.body.id}`;

      const read = await call("GET", path, { as: buyer });
      expect(read.status).toBe(200);
      expect(v.parse(Web.ListingDetail, read.body)).toMatchObject({
        imageUrl: newListing.imageUrl,
        sellerName: "Founder",
        buyerId: null,
        viewerInterested: false,
      });

      await call("POST", `${path}/interest`, { as: buyer, body: {} });
      grantOn(realm.admin, settle, FgaType.listing, created.body.id);
      const dealt = await call("POST", `${path}/deal`, {
        as: realm.admin,
        body: { buyerId: buyer },
      });
      expect(dealt.status).toBe(200);
      expect(dealt.body).toEqual({ buyerId: buyer });
    }));

  test("removing needs moderate (403), the market off is 404, a bad url 400", () =>
    scenario(async ({ call, grant, grantOn, w }) => {
      const realm = await w.realm();
      const { listing } = await w.seed(realm.id, realm.admin);
      const path = `/api/v1/realms/${realm.slug}/listings/${listing.id}`;
      grantOn(realm.admin, edit, FgaType.listing, listing.id);

      const removal = await call("PATCH", path, {
        as: realm.admin,
        body: { status: ListingStatus.removed },
      });
      expect(removal.status).toBe(403);
      expect(removal.body.code).toBe("realm.forbidden");
      const sold = await call("PATCH", path, {
        as: realm.admin,
        body: { status: ListingStatus.sold },
      });
      expect(sold.body).toEqual({ status: ListingStatus.sold });
      grant(realm.admin, moderate, post);
      const removed = await call("PATCH", path, {
        as: realm.admin,
        body: { status: ListingStatus.removed },
      });
      expect(removed.body).toEqual({ status: ListingStatus.removed });

      const bad = await call("POST", `/api/v1/realms/${realm.slug}/listings`, {
        as: realm.admin,
        body: { ...newListing, imageUrl: "not a url" },
      });
      expect(bad.status).toBe(400);
      await w.disable(realm.id, RealmModule.market);
      const off = await call("POST", `/api/v1/realms/${realm.slug}/listings`, {
        as: realm.admin,
        body: newListing,
      });
      expect(off.status).toBe(404);
      expect(off.body.code).toBe("realm.module_disabled");
    }));
});

describe.skipIf(!live)("interest", () => {
  test("show (201), list as the owner parses as Interest, withdraw", () =>
    scenario(async ({ call, grant, w }) => {
      const realm = await w.realm({ members: 1 });
      const { listing } = await w.seed(realm.id, realm.admin);
      const member = realm.people[0]!;
      grant(member, participate);
      grant(realm.admin, participate);
      const path = `/api/v1/realms/${realm.slug}/listings/${listing.id}/interest`;

      const shown = await call("POST", path, { as: member, body: { note: "  Mine? " } });
      expect(shown.status).toBe(201);
      expect(Object.keys(shown.body)).toEqual(["id"]);
      const list = await call("GET", path, { as: realm.admin });
      expect(list.status).toBe(200);
      expect(v.parse(v.array(Web.Interest), list.body)).toMatchObject([
        { userId: member, userName: "Member 0", note: "Mine?", status: InterestStatus.open },
      ]);
      const dropped = await call("DELETE", path, { as: member });
      expect(dropped.status).toBe(200);
      expect(dropped.body).toEqual({ withdrawn: true });
    }));

  test("401 signed out, 403 without participate or for a stranger's list, 400 a bad kind", () =>
    scenario(async ({ call, grant, w }) => {
      const realm = await w.realm({ members: 1 });
      const { job } = await w.seed(realm.id, realm.admin);
      const member = realm.people[0]!;
      const path = `/api/v1/realms/${realm.slug}/jobs/${job.id}/interest`;

      expect((await call("POST", path, { body: {} })).status).toBe(401);
      expect((await call("POST", path, { as: member, body: {} })).status).toBe(403);
      grant(member, participate);
      const list = await call("GET", path, { as: member });
      expect(list.status).toBe(403);
      expect(list.body.code).toBe("realm.forbidden");
      const bad = await call("POST", `/api/v1/realms/${realm.slug}/rooms/${job.id}/interest`, {
        as: member,
        body: {},
      });
      expect(bad.status).toBe(400);
    }));

  test("interest in another realm's posting is 404 to show, list or withdraw", () =>
    scenario(async ({ call, grant, w }) => {
      const home = await w.realm({ members: 1 });
      const elsewhere = await w.realm({ members: 1 });
      const { job } = await w.seed(elsewhere.id, elsewhere.admin);
      const theirs = elsewhere.people[0]!;
      expect((await w.interest.show(elsewhere.id, job, theirs, undefined)).ok).toBe(true);
      grant(theirs, participate, moderate);
      grant(home.people[0]!, participate, moderate);
      const path = `/api/v1/realms/${home.slug}/jobs/${job.id}/interest`;

      for (const [method, as] of [
        ["POST", home.people[0]!],
        ["GET", home.people[0]!],
        ["DELETE", theirs],
      ] as const) {
        // `theirs` is no member here, but the fake grants participate everywhere.
        const answer = await call(method, path, { as, body: method === "POST" ? {} : undefined });
        expect(answer.status).toBe(404);
        expect(answer.body.code).toBe("event.not_found");
      }
      expect(await w.interestOf(job.id, theirs)).toBe(InterestStatus.open);
      expect(await w.interestOf(job.id, home.people[0]!)).toBeUndefined();
    }));
});

describe.skipIf(!live)("the fit review queue", () => {
  test("a moderator lists entries as the web app parses them, and keeps one", () =>
    scenario(async ({ call, grant, w }) => {
      const realm = await w.realm({ centroid: CENTROID, samples: 30 });
      grant(realm.admin, postJob, moderate);
      const created = await call("POST", `/api/v1/realms/${realm.slug}/jobs`, {
        as: realm.admin,
        body: newJob,
      });

      const queue = await call("GET", `/api/v1/realms/${realm.slug}/review`, {
        as: realm.admin,
      });
      expect(queue.status).toBe(200);
      const [entry] = v.parse(v.array(Web.Review), queue.body);
      expect(entry).toMatchObject({ subjectKind: CommentSubject.job, subjectId: created.body.id });

      const kept = await call("POST", `/api/v1/realms/${realm.slug}/review/${entry!.id}`, {
        as: realm.admin,
        body: { kept: true },
      });
      expect(kept.status).toBe(200);
      expect(kept.body).toEqual({ kept: true });
      const again = await call("POST", `/api/v1/realms/${realm.slug}/review/${entry!.id}`, {
        as: realm.admin,
        body: { kept: false },
      });
      expect(again.status).toBe(404);
    }, embedderOf(UNCERTAIN)));

  test("401 signed out, 403 without moderate, 400 a bad decision, 404 another realm's entry", () =>
    scenario(async ({ call, grant, w }) => {
      const home = await w.realm({ members: 1 });
      const elsewhere = await w.realm();
      const { job } = await w.seed(elsewhere.id, elsewhere.admin);
      const entry = await w.queued(elsewhere.id, job, null);
      const member = home.people[0]!;
      const list = `/api/v1/realms/${home.slug}/review`;

      expect((await call("GET", list)).status).toBe(401);
      expect((await call("GET", list, { as: member })).status).toBe(403);
      grant(home.admin, moderate);
      const bad = await call("POST", `${list}/${entry}`, {
        as: home.admin,
        body: { kept: "yes" },
      });
      expect(bad.status).toBe(400);
      const foreign = await call("POST", `${list}/${entry}`, {
        as: home.admin,
        body: { kept: false },
      });
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe("event.not_found");
      expect((await w.job(job.id))?.status).toBe(JobStatus.open);
      expect((await w.queue(elsewhere.id))[0]?.kept).toBeNull();
    }));
});
