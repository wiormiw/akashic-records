import { fileURLToPath } from 'node:url';

export * from './vocabulary.ts';
export { createAuthorizer, type OpenFgaOptions } from './authorizer.ts';
/** The model `authz:push` writes to OpenFGA. */
export const modelPath = fileURLToPath(new URL('../model.fga', import.meta.url));
