import { browser } from '$app/environment';
import { QueryClient } from '@tanstack/svelte-query';
import type { LayoutLoad } from './$types';

/** Prerendering is off: every page reads live catalog data. SSR stays on for SEO. */
export const ssr = true;

/**
 * Creates the query client the whole app shares.
 *
 * Made in `load` rather than at module scope so a server render never shares a cache between two
 * readers' requests.
 *
 * @returns The client, plus whatever the server layout resolved — the session, chiefly. A
 *   universal load replaces the server's data unless it passes it through, so it is spread here.
 *
 * @example
 * const { queryClient } = $derived(data);
 */
export const load: LayoutLoad = async ({ data }) => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				// SSR already fetched this data; refetching it the moment the client hydrates would
				// be a second identical request for every page view.
				staleTime: 60_000,
				retry: browser ? 1 : 0,
			},
		},
	});

	return { ...data, queryClient };
};
