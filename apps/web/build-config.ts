import type { Config } from '@sveltejs/kit/vite';

type Directives = NonNullable<NonNullable<Config['csp']>['directives']>;
type Sources = NonNullable<Directives['connect-src']>;
// Kit's host-source template types are narrower than what URL yields, so the values are cast.
type Source = Sources[number];

// Pure so the build's choices are testable without running a build; type-only imports because
// vite.config.ts loads this before anything else is set up.

export type AdapterName = 'node' | 'cloudflare';

export interface BuildEnv {
	CF_PAGES?: string;
	WORKERS_CI?: string;
	ADAPTER?: string;
	PUBLIC_API_BASE?: string;
	PUBLIC_MEDIA_ORIGIN?: string;
	// So process.env is assignable: the rest of it is none of this module's business.
	[other: string]: string | undefined;
}

/** Where a local build assumes the API is; config.ts defaults to it too, so the CSP agrees. */
export const DEFAULT_API_BASE = 'http://localhost:3000';

export interface CspOrigins {
	connect: Sources;
	img: Sources;
}

/**
 * An explicit ADAPTER wins. Otherwise Cloudflare's own build markers select its adapter: Pages
 * sets CF_PAGES=1 and Workers Builds sets WORKERS_CI=1. Anything else, a local run or a container
 * build, gets a Node server.
 */
export function chooseAdapter(env: BuildEnv): AdapterName {
	const explicit = env.ADAPTER;
	if (explicit && explicit !== 'node' && explicit !== 'cloudflare')
		throw new Error('ADAPTER must be node or cloudflare');
	const name: AdapterName =
		explicit === 'node' || explicit === 'cloudflare'
			? explicit
			: env.CF_PAGES === '1' || env.WORKERS_CI === '1'
				? 'cloudflare'
				: 'node';
	if (name === 'cloudflare') requireApiBase(env);
	return name;
}

/** A Cloudflare build has no local API to fall back on; a baked-in localhost would break every room. */
export function requireApiBase(env: BuildEnv): void {
	if (!env.PUBLIC_API_BASE) throw new Error('PUBLIC_API_BASE must be set for a Cloudflare build');
}

/**
 * The origins the page may reach beyond itself: the room socket on the API and uploaded images
 * on the media host. The policy is baked in at build time, so these origins are fixed per build;
 * with no PUBLIC_API_BASE the API defaults to the same origin config.ts uses.
 */
export function cspOrigins(env: BuildEnv): CspOrigins {
	const connect: Sources = ['self'];
	const img: Sources = ['self', 'data:'];
	const api = new URL(env.PUBLIC_API_BASE || DEFAULT_API_BASE);
	// The socket lives on the API's host; `connect-src 'self'` does not cover another origin.
	connect.push(`${api.protocol === 'https:' ? 'wss' : 'ws'}://${api.host}` as Source);
	if (env.PUBLIC_MEDIA_ORIGIN) img.push(new URL(env.PUBLIC_MEDIA_ORIGIN).origin as Source);
	return { connect, img };
}
