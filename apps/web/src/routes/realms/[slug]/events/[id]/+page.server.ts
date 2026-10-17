import { error, redirect } from '@sveltejs/kit';
import { getEvent, getRealm, getStanding, listComments } from '$lib/api/realms';
import type { PageServerLoad } from './$types';

/**
 * Loads one event in full.
 *
 * Members only, which is the rule every module follows — the listing is public so a realm can be
 * discovered, the detail is not so its plans are not a scrapeable dataset. A signed-out visitor
 * is sent to sign in; a signed-in non-member is sent to the realm, where the join button is.
 *
 * @returns The realm, the event, its thread, and what the caller may do here.
 * @throws {HttpError} 404 when the event is not in this realm or does not exist.
 *
 * @example
 * const { event } = $derived(data);
 */
export const load: PageServerLoad = async ({ params, url, locals, fetch }) => {
	if (!locals.user) {
		redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	}

	const [realm, event, standing] = await Promise.all([
		getRealm(params.slug, { fetch }),
		getEvent(params.slug, params.id, { fetch }),
		getStanding(params.slug, { fetch }),
	]);

	if (!realm) error(404, 'No such realm.');

	// The API answers the same way for "no such event" and "you may not see it", and so does this
	// page: to a reader who is not a member, the two are the same fact.
	if (!event) redirect(303, `/realms/${params.slug}`);

	return {
		realm,
		event,
		standing,
		thread: await listComments(params.slug, 'events', params.id, { fetch }),
	};
};
