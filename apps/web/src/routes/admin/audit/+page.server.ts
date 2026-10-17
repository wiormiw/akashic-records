import { getAudit } from '$lib/api/platform';
import type { PageServerLoad } from './$types';

/**
 * The audit trail.
 *
 * @returns The most recent administrative acts, actors resolved to people.
 */
export const load: PageServerLoad = async ({ fetch }) => ({ audit: (await getAudit(fetch)) ?? [] });
