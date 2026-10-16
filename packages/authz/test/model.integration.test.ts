import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenFgaClient, type AuthorizationModel } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import { silentLogger } from "@akashic/lib/log";
import { FgaType, PLATFORM_ID, Relation, createAuthorizer, type Authorizer } from "@akashic/authz";

// model.fga against a real OpenFGA, in a throwaway store. Skips when none is listening.

const API_URL = Bun.env.FGA_API_URL ?? "http://localhost:8080";
const available = await fetch(`${API_URL}/stores`, { signal: AbortSignal.timeout(1500) })
  .then((response) => response.ok)
  .catch(() => false);

const ADMIN = "00000000-0000-0000-0000-00000000000a";
const MODERATOR = "00000000-0000-0000-0000-00000000000b";
const VOUCHED = "00000000-0000-0000-0000-00000000000c";
const MEMBER = "00000000-0000-0000-0000-00000000000d";
const OUTSIDER = "00000000-0000-0000-0000-00000000000e";
const PLATFORM_ADMIN = "00000000-0000-0000-0000-0000000000aa";
const REALM = "00000000-0000-0000-0000-0000000000f0";
const JOB = "00000000-0000-0000-0000-0000000000f1";
const COMMENT = "00000000-0000-0000-0000-0000000000f2";

describe.skipIf(!available)("the authorization model", () => {
  let client: OpenFgaClient;
  let authz: Authorizer;

  beforeAll(async () => {
    const model = transformer.transformDSLToJSONObject(
      await Bun.file(new URL("../model.fga", import.meta.url).pathname).text(),
    ) as unknown as AuthorizationModel;
    const store = await new OpenFgaClient({ apiUrl: API_URL }).createStore({
      name: `model-test-${Date.now()}`,
    });
    client = new OpenFgaClient({ apiUrl: API_URL, storeId: store.id });
    const { authorization_model_id } = await client.writeAuthorizationModel(model);
    authz = createAuthorizer({
      apiUrl: API_URL,
      storeId: store.id,
      modelId: authorization_model_id,
      timeoutMs: 5000,
      logger: silentLogger(),
    });

    const rank = (userId: string, relation: string) => ({
      subject: { userId },
      relation,
      type: FgaType.realm,
      objectId: REALM,
    });
    await authz.write({
      writes: [
        rank(ADMIN, "admin"),
        rank(MODERATOR, "moderator"),
        rank(VOUCHED, "verified"),
        rank(MEMBER, "member"),
        { subject: { userId: VOUCHED }, relation: "author", type: FgaType.job, objectId: JOB },
        {
          subject: { type: FgaType.realm, objectId: REALM },
          relation: "realm",
          type: FgaType.job,
          objectId: JOB,
        },
        {
          subject: { userId: MEMBER },
          relation: "author",
          type: FgaType.comment,
          objectId: COMMENT,
        },
        {
          subject: { type: FgaType.realm, objectId: REALM },
          relation: "realm",
          type: FgaType.comment,
          objectId: COMMENT,
        },
      ],
    });
  });

  afterAll(async () => {
    if (client) await client.deleteStore();
  });

  const inRealm = (userId: string, relation: string) =>
    authz.check({ userId, relation, type: FgaType.realm, objectId: REALM });
  const onJob = (userId: string, relation: string) =>
    authz.check({ userId, relation, type: FgaType.job, objectId: JOB });

  test("any member may post; only the vouched and staff may post jobs and events", async () => {
    for (const who of [MEMBER, VOUCHED, MODERATOR, ADMIN])
      expect(await inRealm(who, Relation.realm.post)).toBe(true);
    expect(await inRealm(MEMBER, Relation.realm.postJob)).toBe(false);
    expect(await inRealm(MEMBER, Relation.realm.postEvent)).toBe(false);
    for (const who of [VOUCHED, MODERATOR, ADMIN])
      expect(await inRealm(who, Relation.realm.postJob)).toBe(true);
  });

  test("an outsider may do nothing", async () => {
    const answers = await authz.checkMany(
      Object.values(Relation.realm).map((relation) => ({
        userId: OUTSIDER,
        relation,
        type: FgaType.realm,
        objectId: REALM,
      })),
    );
    expect(answers.every((allowed) => !allowed)).toBe(true);
  });

  test("a vouch grants posting and nothing adjacent to it", async () => {
    expect(await inRealm(VOUCHED, Relation.realm.moderate)).toBe(false);
    expect(await inRealm(VOUCHED, Relation.realm.vouch)).toBe(false);
    expect(await inRealm(VOUCHED, Relation.realm.administer)).toBe(false);
    expect(await inRealm(MODERATOR, Relation.realm.vouch)).toBe(true);
  });

  test("a posting's permissions follow it to its realm; settling is the author's alone", async () => {
    expect(await onJob(VOUCHED, Relation.posting.edit)).toBe(true);
    expect(await onJob(MODERATOR, Relation.posting.edit)).toBe(true);
    expect(await onJob(MEMBER, Relation.posting.edit)).toBe(false);
    expect(await onJob(VOUCHED, Relation.posting.settle)).toBe(true);
    expect(await onJob(MODERATOR, Relation.posting.settle)).toBe(false);
    expect(await onJob(ADMIN, Relation.posting.settle)).toBe(false);
  });

  test("a comment is deleted by its author or the realm's moderators, nobody else", async () => {
    const onComment = (userId: string) =>
      authz.check({
        userId,
        relation: Relation.comment.delete,
        type: FgaType.comment,
        objectId: COMMENT,
      });
    for (const who of [MEMBER, MODERATOR, ADMIN]) expect(await onComment(who)).toBe(true);
    for (const who of [VOUCHED, OUTSIDER]) expect(await onComment(who)).toBe(false);
  });

  test("platform admins hold nothing in a realm until it is linked to the platform", async () => {
    await authz.write({
      writes: [
        {
          subject: { userId: PLATFORM_ADMIN },
          relation: "admin",
          type: FgaType.platform,
          objectId: PLATFORM_ID,
        },
      ],
    });
    expect(await inRealm(PLATFORM_ADMIN, Relation.realm.moderate)).toBe(false);

    await authz.write({
      writes: [
        {
          subject: { type: FgaType.platform, objectId: PLATFORM_ID },
          relation: "platform",
          type: FgaType.realm,
          objectId: REALM,
        },
      ],
    });
    expect(await inRealm(PLATFORM_ADMIN, Relation.realm.moderate)).toBe(true);
    expect(await inRealm(PLATFORM_ADMIN, Relation.realm.postJob)).toBe(true);
  });

  test("writing the same tuple twice, or deleting a missing one, is harmless", async () => {
    const tuple = {
      subject: { userId: MEMBER },
      relation: "member",
      type: FgaType.realm,
      objectId: REALM,
    };
    await authz.write({ writes: [tuple] });
    await authz.write({ deletes: [{ ...tuple, subject: { userId: OUTSIDER } }] });
    expect(await inRealm(MEMBER, Relation.realm.post)).toBe(true);
  });
});
