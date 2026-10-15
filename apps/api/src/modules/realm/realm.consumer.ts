import * as v from "valibot";
import { FgaType, PLATFORM_ID, RANK_RELATION, type Tuple } from "@akashic/authz";
import type { EventHandler } from "@akashic/broker";
import { type PostingKind, RealmEvent, RealmEventPayload } from "@akashic/contracts";
import type { RealmConsumerDeps } from "./realm.types.ts";

const POSTING_TYPE: Record<PostingKind, FgaType> = {
  job: FgaType.job,
  listing: FgaType.listing,
  event: FgaType.event,
  comment: FgaType.comment,
};

/**
 * The payload as its schema says it is, or an error naming what is wrong. A malformed event fails
 * every retry the same way, so it ends up parked for a person rather than half-applied.
 */
function parse<E extends keyof typeof RealmEventPayload>(event: E, payload: unknown) {
  const result = v.safeParse(RealmEventPayload[event], payload);
  if (result.success) return result.output as RealmEventPayload<E>;
  const [issue] = result.issues;
  const where = issue ? ` (${v.getDotPath(issue) ?? "payload"}: ${issue.message})` : "";
  throw new Error(`${event} is malformed${where}`);
}

/**
 * Keeps OpenFGA in step with Postgres. Each handler writes the complete answer for its event,
 * so a redelivery changes nothing.
 */
export function createRealmConsumer(deps: RealmConsumerDeps): Record<string, EventHandler> {
  const { authorizer } = deps;
  const log = deps.logger.child({ component: "authz-sync" });

  return {
    async [RealmEvent.created](payload, signal) {
      const { realmId } = parse(RealmEvent.created, payload);
      await authorizer.write(
        {
          writes: [
            {
              subject: { type: FgaType.platform, objectId: PLATFORM_ID },
              relation: "platform",
              type: FgaType.realm,
              objectId: realmId,
            },
          ],
        },
        signal,
      );
    },

    async [RealmEvent.memberChanged](payload, signal) {
      const { realmId, userId, role } = parse(RealmEvent.memberChanged, payload);

      const relation = role === null ? undefined : RANK_RELATION[role];
      if (role !== null && !relation) {
        throw new Error(`realm role ${role} has no relation in authz/model.fga`);
      }

      // Every rank is deleted and the current one written, so the result is the same however
      // many times this runs.
      const tuple = (rank: string): Tuple => ({
        subject: { userId },
        relation: rank,
        type: FgaType.realm,
        objectId: realmId,
      });
      await authorizer.write(
        { writes: relation ? [tuple(relation)] : [], deletes: RANK_RELATION.map(tuple) },
        signal,
      );
      log.info({ realmId, userId, role }, "membership synced");
    },

    async [RealmEvent.postingCreated](payload, signal) {
      const { kind, postingId, realmId, authorId } = parse(RealmEvent.postingCreated, payload);
      const type = POSTING_TYPE[kind];
      await authorizer.write(
        {
          writes: [
            { subject: { userId: authorId }, relation: "author", type, objectId: postingId },
            {
              subject: { type: FgaType.realm, objectId: realmId },
              relation: "realm",
              type,
              objectId: postingId,
            },
          ],
        },
        signal,
      );
    },
  };
}
