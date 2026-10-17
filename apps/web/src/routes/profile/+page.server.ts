import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) {
		// A failed check is not a signed-out reader; sending them to sign-in would strand them.
		if (locals.sessionUnavailable) error(503, 'Could not reach the account service.');
		redirect(303, '/login?next=/profile');
	}
	return { user: locals.user };
};
