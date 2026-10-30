import { RealmModule } from '@akashic/lib/enums';
import { requirePoster } from '#lib/api/guard.ts';
import { uploadPolicy } from '#lib/api/uploads.ts';
import type { PageServerLoad } from './$types';

/**
 * Guards the event form.
 *
 * @returns The realm, and whether this deployment accepts uploads.
 *
 * @example
 * const { realm } = $derived(data);
 */
export const load: PageServerLoad = async (event) => ({
	...(await requirePoster(event, RealmModule.events, 'realm.post_event')),
	policy: await uploadPolicy({ fetch: event.fetch }),
});
