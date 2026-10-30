import { getRealms } from '#lib/api/platform.ts';
import type { PageServerLoad } from './$types';

/**
 * Every realm, archived ones included.
 *
 * The layout above has already refused anybody without platform authority, so this load does not
 * repeat the check — it would be the same question asked twice per navigation.
 *
 * @returns The realms, or an empty list when the API could not answer.
 */
export const load: PageServerLoad = async ({ fetch }) => ({
	realms: (await getRealms(fetch)) ?? [],
});
