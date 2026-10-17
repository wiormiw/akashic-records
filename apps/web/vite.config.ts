import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { chooseAdapter, cspOrigins } from './build-config.ts';

const adapterName = chooseAdapter(process.env);
const origins = cspOrigins(process.env);

// Imported on demand so a node build does not load the Vercel adapter, or the reverse. The Vercel
// runtime is named rather than read from the building Node, which adapter-vercel 6 refuses past 24.
const adapter =
	adapterName === 'vercel'
		? (await import('@sveltejs/adapter-vercel')).default({ runtime: 'nodejs24.x' })
		: (await import('@sveltejs/adapter-node')).default();

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
			},

			/**
			 * Content Security Policy.
			 *
			 * # Why this matters more here than on most sites
			 *
			 * Because the admin control panel shares an origin with every other page. Anything that
			 * executes script in this application executes with an administrator's session, which is
			 * the one genuine argument for putting a control panel on a separate origin. A policy is
			 * what makes sharing one safe rather than safe-because-somebody-audited-it-once.
			 *
			 * It is not theoretical: the JSON-LD block on the anime page interpolated third-party
			 * text into a script element, and `JSON.stringify` does not escape a closing script tag.
			 * That one is fixed. This is what catches the next one.
			 *
			 * # `mode: 'auto'`
			 *
			 * SvelteKit hashes the inline bootstrap for prerendered pages and uses a nonce for
			 * dynamic ones, so `script-src` needs no `unsafe-inline` at all. That is the directive
			 * that actually stops an injection, and it is the one this policy gets right.
			 *
			 * # Why `style-src` keeps `unsafe-inline`
			 *
			 * Realm pages set their colour from the realm's own slug — `style="background: …"` on a
			 * handful of elements — and a realm's identity being derived rather than uploaded is a
			 * deliberate feature. In CSP Level 3 those attributes fall under `style-src-attr`, but
			 * browsers without it fall back to `style-src`, so both need it.
			 *
			 * The trade is worth naming rather than hiding: injected CSS can restyle a page and read
			 * some attribute values, and injected script can do anything. Giving up the weaker of the
			 * two to keep the stronger one strict is the right way round.
			 */
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': origins.img,
					'font-src': ['self', 'data:'],
					// Same origin, plus the room socket: the browser talks to this app's BFF for
					// everything else, so the API's wss origin is the one direct connection. Anything
					// wider would undo that.
					'connect-src': origins.connect,
					'base-uri': ['self'],
					'form-action': ['self'],
					'frame-ancestors': ['none'],
					'object-src': ['none'],
				},
			},

			/**
			 * Chosen per build, not adapter-auto.
			 *
			 * adapter-auto reads the build environment and picks a platform adapter, which produces
			 * nothing runnable in a plain container -- and fails at build time rather than at deploy
			 * time. So the choice is explicit: node (a server at build/index.js listening on PORT,
			 * which the Dockerfile runs) unless Vercel sets VERCEL=1; ADAPTER overrides either way.
			 */
			adapter,
		}),
	],
});
