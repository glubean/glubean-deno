/**
 * File-level configuration for Glubean tests.
 *
 * `configure()` lets you declare shared dependencies (vars, secrets, HTTP config)
 * once at the top of a test file (or in a shared `configure.ts`), eliminating
 * repetitive `ctx.vars.require()` / `ctx.secrets.require()` calls in every test.
 *
 * All returned values are **lazy** — they are not resolved until a test function
 * actually accesses them at runtime. This means:
 * - Safe to call at module top-level (scanner won't trigger resolution)
 * - Safe to share across files via re-exports
 * - Each test execution gets the correct runtime values
 *
 * @example Single file usage
 * ```ts
 * import { test, configure } from "@glubean/sdk";
 *
 * const { vars, secrets, http } = configure({
 *   vars: { baseUrl: "BASE_URL" },
 *   secrets: { apiKey: "API_KEY" },
 *   http: {
 *     prefixUrl: "BASE_URL",
 *     headers: { Authorization: "Bearer {{API_KEY}}" },
 *   },
 * });
 *
 * export const listUsers = test("list-users", async (ctx) => {
 *   const res = await http.get("users").json();
 *   ctx.assert(res.length > 0, "has users");
 * });
 * ```
 *
 * @example Shared across files (tests/configure.ts)
 * ```ts
 * // tests/configure.ts
 * import { configure } from "@glubean/sdk";
 * export const { vars, secrets, http } = configure({
 *   vars: { baseUrl: "BASE_URL" },
 *   http: { prefixUrl: "BASE_URL" },
 * });
 *
 * // tests/users.test.ts
 * import { test } from "@glubean/sdk";
 * import { http } from "./configure.ts";
 *
 * export const listUsers = test("list-users", async (ctx) => {
 *   const res = await http.get("users").json();
 * });
 * ```
 *
 * @module configure
 */

import type {
  ConfigureHttpOptions,
  ConfigureOptions,
  ConfigureResult,
  GlubeanAction,
  GlubeanEvent,
  GlubeanRuntime,
  HttpClient,
  HttpRequestOptions,
  PluginActivation,
  PluginEntry,
  PluginFactory,
  RequestMatcher,
  ReservedConfigureKeys,
  ResolvePlugins,
} from "./types.ts";

// =============================================================================
// Runtime global slot
// =============================================================================

/**
 * Shape of the runtime context injected by the harness before test execution.
 * This is the internal shape — the public `GlubeanRuntime` in types.ts adds
 * helper methods (requireVar, requireSecret, resolveTemplate) for plugins.
 *
 * @internal
 */
export interface InternalRuntime {
  vars: Record<string, string>;
  secrets: Record<string, string>;
  http: HttpClient;
  test?: GlubeanRuntime["test"];
  action?(a: GlubeanAction): void;
  event?(ev: GlubeanEvent): void;
  log?(message: string, data?: unknown): void;
}

/**
 * Get the current runtime context from the global slot.
 * Throws a clear error if accessed outside of test execution (e.g., at scan time).
 *
 * @internal
 */
function getRuntime(): InternalRuntime {
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).__glubeanRuntime as
    | InternalRuntime
    | undefined;
  if (!runtime) {
    throw new Error(
      "configure() values can only be accessed during test execution. " +
        "Did you try to read a var or secret at module load time? " +
        "Move the access inside a test function.",
    );
  }
  return runtime;
}

/**
 * Require a var from the runtime context.
 * Throws if the var is missing or empty.
 *
 * @internal
 */
function requireVar(key: string): string {
  const runtime = getRuntime();
  const value = runtime.vars[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required var: ${key}`);
  }
  return value;
}

/**
 * Require a secret from the runtime context.
 * Throws if the secret is missing or empty.
 *
 * @internal
 */
function requireSecret(key: string): string {
  const runtime = getRuntime();
  const value = runtime.secrets[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required secret: ${key}`);
  }
  return value;
}

// =============================================================================
// Lazy proxy builders
// =============================================================================

/**
 * Regex for `{{key}}` template placeholders in header values.
 */
const TEMPLATE_RE = /\{\{([\w-]+)\}\}/g;

/**
 * Build a lazy vars accessor object.
 * Each property is a getter that calls `requireVar()` on access.
 *
 * @internal
 */
