import { defineEnvVars } from '@sveltejs/kit/env';
import * as v from 'valibot';

// Public and read when the app starts, as `$env/dynamic/public` was: one build serves any API.
// Both may be unset or empty; config.ts falls back for each.
export const variables = defineEnvVars({
	PUBLIC_API_BASE: {
		public: true,
		schema: v.optional(v.string()),
		description: 'Base URL of the Akashic API. Falls back to the origin the build was made for.',
	},
	PUBLIC_SITE_URL: {
		public: true,
		schema: v.optional(v.string()),
		description: 'Canonical origin of this site, for og:url and the canonical link.',
	},
});
