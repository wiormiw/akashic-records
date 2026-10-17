import { getReports } from '$lib/api/platform';
import type { PageServerLoad } from './$types';

/**
 * The direct-message report queue.
 *
 * Loads reviewed reports as well as open ones. A queue that hides what has been handled cannot
 * answer "did somebody already look at this", which is the second question anybody asks after
 * "what is waiting".
 *
 * @returns Every report, newest open ones first.
 */
export const load: PageServerLoad = async ({ fetch }) => ({
	reports: (await getReports(fetch, 'all')) ?? [],
});
