import { redirect } from '@sveltejs/kit';
import { getMyProposals } from '$lib/api/proposals';
import type { PageServerLoad } from './$types';

/**
 * What this reader has asked to found, and what came of it.
 *
 * A static segment beside the dynamic `[slug]`, which SvelteKit resolves in favour of the static
 * one — unlike the API's router, where the same shape would have been read as a realm called
 * "proposals". Worth knowing, because the two behave differently for the same URL.
 *
 * @returns Their proposals, newest first.
 */
export const load: PageServerLoad = async ({ url, locals, fetch }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);

	return { proposals: (await getMyProposals(fetch)) ?? [] };
};
