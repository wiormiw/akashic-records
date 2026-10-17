import { getPendingProposals } from '$lib/api/proposals';
import type { PageServerLoad } from './$types';

/**
 * The queue of realms somebody has asked to found.
 *
 * Oldest first, from the API, because a queue is worked from the front and newest-first quietly
 * starves whoever has waited longest. The layout above has already refused anybody without
 * platform authority.
 *
 * @returns Proposals waiting on a decision.
 */
export const load: PageServerLoad = async ({ fetch }) => ({
	proposals: (await getPendingProposals(fetch)) ?? [],
});
