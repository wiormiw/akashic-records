import type { Config } from '@sveltejs/kit';

type Directives = NonNullable<NonNullable<NonNullable<Config['kit']>['csp']>['directives']>;
type Sources = NonNullable<Directives['connect-src']>;
// Kit's host-source template types are narrower than what URL yields, so the values are cast.
type Source = Sources[number];

// Pure so the build's choices are testable without running a build; type-only imports because
// vite.config.ts loads this before anything else is set up.

export type AdapterName = 'node' | 'vercel';

export interface BuildEnv {
	VERCEL?: string;
	ADAPTER?: string;
	PUBLIC_API_BASE?: string;
	PUBLIC_MEDIA_ORIGIN?: string;
	// So process.env is assignable: the rest of it is none of this module's business.
	[other: string]: string | undefined;
}

export interface CspOrigins {
	connect: Sources;
	img: Sources;
}

/** An explicit ADAPTER wins; otherwise Vercel's own VERCEL=1 selects its adapter. */
export function chooseAdapter(env: BuildEnv): AdapterName {
	const explicit = env.ADAPTER;
	if (explicit) {
		if (explicit !== 'node' && explicit !== 'vercel')
			throw new Error('ADAPTER must be node or vercel');
		return explicit;
	}
	return env.VERCEL === '1' ? 'vercel' : 'node';
}

/**
 * The origins the page may reach beyond itself: the room socket on the API and uploaded images
 * on the media host. Both are known only at build time, so they are baked into the policy.
 */
export function cspOrigins(env: BuildEnv): CspOrigins {
	const connect: Sources = ['self'];
	const img: Sources = ['self', 'data:'];
	if (env.PUBLIC_API_BASE) {
		const api = new URL(env.PUBLIC_API_BASE);
		// The socket lives on the API's host; `connect-src 'self'` does not cover another origin.
		connect.push(`${api.protocol === 'https:' ? 'wss' : 'ws'}://${api.host}` as Source);
	}
	if (env.PUBLIC_MEDIA_ORIGIN) img.push(new URL(env.PUBLIC_MEDIA_ORIGIN).origin as Source);
	return { connect, img };
}
