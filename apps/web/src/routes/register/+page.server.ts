import { mailStatus } from '#lib/api/mail.ts';
import type { PageServerLoad } from './$types';

/**
 * Loads whether verification mail is getting out.
 *
 * This screen is where someone is told to go and check their inbox, so it is the screen that has
 * to know when nothing was sent — otherwise a mail outage looks exactly like a slow inbox, and
 * the reader waits for a link that is never coming.
 *
 * @returns The deployment's mail status, or null when it could not be read.
 *
 * @example
 * const { mail } = $derived(data);
 */
export const load: PageServerLoad = async ({ fetch }) => ({ mail: await mailStatus({ fetch }) });
