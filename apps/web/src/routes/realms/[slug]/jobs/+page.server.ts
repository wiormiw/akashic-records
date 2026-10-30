import { error } from '@sveltejs/kit';
import { RealmModule } from '@akashic/lib/enums';
import { getRealm, getStanding, listPostings } from '#lib/api/realms.ts';
import type { PageServerLoad } from './$types';

/**
 * Every brief in the realm.
 *
 * @returns The realm, its jobs, and the caller's standing.
 * @throws {HttpError} 404 when the realm does not exist or runs no jobs board.
 *
 * @example
 * const { jobs } = $derived(data);
 */
export const load: PageServerLoad = async ({ params, locals, fetch }) => {
	const realm = await getRealm(params.slug, { fetch });
	if (!realm || !realm.modules.includes(RealmModule.jobs)) error(404, 'No jobs board here.');

	const [standing, jobs] = await Promise.all([
		locals.user
			? getStanding(params.slug, { fetch })
			: Promise.resolve({ role: null, permissions: [] }),
		listPostings(params.slug, 'jobs', { limit: 100, fetch }),
	]);

	return { realm, standing, jobs };
};
