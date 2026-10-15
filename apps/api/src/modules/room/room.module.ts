import { policy } from "@/config.ts";
import type { Module } from "../module.ts";
import { createMessageService } from "./room.messages.service.ts";
import { createModerationService } from "./room.moderation.service.ts";
import { createRoomRoutes } from "./room.routes.ts";
import { createRoomService, createTickets } from "./room.service.ts";
import type { RoomModuleDeps, RoomServices, RoomServicesDeps } from "./room.types.ts";

/** The room services, built once, sharing one ticket signer. */
export function createRoomServices(deps: RoomServicesDeps): RoomServices {
  const { db, clock } = deps;
  const tickets = createTickets({
    secret: deps.ticketSecret,
    ttl: { seconds: policy.rooms.ticketTtlSeconds },
  });
  return {
    rooms: createRoomService({ db, clock, tickets }),
    messages: createMessageService({ db, clock }),
    moderation: createModerationService({ db, clock }),
  };
}

/** End-to-end encrypted rooms: keys, messages over a socket, reports and retention. */
export function createRoomModule(deps: RoomModuleDeps): Module {
  return { name: "room", routes: createRoomRoutes(deps) };
}
