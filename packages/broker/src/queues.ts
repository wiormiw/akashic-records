/** The topic exchange every domain event is published to, routed by its type. */
export const EVENTS_EXCHANGE = "akashic.events";

/** Every queue a consumer reads. Stored in RabbitMQ: never rename one. */
export const Queues = { authzSync: "akashic.authz-sync" } as const;