function buildLazyVars<V extends Record<string, string>>(
  mapping: Record<string, string>,
): Readonly<V> {
  const obj = {} as Record<string, string>;
  for (const [prop, varKey] of Object.entries(mapping)) {
    Object.defineProperty(obj, prop, {
      get() {
        return requireVar(varKey);
      },
      enumerable: true,
      configurable: false,
    });
  }
  return obj as unknown as Readonly<V>;
}

/**
 * Build a lazy secrets accessor object.
 * Each property is a getter that calls `requireSecret()` on access.
 *
 * @internal
 */
function buildLazySecrets<S extends Record<string, string>>(
  mapping: Record<string, string>,
): Readonly<S> {
  const obj = {} as Record<string, string>;
  for (const [prop, secretKey] of Object.entries(mapping)) {
    Object.defineProperty(obj, prop, {
      get() {
        return requireSecret(secretKey);
      },
      enumerable: true,
      configurable: false,
    });
  }
  return obj as unknown as Readonly<S>;
}

/**
 * Resolve `{{key}}` template placeholders in a string using runtime vars and secrets.
 * Secrets take precedence over vars if both have the same key.
 *
 * This is used internally by `buildLazyHttp()` and exposed to plugin authors
 * via `GlubeanRuntime.resolveTemplate()`.
 */
export function resolveTemplate(
  template: string,
  vars: Record<string, string>,
  secrets: Record<string, string>,
): string {
  return template.replace(TEMPLATE_RE, (_match, key: string) => {
    // Try secrets first (more likely for auth headers), then vars
    const value = secrets[key] ?? vars[key];
    if (value === undefined || value === null || value === "") {
      throw new Error(
        `Missing value for template placeholder "{{${key}}}" in configure() http headers. ` +
          `Ensure "${key}" is available as a var or secret.`,
      );
    }
    return value;
  });
}

/**
 * Build a lazy HTTP client proxy.
 * On first method call, resolves the config and creates an extended client.
 *
 * @internal
 */
function buildLazyHttp(httpOptions: ConfigureHttpOptions): HttpClient {
  // Cache the resolved client per runtime identity to avoid re-extending on every call.
  // Since each test runs in its own subprocess, a WeakMap keyed on runtime object
  // ensures we get one extended client per test execution.
  const cache = new WeakMap<InternalRuntime, HttpClient>();

  function getClient(): HttpClient {
    const runtime = getRuntime();
    let client = cache.get(runtime);
    if (client) return client;

    // Build ky-compatible options from the configure http config
    // deno-lint-ignore no-explicit-any
    const extendOptions: Record<string, any> = {};

    if (httpOptions.prefixUrl) {
      extendOptions.prefixUrl = requireVar(httpOptions.prefixUrl);
    }

    if (httpOptions.headers) {
      const resolvedHeaders: Record<string, string> = {};
      for (const [name, template] of Object.entries(httpOptions.headers)) {
        resolvedHeaders[name] = resolveTemplate(
          template,
          runtime.vars,
          runtime.secrets,
        );
      }
      extendOptions.headers = resolvedHeaders;
    }

    if (httpOptions.timeout !== undefined) {
      extendOptions.timeout = httpOptions.timeout;
    }

    if (httpOptions.retry !== undefined) {
      extendOptions.retry = httpOptions.retry;
    }

    if (httpOptions.throwHttpErrors !== undefined) {
      extendOptions.throwHttpErrors = httpOptions.throwHttpErrors;
    }

    if (httpOptions.hooks) {
      extendOptions.hooks = httpOptions.hooks;
    }

    client = runtime.http.extend(extendOptions);
    cache.set(runtime, client);
    return client;
  }

  // Create a callable proxy that delegates all method calls to the lazily-resolved client.
  const HTTP_METHODS = [
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
  ] as const;

  // The callable function (for `http(url, options)` shorthand)
  // deno-lint-ignore no-explicit-any
  const proxy: any = function (
    url: string | URL | Request,
    // deno-lint-ignore no-explicit-any
    options?: any,
  ) {
    return getClient()(url, options);
  };

  // Method shortcuts
  for (const method of HTTP_METHODS) {
    // deno-lint-ignore no-explicit-any
    proxy[method] = (url: string | URL | Request, options?: any) => getClient()[method](url, options);
  }

  // extend() — returns a new HttpClient that merges options with the resolved base
  // deno-lint-ignore no-explicit-any
  proxy.extend = (options: any) => getClient().extend(options);

  return proxy as HttpClient;
}

