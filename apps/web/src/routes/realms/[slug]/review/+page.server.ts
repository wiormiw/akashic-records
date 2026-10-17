import { error, redirect } from '@sveltejs/kit';
import { getPosting, getRealm, getStanding, listReviews } from '$lib/api/realms';
import type { PageServerLoad } from './$types';

/**
 * Loads the moderation queue, with enough of each posting to judge it.
 *
 * The queue names postings whose authors have not been told anything, so it is moderators only —
 * a public queue would be a pillory.
 *
 * @returns The realm and what is waiting, each with the posting it refers to.
 * @throws {HttpError} 404 when the realm does not exist.
 *
 * @example
 * const { waiting } = $derived(data);
 */
export const load: PageServerLoad = async ({ params, url, locals, fetch }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);

	const realm = await getRealm(params.slug, { fetch });
	if (!realm) error(404, 'No such realm.');

	const standing = await getStanding(params.slug, { fetch });
	if (!standing.permissions.includes('realm.moderate')) redirect(303, `/realms/${params.slug}`);

	const reviews = await listReviews(params.slug, { fetch });

	// The queue stores ids; a moderator needs the words. Fetched here so the page renders complete
	// rather than filling in after paint.
	const waiting = await Promise.all(
		reviews.map(async (review) => ({
			...review,
			kind: review.subjectKind === 2 ? ('jobs' as const) : ('listings' as const),
			posting: await getPosting(
				params.slug,
				review.subjectKind === 2 ? 'jobs' : 'listings',
				review.subjectId,
				{ fetch },
			),
		})),
	);

	return { realm, waiting };
};
