import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Guards one conversation.
 *
 * Nothing about the room is loaded here. The transcript is ciphertext this server cannot open, so
 * fetching it on the server would move bytes twice and reveal nothing sooner.
 *
 * @returns The reader and the room id.
 *
 * @example
 * const { roomId } = $derived(data);
 */
export const load: PageServerLoad = ({ params, url, locals }) => {
	if (!locals.user) {
		if (locals.sessionUnavailable) error(503, 'Could not reach the account service.');
		redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	}

	return { user: locals.user, roomId: params.id };
};
