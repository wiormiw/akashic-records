import { error, redirect } from '@sveltejs/kit';
import { getRealm, getStanding, listMembers } from '$lib/api/realms';
import type { PageServerLoad } from './$types';

/**
 * Loads the roster.
 *
 * Members only: who is in a realm is the realm's business, not a directory anyone can scrape.
 *
 * @returns The realm, the roster, and what the caller may do with it.
 * @throws {HttpError} 404 when the realm does not exist.
 *
 * @example
 * const { members, standing } = $derived(data);
 */
export const load: PageServerLoad = async ({ params, url, locals, fetch }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);

	const realm = await getRealm(params.slug, { fetch });
	if (!realm) error(404, 'No such realm.');

	const standing = await getStanding(params.slug, { fetch });
	if (standing.role === null) redirect(303, `/realms/${params.slug}`);

	return {
		realm,
		standing,
		members: await listMembers(params.slug, { fetch }),
		viewerId: locals.user.id,
	};
};
