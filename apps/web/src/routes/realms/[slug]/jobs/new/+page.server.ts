import { requirePoster } from '$lib/api/guard';
import { REALM_MODULE } from '$lib/api/realms';
import type { PageServerLoad } from './$types';

/**
 * Guards the job form.
 *
 * @returns The realm.
 *
 * @example
 * const { realm } = $derived(data);
 */
export const load: PageServerLoad = async (event) =>
	requirePoster(event, REALM_MODULE.jobs, 'realm.post_job');
