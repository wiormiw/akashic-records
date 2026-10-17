import { env } from '$env/dynamic/public';

/**
 * Base URL of the Akashic API, without a trailing slash.
 *
 * Dynamic rather than static so one built image can be pointed at a different API by setting
 * `PUBLIC_API_BASE` at run time.
 */
export const API_BASE = (env.PUBLIC_API_BASE ?? 'http://localhost:3000').replace(/\/$/, '');

/** Canonical origin, used for `og:url` and `<link rel="canonical">`. */
export const SITE_URL = (env.PUBLIC_SITE_URL ?? 'http://localhost:5173').replace(/\/$/, '');

/** Shown in the header, the document title suffix and the social card. */
export const SITE_NAME = 'Akashic Records';
