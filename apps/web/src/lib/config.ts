import { env } from '$env/dynamic/public';
import { DEFAULT_API_BASE } from '../../build-config.ts';

/**
 * Base URL of the Akashic API, without a trailing slash.
 *
 * The API and media origins are fixed per build: the CSP is baked in at build time and allows only
 * the socket origin it was built with, so pointing a build at another API needs a rebuild.
 */
export const API_BASE = (env.PUBLIC_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, '');

/** Canonical origin, used for `og:url` and `<link rel="canonical">`. */
export const SITE_URL = (env.PUBLIC_SITE_URL ?? 'http://localhost:5173').replace(/\/$/, '');

/** Shown in the header, the document title suffix and the social card. */
export const SITE_NAME = 'Akashic Records';