// =============================================================================
// Lazy plugin builder
// =============================================================================

/**
 * Build lazy property descriptors for plugin factories.
 * Each plugin is instantiated on first property access with a WeakMap cache
 * keyed by the internal runtime identity.
 *
 * Returns PropertyDescriptorMap (not a ready object) so the caller can use
 * Object.defineProperties() without triggering getters via spread.
 *
 * @internal
 */
/** Reserved keys that plugins cannot shadow. */
const RESERVED_KEYS = new Set(["vars", "secrets", "http"]);

function normalizePluginEntry<T>(
  entry: PluginFactory<T> | PluginEntry<T>,
): PluginEntry<T> {
  if ("factory" in entry) return entry as PluginEntry<T>;
  return { factory: entry as PluginFactory<T> };
}

function toMethodList(value?: string | string[]): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((method) => method.toUpperCase());
}

function toUrlString(input: string | URL | Request): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return input;
}

function toPathname(input: string | URL | Request): string {
  try {
    if (input instanceof Request) return new URL(input.url).pathname;
    if (input instanceof URL) return input.pathname;
    const isAbsolute = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(input);
    const parsed = isAbsolute ? new URL(input) : new URL(input, "http://glubean.local");
    return parsed.pathname;
  } catch {
    return "";
  }
}

function matchesPattern(value: string, pattern: string | RegExp): boolean {
  if (pattern instanceof RegExp) return pattern.test(value);
  return value.startsWith(pattern);
}

function matchesRequestMatcher(
  matcher: RequestMatcher,
  method: string,
  url: string | URL | Request,
): boolean {
  const methods = toMethodList(matcher.method);
  if (methods.length > 0 && !methods.includes(method)) {
    return false;
  }

  if (matcher.url) {
    const rawUrl = toUrlString(url);
    if (!matchesPattern(rawUrl, matcher.url)) {
      return false;
    }
  }

  if (matcher.path) {
    const pathname = toPathname(url);
    if (!matchesPattern(pathname, matcher.path)) {
      return false;
    }
  }

  return true;
}

function evaluateRequestActivation(
  activation: PluginActivation | undefined,
  method: string,
  url: string | URL | Request,
): { active: boolean; reason?: string } {
  const rules = activation?.requests;
  if (!rules) return { active: true };

  const exclude = rules.exclude ?? [];
  if (exclude.some((matcher) => matchesRequestMatcher(matcher, method, url))) {
    return {
      active: false,
      reason: "request matches activation.requests.exclude",
    };
  }

  const include = rules.include ?? [];
  if (include.length > 0 && !include.some((matcher) => matchesRequestMatcher(matcher, method, url))) {
    return {
      active: false,
      reason: "request does not match activation.requests.include",
    };
  }

  return { active: true };
}

function evaluateTagActivation(
  activation: PluginActivation | undefined,
  runtime: InternalRuntime,
): { active: boolean; reason?: string } {
  const rules = activation?.tags;
  if (!rules) return { active: true };

  const runtimeTags = new Set(runtime.test?.tags ?? []);
  const disable = rules.disable ?? [];
  for (const tag of disable) {
    if (runtimeTags.has(tag)) {
      return {
        active: false,
        reason: `test tag "${tag}" matches activation.tags.disable`,
      };
    }
  }

  const enable = rules.enable ?? [];
  if (enable.length > 0) {
    const matched = enable.some((tag) => runtimeTags.has(tag));
    if (!matched) {
      return {
        active: false,
        reason: `current test tags do not match activation.tags.enable (${enable.join(", ")})`,
      };
    }
  }

  return { active: true };
}

