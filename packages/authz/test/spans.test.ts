import { beforeEach, expect, test } from "bun:test";
import { silentLogger } from "@akashic/lib/log";
import { FgaType, Relation, createAuthorizer } from "@akashic/authz";
import { recordSpans } from "@akashic/lib/testing";

const recorder = recordSpans();
beforeEach(() => recorder.reset());

test("each OpenFGA call is a span named for the operation", async () => {
  const authorizer = createAuthorizer({
    apiUrl: "http://127.0.0.1:9",
    storeId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
    timeoutMs: 50,
    logger: silentLogger(),
  });
  await expect(
    authorizer.check({
      userId: "u1",
      relation: Relation.realm.post,
      type: FgaType.realm,
      objectId: "r1",
    }),
  ).rejects.toThrow();
  const span = recorder.spans().find((s) => s.name === "authz.check");
  expect(span?.attributes["akashic.fga.relation"]).toBe("can_post");
});
