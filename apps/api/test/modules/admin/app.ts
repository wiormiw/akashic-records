import type { Executor } from '@akashic/db';
import { createAdminService } from '@/modules/admin/admin.service.ts';
import { createAdminRoutes } from '@/modules/admin/admin.routes.ts';
import { testApp } from '../../support/app.ts';
import { clock } from '../../support/fixtures.ts';

/** The admin routes mounted as app.ts mounts them, on `db`. */
export const adminApp = (db: Executor) =>
	testApp(db, {
		routes: ({ sessions }) =>
			createAdminRoutes({ admin: createAdminService({ db, clock }), sessions }),
	});
