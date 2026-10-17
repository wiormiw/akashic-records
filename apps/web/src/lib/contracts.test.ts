import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { RealmSummaryView } from '@akashic/contracts';
import { RealmModule } from '@akashic/lib/enums';

// The web app parses with the contracts views; this proves the workspace packages resolve in the
// web app and that a realm summary as the API sends it passes the shared view.
describe('contracts in the web app', () => {
	test('a realm summary parses with the shared view', () => {
		const sample = {
			id: 'r1',
			slug: 'tokyo',
			name: 'Tokyo',
			description: null,
			category: 'city',
			memberCount: 3,
			modules: [RealmModule.jobs, RealmModule.events],
		};
		const parsed = v.parse(RealmSummaryView, sample);
		expect(parsed.modules).toEqual([0, 1]);
		expect(RealmModule.events).toBe(1);
	});
});
