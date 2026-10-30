import { error } from '@sveltejs/kit';
import type { RealmModule } from '@akashic/lib/enums';
import { getRealm, getStanding, listPostings, listRealmEvents } from '#lib/api/realms.ts';
import type { PageServerLoad } from './$types';

/**
 * Loads a realm, what the caller may do in it, and whatever its modules hold.
 *
 * Only the enabled modules are fetched: asking a realm that does not run a marketplace for its
 * listings is a request whose answer is always empty.
 *
 * @returns The realm, the caller's standing, and the contents of each enabled module.
 *
 * @example
 * const { realm, standing, events, jobs, listings } = $derived(data);
 */
export const load: PageServerLoad = async ({ params, locals, fetch }) => {
	const realm = await getRealm(params.slug, { fetch });
	if (!realm) error(404, 'No such realm.');

	const runs = (module: RealmModule) => realm.modules.includes(module);

	const [standing, events, jobs, listings] = await Promise.all([
		locals.user
			? getStanding(params.slug, { fetch })
			: Promise.resolve({ role: null, permissions: [] }),
		runs(1) ? listRealmEvents(params.slug, { limit: 20, fetch }) : Promise.resolve([]),
		runs(0) ? listPostings(params.slug, 'jobs', { limit: 20, fetch }) : Promise.resolve([]),
		runs(2) ? listPostings(params.slug, 'listings', { limit: 20, fetch }) : Promise.resolve([]),
	]);

	return { realm, standing, events, jobs, listings, signedIn: Boolean(locals.user) };
};
