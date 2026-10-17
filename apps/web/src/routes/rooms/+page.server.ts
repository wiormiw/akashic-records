import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Guards the inbox.
 *
 * The rooms themselves are fetched on the client, because reading one means decrypting it and
 * this server has no key. All the load does is confirm somebody is signed in.
 *
 * @returns The reader.
 *
 * @example
 * const { user } = $derived(data);
 */
export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) {
		if (locals.sessionUnavailable) error(503, 'Could not reach the account service.');
		redirect(303, '/login?next=/rooms');
	}

	return { user: locals.user };
};
