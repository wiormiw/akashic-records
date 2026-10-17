import { requirePoster } from '$lib/api/guard';
import { REALM_MODULE } from '$lib/api/realms';
import { uploadPolicy } from '$lib/api/uploads';
import type { PageServerLoad } from './$types';

/**
 * Guards the marketplace form.
 *
 * @returns The realm, and whether this deployment accepts uploads.
 *
 * @example
 * const { realm } = $derived(data);
 */
export const load: PageServerLoad = async (event) => ({
	...(await requirePoster(event, REALM_MODULE.market)),
	policy: await uploadPolicy({ fetch: event.fetch }),
});
