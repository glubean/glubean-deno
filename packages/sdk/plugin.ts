/**
 * Plugin definition helper for Glubean SDK.
 *
 * Plugin authors use `definePlugin()` to create plugin factories that
 * integrate with `configure({ plugins: { ... } })`. This is the recommended
 * way to define plugins — it handles the `PluginFactory` phantom type trick
 * so plugin authors don't need to understand it.
 *
 * @example
 * ```ts
 * import { definePlugin } from "@glubean/sdk";
 *
 * export const myPlugin = (opts: MyOptions) =>
 *   definePlugin((runtime) => {
 *     const baseUrl = runtime.requireVar(opts.baseUrlKey);
 *     return new MyClient(baseUrl);
 *   });
 * ```
 *
 * @module plugin
 */

import type { GlubeanRuntime, PluginFactory } from "./types.ts";

/**
 * Create a plugin factory. This is the recommended way to define plugins.
 *
 * The factory function receives a `GlubeanRuntime` with access to vars,
 * secrets, HTTP client, and template resolution. It is called lazily on
 * first property access during test execution, not at module load time.
 *
 * @param create Factory function that receives the runtime and returns the plugin instance
 * @returns A `PluginFactory<T>` suitable for use in `configure({ plugins: { ... } })`
 *
 * @example Simple plugin
 * ```ts
 * export const myPlugin = (opts: { baseUrlKey: string }) =>
 *   definePlugin((runtime) => {
 *     const baseUrl = runtime.requireVar(opts.baseUrlKey);
 *     return new MyClient(baseUrl);
 *   });
 * ```
 *
 * @example Plugin with auth headers
 * ```ts
 * export const graphql = (opts: { endpoint: string; headers?: Record<string, string> }) =>
 *   definePlugin((runtime) => {
 *     const url = runtime.requireVar(opts.endpoint);
 *     const headers: Record<string, string> = {};
 *     for (const [k, v] of Object.entries(opts.headers ?? {})) {
 *       headers[k] = runtime.resolveTemplate(v);
 *     }
 *     return createGraphQLClient(runtime.http, { endpoint: url, headers });
 *   });
 * ```
 */
export function definePlugin<T>(
  create: (runtime: GlubeanRuntime) => T,
): PluginFactory<T> {
  return { __type: undefined as unknown as T, create };
}
