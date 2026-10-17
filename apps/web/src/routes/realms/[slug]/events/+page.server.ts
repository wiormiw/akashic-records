import { error } from '@sveltejs/kit';
import { REALM_MODULE, getRealm, getStanding, listRealmEvents } from '$lib/api/realms';
import type { PageServerLoad } from './$types';

/**
 * Everything the realm has scheduled.
 *
 * @returns The realm, its events, and the caller's standing.
 * @throws {HttpError} 404 when the realm does not exist or runs no events.
 *
 * @example
 * const { events } = $derived(data);
 */
export const load: PageServerLoad = async ({ params, locals, fetch }) => {
	const realm = await getRealm(params.slug, { fetch });
	if (!realm || !realm.modules.includes(REALM_MODULE.events)) error(404, 'No events here.');

	const [standing, events] = await Promise.all([
		locals.user
			? getStanding(params.slug, { fetch })
			: Promise.resolve({ role: null, permissions: [] }),
		listRealmEvents(params.slug, { limit: 100, fetch }),
	]);

	return { realm, standing, events };
};
