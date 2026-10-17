import { error, redirect } from '@sveltejs/kit';
import { getRealm, getStanding, type RealmSummary, type Standing } from '$lib/api/realms';
import type { ServerLoadEvent } from '@sveltejs/kit';

/**
 * Guards a page only a member with `realm.post` may open.
 *
 * The check asks the API for the caller's standing rather than inferring it from a role name, so
 * the form appears exactly when the submit would be accepted.
 *
 * @param event The load event.
 * @param module Which module must be enabled — a realm that runs no marketplace has nothing to
 *   list.
 * @returns The realm and the caller's standing.
 * @throws {HttpError} 404 when the realm does not exist or the module is off, or a redirect to
 *   sign-in, or back to the realm when the caller may not post.
 *
 * @example
 * const { realm } = await requirePoster(event, REALM_MODULE.market);
 */
export async function requirePoster(
	event: ServerLoadEvent,
	module: number,
	permission = 'realm.post',
): Promise<{ realm: RealmSummary; standing: Standing }> {
	const { params, url, locals, fetch } = event;
	const slug = params.slug as string;

	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);

	const realm = await getRealm(slug, { fetch });
	if (!realm || !realm.modules.includes(module)) error(404, 'Nothing to post here.');

	const standing = await getStanding(slug, { fetch });
	if (!standing.permissions.includes(permission)) redirect(303, `/realms/${slug}`);

	return { realm, standing };
}
