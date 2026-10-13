import * as v from "valibot";
import { createBroker, createOutboxStore, deadCount, Queues, replayDead } from "@akashic/broker";
import { createDb } from "@akashic/db";
import { loadEnv, url } from "@akashic/lib/config";
import { createLogger } from "@akashic/lib/log";

// Puts dead events back in line, once whatever killed them has been fixed: outbox events that
// never reached the broker, and messages a consumer parked in its .dead queue. Lists what it
// would do unless given --apply.
//
//   bun run events:replay            what is dead, and why
//   bun run events:replay --apply    replay all of it

const LIMIT = 1000;
// Every queue a module consumes from; one today.
const QUEUES = [Queues.authzSync];

if (import.meta.main) {
  const env = loadEnv(v.object({ DATABASE_URL: url(), RABBITMQ_URL: url() }), Bun.env);
  const apply = Bun.argv.includes("--apply");
  const logger = createLogger({ level: "warn", service: "akashic-replay", environment: "script" });
  const database = createDb({
    url: env.DATABASE_URL,
    poolMax: 2,
    idleTimeoutS: 30,
    connectTimeoutS: 10,
    logger,
  });
  const store = createOutboxStore(database.db);
  const broker = createBroker({ url: env.RABBITMQ_URL, name: "akashic-replay", logger });

  try {
    const dead = await store.dead(LIMIT);
    console.log(`outbox: ${dead.length} dead event(s)`);
    for (const event of dead.slice(0, 20)) {
      console.log(
        `  ${event.id}  ${event.eventType}  ${event.attemptCount} attempts: ${event.lastError}`,
      );
    }

    const reachable = await broker.connect(5000);
    if (!reachable) console.log("broker: not reachable, so its dead queues were not checked");
    const queues = reachable ? QUEUES : [];
    for (const queue of queues) {
      console.log(`queue ${queue}.dead: ${await deadCount(broker, queue)} message(s)`);
    }

    if (!apply) {
      console.log("dry run: nothing changed. Run again with --apply to replay.");
    } else {
      const revived = await store.reviveDead(Temporal.Now.instant(), LIMIT);
      console.log(
        `outbox: revived ${revived.length}; the dispatcher publishes them on its next poll`,
      );
      for (const queue of queues) {
        console.log(`queue ${queue}: replayed ${await replayDead(broker, queue, LIMIT)}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await broker.close();
    await database[Symbol.asyncDispose]();
  }
}
