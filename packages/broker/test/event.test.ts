import { describe, expect, test } from "bun:test";
import { OutboxStatus, newOutboxEvent } from "@akashic/db";
import { claimUntil, isClaimedUntil, markPublished, recordFailure, revive } from "../src/event.ts";

const t0 = Temporal.Instant.from("2026-06-01T00:00:00Z");
const later = (seconds: number) => t0.add({ seconds });
const fresh = () => newOutboxEvent({ type: "realm.created", payload: { realmId: "r1" } }, t0);

describe("outbox event", () => {
  test("starts pending, unattempted and due at once", () => {
    expect(fresh()).toMatchObject({
      eventType: "realm.created",
      status: OutboxStatus.pending,
      attemptCount: 0,
      nextAttemptAt: t0,
      createdAt: t0,
      publishedAt: null,
      lastError: null,
    });
  });

  test("a claim leases it until the deadline, and only that claim holds it", () => {
    const claimed = claimUntil(fresh(), later(30));
    expect(isClaimedUntil(claimed, later(30))).toBe(true);
    expect(isClaimedUntil(claimed, later(31))).toBe(false);
    expect(isClaimedUntil(markPublished(claimed, later(1)), later(30))).toBe(false);
  });

  test("only a pending event can be claimed", () => {
    const published = markPublished(fresh(), later(1));
    expect(() => claimUntil(published, later(30))).toThrow("only a pending outbox event");
    const dead = recordFailure(fresh(), later(1), "gone", true);
    expect(() => claimUntil(dead, later(30))).toThrow("only a pending outbox event");
  });

  test("publishing records when and clears the last failure", () => {
    const retried = recordFailure(fresh(), later(2), "timeout", false);
    expect(markPublished(retried, later(5))).toMatchObject({
      status: OutboxStatus.published,
      publishedAt: later(5),
      lastError: null,
      attemptCount: 1,
    });
  });

  test("a failure counts an attempt and schedules a retry, or gives up when exhausted", () => {
    const retry = recordFailure(fresh(), later(2), "timeout", false);
    expect(retry).toMatchObject({
      status: OutboxStatus.pending,
      attemptCount: 1,
      nextAttemptAt: later(2),
      lastError: "timeout",
    });
    expect(recordFailure(retry, later(4), "timeout", true)).toMatchObject({
      status: OutboxStatus.dead,
      attemptCount: 2,
    });
  });

  test("an error is kept to 500 characters, and a blank one still says something", () => {
    expect(recordFailure(fresh(), t0, "x".repeat(600), false).lastError).toHaveLength(500);
    expect(recordFailure(fresh(), t0, "  ", false).lastError).toBe("Unknown publish failure");
    expect(recordFailure(fresh(), t0, undefined, false).lastError).toBe("Unknown publish failure");
  });

  test("a dead event revives with a full set of attempts, keeping why it died", () => {
    const dead = recordFailure(fresh(), later(10), "openfga down", true);
    expect(revive(dead, later(60))).toMatchObject({
      status: OutboxStatus.pending,
      attemptCount: 0,
      nextAttemptAt: later(60),
      lastError: "openfga down",
    });
  });

  test("only a dead event can be revived", () => {
    expect(() => revive(fresh(), later(1))).toThrow("only a dead outbox event");
    expect(() => revive(markPublished(fresh(), later(1)), later(2))).toThrow(
      "only a dead outbox event",
    );
  });
});
