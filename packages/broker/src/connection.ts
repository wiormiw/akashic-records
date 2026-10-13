import { Connection } from "rabbitmq-client";
import type { Logger } from "@akashic/lib/log";

/** One AMQP connection per process; publishers and consumers open their channels on it. */
export interface Broker {
  readonly connection: Connection;
  /**
   * Waits for the first connection, at most `timeoutMs`. Never fails startup on an unreachable
   * broker: the client keeps reconnecting, and the outbox holds events until it is back.
   */
  connect(timeoutMs?: number): Promise<boolean>;
  /** For readiness. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createBroker(options: { url: string; name: string; logger: Logger }): Broker {
  const log = options.logger.child({ component: "rabbitmq" });
  const connection = new Connection({
    url: options.url,
    connectionName: options.name,
    retryLow: 1000,
    retryHigh: 30_000,
  });
  connection.on("error", (err) => log.warn({ err }, "broker connection error, reconnecting"));
  connection.on("connection", () => log.info("broker connected"));

  return {
    connection,
    async connect(timeoutMs = 3000) {
      try {
        // Without disableAutoClose, a timeout here would close the connection for good.
        await connection.onConnect(timeoutMs, true);
        return true;
      } catch (err) {
        log.warn({ err }, "broker not reachable at startup; will keep trying");
        return false;
      }
    },
    ping: async () => connection.ready,
    close: () => connection.close(),
  };
}