function buildActivationAwareHttpClient(
  pluginName: string,
  activation: PluginActivation | undefined,
  http: HttpClient,
): HttpClient {
  if (!activation?.requests) return http;

  function assertRequestActive(
    method: string,
    url: string | URL | Request,
  ): void {
    const decision = evaluateRequestActivation(activation, method, url);
    if (decision.active) return;
    throw new Error(
      `Plugin "${pluginName}" is inactive for request ${method} ${toUrlString(url)}: ${decision.reason}.`,
    );
  }

  const METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;
  // deno-lint-ignore no-explicit-any
  const wrapped: any = function (
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ) {
    const method = (options?.method ?? (url instanceof Request ? url.method : "GET")).toUpperCase();
    assertRequestActive(method, url);
    return http(url, options);
  };

  for (const methodName of METHODS) {
    wrapped[methodName] = (url: string | URL | Request, options?: HttpRequestOptions) => {
      assertRequestActive(methodName.toUpperCase(), url);
      return http[methodName](url, options);
    };
  }

  wrapped.extend = (options: HttpRequestOptions): HttpClient =>
    buildActivationAwareHttpClient(
      pluginName,
      activation,
      http.extend(options),
    );

  return wrapped as HttpClient;
}

/**
 * Resolve (or retrieve cached) the real plugin instance for the current runtime.
 *
 * @internal
 */
function resolvePlugin(
  name: string,
  // deno-lint-ignore no-explicit-any
  entry: PluginEntry<any>,
  cache: WeakMap<InternalRuntime, unknown>,
): unknown {
  const runtime = getRuntime();
  const tagDecision = evaluateTagActivation(entry.activation, runtime);
  if (!tagDecision.active) {
    const testId = runtime.test?.id;
    throw new Error(
      `Plugin "${name}" is inactive${testId ? ` for test "${testId}"` : ""}: ${tagDecision.reason}.`,
    );
  }

  if (cache.has(runtime)) return cache.get(runtime);

  // Build the augmented runtime that plugins see
  const noop = () => {};
  const augmented: GlubeanRuntime = {
    vars: runtime.vars,
    secrets: runtime.secrets,
    http: buildActivationAwareHttpClient(
      name,
      entry.activation,
      runtime.http,
    ),
    test: runtime.test,
    requireVar,
    requireSecret,
    resolveTemplate: (template: string) => resolveTemplate(template, runtime.vars, runtime.secrets),
    action: runtime.action?.bind(runtime) ?? noop,
    event: runtime.event?.bind(runtime) ?? noop,
    log: runtime.log?.bind(runtime) ?? noop,
  };

  const instance = entry.factory.create(augmented);
  cache.set(runtime, instance);
  return instance;
}

/**
 * Build a Proxy that defers plugin creation until the plugin is actually used.
 *
 * This allows `const { chrome } = configure(...)` to work at module top-level —
 * the destructured value is a transparent Proxy, not the real plugin instance.
 * The real instance is created lazily on first property access / method call
 * during test execution.
 *
 * @internal
 */
function buildLazyPlugin(
  name: string,
  // deno-lint-ignore no-explicit-any
  entry: PluginEntry<any>,
): unknown {
  const cache = new WeakMap<InternalRuntime, unknown>();

  return new Proxy(Object.create(null), {
    get(_target, prop, receiver) {
      const instance = resolvePlugin(name, entry, cache);
      // deno-lint-ignore no-explicit-any
      const value = Reflect.get(instance as any, prop, receiver);
      return typeof value === "function"
        // deno-lint-ignore no-explicit-any
        ? value.bind(instance as any)
        : value;
    },
    set(_target, prop, value) {
      const instance = resolvePlugin(name, entry, cache);
      // deno-lint-ignore no-explicit-any
      return Reflect.set(instance as any, prop, value);
    },
    has(_target, prop) {
      const instance = resolvePlugin(name, entry, cache);
      // deno-lint-ignore no-explicit-any
      return Reflect.has(instance as any, prop);
    },
    ownKeys() {
      const instance = resolvePlugin(name, entry, cache);
      // deno-lint-ignore no-explicit-any
      return Reflect.ownKeys(instance as any);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const instance = resolvePlugin(name, entry, cache);
      // deno-lint-ignore no-explicit-any
      return Object.getOwnPropertyDescriptor(instance as any, prop);
    },
  });
}

