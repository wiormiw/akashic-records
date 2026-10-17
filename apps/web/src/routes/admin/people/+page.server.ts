import { getAccounts } from '$lib/api/platform';
import type { PageServerLoad } from './$types';

/**
 * The accounts on the deployment.
 *
 * @returns Accounts, suspended ones first, and the search term that produced them.
 */
export const load: PageServerLoad = async ({ fetch, url }) => {
	const query = url.searchParams.get('q') ?? '';

	return { accounts: (await getAccounts(fetch, query)) ?? [], query };
};
