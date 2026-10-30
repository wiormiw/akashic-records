import { error } from '@sveltejs/kit';
import { RealmModule } from '@akashic/lib/enums';
import { getRealm, getStanding, listPostings } from '#lib/api/realms.ts';
import type { PageServerLoad } from './$types';

/**
 * The whole marketplace, when the realm's page can only show a preview.
 *
 * Public like the realm itself: the listing is what a realm is discovered by, and only the detail
 * behind it is members-only.
 *
 * @returns The realm, its listings, and the caller's standing.
 * @throws {HttpError} 404 when the realm does not exist or runs no marketplace.
 *
 * @example
 * const { listings } = $derived(data);
 */
export const load: PageServerLoad = async ({ params, locals, fetch }) => {
	const realm = await getRealm(params.slug, { fetch });
	if (!realm || !realm.modules.includes(RealmModule.market)) error(404, 'No marketplace here.');

	const [standing, listings] = await Promise.all([
		locals.user
			? getStanding(params.slug, { fetch })
			: Promise.resolve({ role: null, permissions: [] }),
		listPostings(params.slug, 'listings', { limit: 100, fetch }),
	]);

	return { realm, standing, listings };
};
