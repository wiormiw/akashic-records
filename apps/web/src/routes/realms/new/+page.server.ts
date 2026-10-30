import { redirect } from '@sveltejs/kit';
import { getMyProposals } from '#lib/api/proposals.ts';
import type { PageServerLoad } from './$types';

/**
 * Guards asking to found a realm.
 *
 * # Why this stopped being creation
 *
 * It used to create one immediately, with a comment saying a community that has to ask permission
 * to exist is not the thing this is for. That was the right instinct about gatekeeping and the
 * wrong conclusion about directories: an empty realm is worse than no realm, and thirty
 * communities where twenty-eight have one member teaches a visitor the place is dead, burying the
 * two that are real.
 *
 * So it asks now. The toll is a few sentences, small enough to pay when somebody genuinely wants
 * the community and large enough to stop one existing out of idle curiosity.
 *
 * The caller's own proposals are loaded so the page can say "you already have one waiting" before
 * they fill in a form the API would only refuse.
 *
 * @returns Their pending proposal, when they have one.
 */
export const load: PageServerLoad = async ({ url, locals, fetch }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);

	const mine = (await getMyProposals(fetch)) ?? [];

	return { pending: mine.find((proposal) => proposal.status === 0) ?? null };
};
