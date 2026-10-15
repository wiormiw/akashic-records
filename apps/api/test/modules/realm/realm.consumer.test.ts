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

/** The realm_member rows the consumer reads: `${realmId} ${userId}` to role. */
function memberRows(initial: Record<string, RealmRole> = {}) {
  const rows = new Map<string, RealmRole>(Object.entries(initial));
  const realms = {
    memberRole: async (realmId: string, userId: string) => rows.get(`${realmId} ${userId}`) ?? null,
  };
  return { realms, rows };
}

/** A consumer over the given authorizer and member rows (none by default). */
const consumer = (authorizer: Authorizer, realms = memberRows().realms) =>
  createRealmConsumer({ realms, authorizer, logger: silentLogger() });

const signal = new AbortController().signal;
const meta = { messageId: "evt-1", attempt: 1 };

describe("realm consumer", () => {
  test("the module consumes akashic.authz-sync for the three realm events", () => {
    const module = createRealmModule({
      realms: memberRows().realms as never,
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
    const handlers = consumer(authorizer);
    const event = realmEvents.created("r1");
    await handlers[event.type]?.(event.payload, signal, meta);
    expect([...tuples]).toEqual(["platform:akashic platform realm:r1"]);
  });

  test("a membership change leaves exactly the current rank, however often it runs", async () => {
    const { authorizer, tuples } = memoryAuthorizer();
    const { realms, rows } = memberRows();
    const handlers = consumer(authorizer, realms);
    const deliver = (event: ReturnType<typeof realmEvents.memberChanged>) =>
      handlers[event.type]?.(event.payload, signal, meta);

    rows.set("r1 u1", RealmRole.member);
    await deliver(realmEvents.memberChanged("r1", "u1", RealmRole.member));
    rows.set("r1 u1", RealmRole.moderator);
    await deliver(realmEvents.memberChanged("r1", "u1", RealmRole.moderator));
    await deliver(realmEvents.memberChanged("r1", "u1", RealmRole.moderator));
    expect([...tuples]).toEqual(["user:u1 moderator realm:r1"]);

    rows.delete("r1 u1");
    await deliver(realmEvents.memberChanged("r1", "u1", null));
    expect(tuples.size).toBe(0);
  });

  test("a stale member_changed writes the row as it is now, not the payload's role", async () => {
    const writes: Tuple[] = [];
    const deletes: Tuple[] = [];
    const recording: Authorizer = {
      ...memoryAuthorizer().authorizer,
      async write(change) {
        writes.push(...(change.writes ?? []));
        deletes.push(...(change.deletes ?? []));
      },
    };
    // The join's event, retried after the leave already removed the row.
    const handlers = consumer(recording, memberRows().realms);
    const stale = realmEvents.memberChanged("r1", "u1", RealmRole.member);
    await handlers[stale.type]?.(stale.payload, signal, meta);
    expect(writes).toEqual([]);
    expect(deletes.map((t) => t.relation)).toContain("member");

    // And a stale demotion can't undo a newer promotion.
    writes.length = 0;
    const promoted = consumer(recording, memberRows({ "r1 u1": RealmRole.moderator }).realms);
    const demotion = realmEvents.memberChanged("r1", "u1", RealmRole.member);
    await promoted[demotion.type]?.(demotion.payload, signal, meta);
    expect(writes.map((t) => t.relation)).toEqual(["moderator"]);
  });

  test("a posting is linked to its author and its realm", async () => {
    const { authorizer, tuples } = memoryAuthorizer();
    const handlers = consumer(authorizer);
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
    const handlers = consumer(authorizer);
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
    const handlers = consumer(authorizer);
    await expect(
      handlers["realm.member_changed"]!({ realmId: "r1" }, signal, meta),
    ).rejects.toThrow("malformed");
  });

  test("every event a publisher can build passes the schema its consumer checks", async () => {
    const { authorizer } = memoryAuthorizer();
    const handlers = consumer(authorizer);
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
    const handlers = consumer(authorizer);
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
    const handlers = consumer(authorizer, memberRows({ "r1 u1": 9 as RealmRole }).realms);
    await expect(
      handlers["realm.member_changed"]!({ realmId: "r1", userId: "u1", role: 9 }, signal, meta),
    ).rejects.toThrow("no relation");
    expect(signals).toEqual([]);
  });
});
