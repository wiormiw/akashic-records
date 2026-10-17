import { error } from '@sveltejs/kit';
import { getOverview } from '$lib/api/platform';
import type { LayoutServerLoad } from './$types';

/**
 * Guards the whole control panel, and loads the figures its sidebar shows.
 *
 * # Why the guard is in the layout and not in each page
 *
 * Because it is one decision. A guard per page is one copy per page of a rule that is identical
 * everywhere, and the page somebody adds next month is the one that forgets. Here a new section
 * is protected by existing.
 *
 * # Why a 404 rather than a redirect to sign-in
 *
 * The API answers 404 to everybody without platform authority, for the reason on its guard: a
 * 403 confirms the deployment has an administrative surface and tells somebody probing for it
 * where to keep pushing. Matching that here keeps both ends telling one story. A redirect would
 * announce that the URL means something to anyone who typed it.
 *
 * @returns The deployment's figures, which the sidebar renders as badges.
 */
export const load: LayoutServerLoad = async ({ fetch }) => {
	const overview = await getOverview(fetch);

	if (!overview) error(404, 'Not found.');

	return { overview };
};
