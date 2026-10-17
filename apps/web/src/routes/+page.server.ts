import { listRealmEvents, listRealms } from '$lib/api/realms';
import type { PageServerLoad } from './$types';

/** The realms, and the next few events in the busiest one. */
export const load: PageServerLoad = async ({ fetch }) => {
	const realms = await listRealms({ fetch });
	const busiest = realms[0];
	const events = busiest ? await listRealmEvents(busiest.slug, { limit: 3, fetch }) : [];
	return { realms, events, eventsRealm: busiest?.slug ?? null };
};
