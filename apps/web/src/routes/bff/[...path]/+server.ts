import { API_BASE } from '#lib/config.ts';
import type { RequestHandler } from './$types';

/**
 * Forwards `/bff/*` to the API, cookies and all.
 *
 * The session cookie is HttpOnly and belongs to whichever origin set it. Talking to the API
 * directly from the browser would make it a third-party cookie the moment the two are deployed
 * to different domains — so the browser talks to this origin, and this route is the only thing
 * that talks to the API.
 *
 * It is a dumb pipe: no route list to keep in step with the API, and the API's own auth guard is
 * still what decides who may do what.
 */

/** Response headers that describe the API's own connection, not the payload. */
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'transfer-encoding',
	'upgrade',
	'content-encoding',
	'content-length',
]);

/**
 * Proxies one request.
 *
 * @param event Path, method, headers and body of the incoming request.
 * @returns The API's response, with `Set-Cookie` preserved so sign-in lands in the browser.
 *
 * @example
 * // POST /bff/api/auth/sign-in/email  ->  POST {API_BASE}/api/auth/sign-in/email
 */
const proxy: RequestHandler = async ({ params, request, url, fetch }) => {
	const target = `${API_BASE}/${params.path}${url.search}`;

	const headers = new Headers(request.headers);
	// The API's CSRF guard and better-auth both check Origin, and both trust the browser's, not
	// this server's. Host must go: it still names this origin, and the API would reject it.
	headers.delete('host');

	// `duplex` is required whenever the body is a stream, and is missing from the DOM types.
	const init: RequestInit & { duplex?: 'half' } = {
		method: request.method,
		headers,
		body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
		duplex: 'half',
	};

	const response = await fetch(target, init);

	const out = new Headers();
	for (const [key, value] of response.headers) {
		if (!HOP_BY_HOP.has(key.toLowerCase())) out.append(key, value);
	}

	return new Response(response.body, { status: response.status, headers: out });
};

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
