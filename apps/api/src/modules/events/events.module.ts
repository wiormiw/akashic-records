import type { Module } from '../module.ts';
import { createEventsRoutes } from './events.routes.ts';
import type { EventsModuleDeps } from './events.types.ts';

/** Events in a realm: posting, reading, and who is coming. */
export function createEventsModule(deps: EventsModuleDeps): Module {
	return { name: 'events', routes: createEventsRoutes(deps) };
}
