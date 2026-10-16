import type { Executor } from '@akashic/db';
import { createRealmRoutes } from '@/modules/realm/realm.routes.ts';
import { createRealmService } from '@/modules/realm/realm.service.ts';
import { testApp } from '../../support/app.ts';
import { clock } from '../../support/fixtures.ts';
import { noEmbedder } from './fixtures.ts';

export type { Grants } from '../../support/app.ts';

/** The realm routes mounted as app.ts mounts them, on `db`. */
export const realmApp = (db: Executor) =>
	testApp(db, {
		routes: ({ sessions, realmContext }) =>
			createRealmRoutes({
				realms: createRealmService({ db, embedder: noEmbedder, clock }),
				sessions,
				realmContext,
			}),
	});
