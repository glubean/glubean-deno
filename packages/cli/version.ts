import denoConfig from "./deno.json" with { type: "json" };

/**
 * Current Glubean CLI version from this package's `deno.json`.
 *
 * Exposed for tooling and diagnostics that need to print or compare
 * the installed CLI version at runtime.
 *
 * @example
 * import { CLI_VERSION } from "@glubean/cli";
 * console.log(`glubean ${CLI_VERSION}`);
 */
export const CLI_VERSION: string = denoConfig.version;
