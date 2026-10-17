import { error } from '@sveltejs/kit';
import { getRecalls, getStandings } from '$lib/api/governance';
import { getRealm, getStanding } from '$lib/api/realms';
import { REALM_MODULE } from '$lib/api/realms';
import type { PageServerLoad } from './$types';

/**
 * The election: who the realm wants holding its moderator seats.
 *
 * A module like jobs or events, so a realm that would rather its founder appointed moderators is
 * simply not running it — and this page 404s there rather than showing an empty leaderboard that
 * implies the feature is broken.
 *
 * @returns The realm, the standings, open recalls, and the caller's own permissions.
 */
export const load: PageServerLoad = async ({ params, locals, fetch }) => {
	const realm = await getRealm(params.slug, { fetch });

	if (!realm || !realm.modules.includes(REALM_MODULE.election)) {
		error(404, 'This realm does not hold elections.');
	}

	if (!locals.user) error(404, 'This realm does not hold elections.');

	const [standings, recalls, standing] = await Promise.all([
		getStandings(params.slug, fetch),
		getRecalls(params.slug, fetch),
		getStanding(params.slug, { fetch }),
	]);

	// Null means the API refused, which for a signed-in non-member is the honest answer: the
	// standings are a members' view of their own community.
	if (!standings) error(404, 'Join this realm to see its standings.');

	return { realm, standings, recalls: recalls ?? [], standing };
};
