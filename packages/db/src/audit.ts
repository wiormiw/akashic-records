import type { AuditAction } from "@akashic/lib/enums";
import { currentTraceparent } from "@akashic/lib/tracing";
import type { Tx } from "./client.ts";
import { auditEntries } from "./schema/index.ts";

export interface AuditEntry {
  /** Null for changes the system made on its own, such as an election result. */
  actorId: string | null;
  entityType: string;
  entityId: string;
  action: AuditAction;
  changes?: Record<string, unknown>;
}

/** Records audit entries in the caller's transaction, so they commit with the change. */
export async function audit(tx: Tx, ...entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const traceId = currentTraceparent() ?? null;
  await tx.insert(auditEntries).values(
    entries.map(({ actorId, changes, ...entry }) => ({
      ...entry,
      userId: actorId,
      changes: changes ?? null,
      traceId,
    })),
  );
}
