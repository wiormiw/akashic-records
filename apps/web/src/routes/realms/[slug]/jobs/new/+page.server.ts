import { RealmModule } from '@akashic/lib/enums';
import { requirePoster } from '$lib/api/guard';
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
	requirePoster(event, RealmModule.jobs, 'realm.post_job');
