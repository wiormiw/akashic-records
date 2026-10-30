import { getOverview } from '#lib/api/platform.ts';
import type { LayoutServerLoad } from './$types';

/**
 * Publishes the session to every page, so the header can show who is signed in.
 *
 * # Why the platform check is here and not on the page
 *
 * The nav is in the layout, so whether to draw a link to /admin has to be known in the layout.
 * Asking the API is the only honest way to know: the answer lives in OpenFGA, not in the session,
 * and inferring it from anything on the user row would be a second copy of the policy that can
 * disagree with the first.
 *
 * It costs one request per page load for a signed-in reader, and that request 404s immediately
 * for almost all of them. Caching it in the session would mean somebody's authority surviving
 * its own revocation for as long as their cookie lasts, which is the wrong direction to be wrong
 * in.
 *
 * @returns The user, and whether they run the deployment.
 *
 * @example
 * const { user, isPlatformAdmin } = $derived(data);
 */
export const load: LayoutServerLoad = async ({ locals, fetch }) => ({
	user: locals.user,
	isPlatformAdmin: locals.user ? (await getOverview(fetch)) !== null : false,
});
