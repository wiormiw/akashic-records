import { error, redirect } from '@sveltejs/kit';
import { getPosting, getRealm, getStanding, listComments } from '#lib/api/realms.ts';
import type { PageServerLoad } from './$types';

/**
 * Loads one posting and its thread.
 *
 * Members only, the rule every module follows: the listing is public so a realm can be
 * discovered, the detail is not so its business is not a scrapeable dataset.
 *
 * @returns The realm, the posting, its comments, and what the caller may do here.
 * @throws {HttpError} 404 when the realm does not exist.
 *
 * @example
 * const { posting, thread } = $derived(data);
 */
export const load: PageServerLoad = async ({ params, url, locals, fetch }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);

	const [realm, posting, standing] = await Promise.all([
		getRealm(params.slug, { fetch }),
		getPosting(params.slug, 'jobs', params.id, { fetch }),
		getStanding(params.slug, { fetch }),
	]);

	if (!realm) error(404, 'No such realm.');

	// Missing and forbidden are the same fact to a non-member, and read the same way.
	if (!posting) redirect(303, `/realms/${params.slug}`);

	return {
		realm,
		posting,
		standing,
		thread: await listComments(params.slug, 'jobs', params.id, { fetch }),
	};
};
