export * from "./vocabulary.ts";
export { createAuthorizer, type OpenFgaOptions } from "./authorizer.ts";
/** The model `authz:push` writes to OpenFGA. */
export const modelPath = new URL("../model.fga", import.meta.url).pathname;
