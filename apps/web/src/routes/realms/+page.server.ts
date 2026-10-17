import { listRealms } from '$lib/api/realms';
import type { PageServerLoad } from './$types';

/**
 * The realm directory.
 *
 * Public, and server-rendered: a community that cannot be found by someone who is not already in
 * it is not discoverable at all.
 *
 * @returns Every realm, most populous first, and whether the reader could found one.
 *
 * @example
 * const { realms } = $derived(data);
 */
export const load: PageServerLoad = async ({ locals, fetch }) => ({
	realms: await listRealms({ fetch }),
	signedIn: Boolean(locals.user),
});
