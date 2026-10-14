import { describe, expect, test } from "bun:test";
import type { Authorizer, Tuple } from "@akashic/authz";
import { realmEvents } from "@akashic/contracts";
import { RealmRole } from "@akashic/lib/enums";
import { silentLogger } from "@akashic/lib/log";
import { createRealmConsumer } from "@/modules/realm/realm.consumer.ts";
import { createRealmModule } from "@/modules/realm/realm.module.ts";

/** An in-memory tuple store behind the Authorizer interface. */
function memoryAuthorizer() {
  const tuples = new Set<string>();
  const signals: (AbortSignal | undefined)[] = [];
  const key = (t: Tuple) =>
    `${"userId" in t.subject ? `user:${t.subject.userId}` : `${t.subject.type}:${t.subject.objectId}`} ${t.relation} ${t.type}:${t.objectId}`;

  const authorizer: Authorizer = {
    check: async () => false,
    checkMany: async (checks) => checks.map(() => false),
    async write({ writes = [], deletes = [] }, signal) {
      signals.push(signal);
      const written = new Set(writes.map(key));
      for (const tuple of deletes) if (!written.has(key(tuple))) tuples.delete(key(tuple));
      for (const tuple of writes) tuples.add(key(tuple));
    },
    listObjects: async () => [],
  };
  return { authorizer, tuples, signals };
}

const signal = new AbortController().signal;
const meta = { messageId: "evt-1", attempt: 1 };

describe("realm consumer", () => {
  test("the module consumes akashic.authz-sync for the three realm events", () => {
    const module = createRealmModule({
      realms: {} as never,
      sessions: {} as never,
      realmContext: (async () => {}) as never,
      authorizer: memoryAuthorizer().authorizer,
      logger: silentLogger(),
    });
    expect(module.consumer?.queue).toBe("akashic.authz-sync");
    expect(Object.keys(module.consumer?.handlers ?? {}).sort()).toEqual([
      "realm.created",
      "realm.member_changed",
      "realm.posting_created",
    ]);
  });

  test("a new realm belongs to the platform", async () => {
    const { authorizer, tuples } = memoryAuthorizer();
    const handlers = createRealmConsumer({ authorizer, logger: silentLogger() });
    const event = realmEvents.created("r1");
    await handlers[event.type]?.(event.payload, signal, meta);
    expect([...tuples]).toEqual(["platform:akashic platform realm:r1"]);
  });

  test("a membership change leaves exactly the current rank, however often it runs", async () => {
    const { authorizer, tuples } = memoryAuthorizer();
    const handlers = createRealmConsumer({ authorizer, logger: silentLogger() });
    const deliver = (event: ReturnType<typeof realmEvents.memberChanged>) =>
      handlers[event.type]?.(event.payload, signal, meta);

    await deliver(realmEvents.memberChanged("r1", "u1", RealmRole.member));
    await deliver(realmEvents.memberChanged("r1", "u1", RealmRole.moderator));
    await deliver(realmEvents.memberChanged("r1", "u1", RealmRole.moderator));
    expect([...tuples]).toEqual(["user:u1 moderator realm:r1"]);

    await deliver(realmEvents.memberChanged("r1", "u1", null));
    expect(tuples.size).toBe(0);
  });

  test("a posting is linked to its author and its realm", async () => {
    const { authorizer, tuples } = memoryAuthorizer();
    const handlers = createRealmConsumer({ authorizer, logger: silentLogger() });
    const event = realmEvents.postingCreated("job", {
      postingId: "j1",
      realmId: "r1",
      authorId: "u1",
    });

    await handlers[event.type]?.(event.payload, signal, meta);
    expect([...tuples].sort()).toEqual(["realm:r1 realm job:j1", "user:u1 author job:j1"]);
  });

  test("every write carries the handler's signal, so its deadline reaches OpenFGA", async () => {
    const { authorizer, signals } = memoryAuthorizer();
    const handlers = createRealmConsumer({ authorizer, logger: silentLogger() });
    for (const event of [
      realmEvents.created("r1"),
      realmEvents.memberChanged("r1", "u1", RealmRole.member),
      realmEvents.postingCreated("job", { postingId: "j1", realmId: "r1", authorId: "u1" }),
    ]) {
      await handlers[event.type]?.(event.payload, signal, meta);
    }
    expect(signals).toEqual([signal, signal, signal]);
  });

  test("a malformed payload fails loudly, so the outbox retries and then parks it", async () => {
    const { authorizer } = memoryAuthorizer();
    const handlers = createRealmConsumer({ authorizer, logger: silentLogger() });
    await expect(
      handlers["realm.member_changed"]!({ realmId: "r1" }, signal, meta),
    ).rejects.toThrow("malformed");
  });

  test("every event a publisher can build passes the schema its consumer checks", async () => {
    const { authorizer } = memoryAuthorizer();
    const handlers = createRealmConsumer({ authorizer, logger: silentLogger() });
    for (const event of [
      realmEvents.created("r1"),
      realmEvents.memberChanged("r1", "u1", RealmRole.moderator),
      realmEvents.memberChanged("r1", "u1", null),
      realmEvents.postingCreated("listing", { postingId: "l1", realmId: "r1", authorId: "u1" }),
    ]) {
      await expect(handlers[event.type]!(event.payload, signal, meta)).resolves.toBeUndefined();
    }
  });

  test("a payload off its contract is refused, naming what is wrong", async () => {
    const { authorizer, signals } = memoryAuthorizer();
    const handlers = createRealmConsumer({ authorizer, logger: silentLogger() });
    await expect(handlers["realm.created"]!({ realmId: "" }, signal, meta)).rejects.toThrow(
      "(realmId:",
    );
    await expect(
      handlers["realm.member_changed"]!(
        { realmId: "r1", userId: "u1", role: "admin" },
        signal,
        meta,
      ),
    ).rejects.toThrow("(role:");
    await expect(
      handlers["realm.posting_created"]!(
        { kind: "meme", postingId: "p1", realmId: "r1", authorId: "u1" },
        signal,
        meta,
      ),
    ).rejects.toThrow("(kind:");
    // Nothing reached OpenFGA from any of them.
    expect(signals).toEqual([]);
  });

  test("a rank the model doesn't know is refused", async () => {
    const { authorizer, signals } = memoryAuthorizer();
    const handlers = createRealmConsumer({ authorizer, logger: silentLogger() });
    await expect(
      handlers["realm.member_changed"]!({ realmId: "r1", userId: "u1", role: 9 }, signal, meta),
    ).rejects.toThrow("no relation");
    expect(signals).toEqual([]);
  });
});
