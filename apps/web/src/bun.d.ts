/**
 * Types for `bun:test`, which the unit tests import.
 *
 * A reference file rather than a `types` entry in tsconfig.json: that field replaces the
 * automatic `@types` discovery rather than adding to it, so setting it would silently drop
 * SvelteKit's own ambient types and every `$app/*` import would stop resolving.
 *
 * The runtime never loads this. It exists so `svelte-check` can see the same module `bun test`
 * already resolves at run time.
 */

/// <reference types="bun" />
