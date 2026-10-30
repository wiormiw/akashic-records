import { getAudit } from '#lib/api/platform.ts';
import type { PageServerLoad } from './$types';

/**
 * The audit trail.
 *
 * @returns The most recent administrative acts, actors resolved to people. `null` when the log
 * could not be fetched or parsed (one unknown enum value fails the whole list), so the page can say
 * so instead of reading as "nothing recorded".
 */
export const load: PageServerLoad = async ({ fetch }) => ({ audit: await getAudit(fetch) });