function buildLazyPlugins(
  // deno-lint-ignore no-explicit-any
  plugins: Record<string, PluginFactory<any> | PluginEntry<any>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [name, rawEntry] of Object.entries(plugins)) {
    if (RESERVED_KEYS.has(name)) {
      throw new Error(
        `Plugin name "${name}" conflicts with a reserved configure() field. ` +
          `Choose a different key (reserved: ${[...RESERVED_KEYS].join(", ")}).`,
      );
    }
    result[name] = buildLazyPlugin(name, normalizePluginEntry(rawEntry));
  }

  return result;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Declare file-level dependencies on vars, secrets, and HTTP configuration.
 *
 * Returns lazy accessors that resolve at test runtime, not at import time.
 * All declared vars and secrets are **required** — missing values cause the test
 * to fail immediately with a clear error message.
 *
 * The returned objects can be shared across files via re-exports.
 *
 * @param options Configuration declaring vars, secrets, and HTTP defaults
 * @returns Lazy accessors for vars, secrets, and a pre-configured HTTP client
 *
 * @example Basic usage
 * ```ts
 * import { test, configure } from "@glubean/sdk";
 *
 * const { vars, http } = configure({
 *   vars: { baseUrl: "base_url" },
 *   http: { prefixUrl: "base_url" },
 * });
 *
 * export const listUsers = test("list-users", async (ctx) => {
 *   const res = await http.get("users").json();
 *   ctx.log(`Base URL: ${vars.baseUrl}`);
 * });
 * ```
 *
 * @example Full configuration with secrets
 * ```ts
 * const { vars, secrets, http } = configure({
 *   vars: { baseUrl: "base_url", orgId: "org_id" },
 *   secrets: { apiKey: "api_key" },
 *   http: {
 *     prefixUrl: "base_url",
 *     headers: { Authorization: "Bearer {{api_key}}" },
 *   },
 * });
 * ```
 *
 * @example Shared across test files
 * ```ts
 * // tests/configure.ts
 * export const { vars, secrets, http } = configure({ ... });
 *
 * // tests/users.test.ts
 * import { http, vars } from "./configure.ts";
 * ```
 */
export function configure<
  V extends Record<string, string> = Record<string, string>,
  S extends Record<string, string> = Record<string, string>,
  // deno-lint-ignore no-explicit-any
  P extends Record<string, PluginFactory<any> | PluginEntry<any>> = Record<
    string,
    never
  >,
>(
  options: ConfigureOptions & {
    vars?: { [K in keyof V]: string };
    secrets?: { [K in keyof S]: string };
    plugins?: P & { [K in ReservedConfigureKeys]?: never };
  },
):
  & ConfigureResult<
    { [K in keyof V]: string },
    { [K in keyof S]: string }
  >
  & ResolvePlugins<P> {
  const vars = options.vars
    ? buildLazyVars<{ [K in keyof V]: string }>(options.vars)
    : ({} as Readonly<{ [K in keyof V]: string }>);

  const secrets = options.secrets
    ? buildLazySecrets<{ [K in keyof S]: string }>(options.secrets)
    : ({} as Readonly<{ [K in keyof S]: string }>);

  const http = options.http ? buildLazyHttp(options.http) : buildPassthroughHttp();

  const base = { vars, secrets, http };

  if (options.plugins) {
    Object.assign(base, buildLazyPlugins(options.plugins));
  }

  return base as
    & ConfigureResult<
      { [K in keyof V]: string },
      { [K in keyof S]: string }
    >
    & ResolvePlugins<P>;
}

/**
 * Build a passthrough HTTP client that simply delegates to ctx.http.
 * Used when `configure()` is called without `http` options.
 *
 * @internal
 */
function buildPassthroughHttp(): HttpClient {
  const HTTP_METHODS = [
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
  ] as const;

  // deno-lint-ignore no-explicit-any
  const proxy: any = function (
    url: string | URL | Request,
    // deno-lint-ignore no-explicit-any
    options?: any,
  ) {
    return getRuntime().http(url, options);
  };

  for (const method of HTTP_METHODS) {
    // deno-lint-ignore no-explicit-any
    proxy[method] = (url: string | URL | Request, options?: any) => getRuntime().http[method](url, options);
  }

  // deno-lint-ignore no-explicit-any
  proxy.extend = (options: any) => getRuntime().http.extend(options);

  return proxy as HttpClient;
}
