import type { Executor } from '@akashic/db';
import { silentLogger } from '@akashic/lib/log';
import { createLocalRelay } from '@/integrations/relay.ts';
import { createRoomServices } from '@/modules/room/room.module.ts';
import { createRoomRoutes } from '@/modules/room/room.routes.ts';
import { testApp } from '../../support/app.ts';
import { clock } from '../../support/fixtures.ts';
import { TICKET_SECRET } from './fixtures.ts';

/** The room's HTTP routes mounted as app.ts mounts them, on `db`. */
export const roomApp = (db: Executor) =>
	testApp(db, {
		routes: () =>
			createRoomRoutes({
				services: createRoomServices({ db, clock, ticketSecret: TICKET_SECRET }),
				relay: createLocalRelay({ logger: silentLogger() }),
				logger: silentLogger(),
			}),
	});
