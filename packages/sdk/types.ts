// =============================================================================
// Error Types
// =============================================================================

/**
 * Error thrown when a required variable or secret is missing or fails validation.
 *
 * @example
 * ```ts
 * try {
 *   const baseUrl = ctx.vars.require("BASE_URL");
 * } catch (err) {
 *   if (err instanceof GlubeanValidationError) {
 *     ctx.log(`Missing ${err.type}: ${err.key}`);
 *   }
 * }
 * ```
 */
export class GlubeanValidationError extends Error {
  constructor(
    /** The key that was being accessed (e.g., "API_KEY") */
    public readonly key: string,
    /** The error message */
    message: string,
    /** Whether this is a variable or secret */
    public readonly type: "var" | "secret",
  ) {
    super(`Invalid ${type} "${key}": ${message}`);
    this.name = "GlubeanValidationError";
  }
}

/**
 * Error thrown when a test is dynamically skipped.
 *
 * @example
 * ```ts
 * if (!ctx.vars.get("FEATURE_FLAG")) {
 *   ctx.skip("Feature not enabled");
 * }
 * ```
 */
export class GlubeanSkipError extends Error {
  constructor(
    /** Optional reason for skipping */
    public readonly reason?: string,
  ) {
    super(reason ? `Test skipped: ${reason}` : "Test skipped");
    this.name = "GlubeanSkipError";
  }
}

/**
 * Validator function for require() method.
 *
 * Return values:
 * - `true` or `undefined` or `null`: validation passed
 * - `false`: validation failed (generic error)
 * - `string`: validation failed with custom error message
 *
 * @example
 * // Simple boolean validation
 * (v) => v.length >= 16
 *
 * // With custom error message
 * (v) => v.length >= 16 ? true : `must be at least 16 characters, got ${v.length}`
 *
 * // Alternative style
 * (v) => {
 *   if (!v.startsWith("https://")) return "must start with https://";
 *   if (!v.includes(".")) return "must be a valid URL";
 * }
 */
export type ValidatorFn = (value: string) => boolean | string | void | null;

/**
 * Provides safe access to environment variables for a test run.
 * Use for non-sensitive configuration such as URLs, ports, regions, and feature flags.
 *
 * **For credentials (API keys, tokens, passwords), use {@link SecretsAccessor | ctx.secrets} instead.**
 * Secrets are loaded from `.secrets` files, automatically redacted in traces, and never
 * appear in logs or dashboards.
 *
 * Use `require` when a value must exist to avoid silent failures.
 *
 * @example
 * const baseUrl = ctx.vars.require("BASE_URL");
 * const port = ctx.vars.require("PORT", (v) => !isNaN(Number(v)));
 */
export interface VarsAccessor {
  /**
   * Returns the value if present, otherwise undefined.
   *
   * @example
   * const region = ctx.vars.get("REGION") ?? "us-east-1";
   */
  get(key: string): string | undefined;

  /**
   * Returns the value or throws a clear error if missing or invalid.
   * Optionally accepts a validator function for custom validation.
   *
   * @param key - The variable key to retrieve
   * @param validate - Optional validator function. Return false or error string if invalid.
   *
   * @example Basic usage
   * const baseUrl = ctx.vars.require("BASE_URL");
   *
   * @example With boolean validation
   * const port = ctx.vars.require("PORT", (v) => !isNaN(Number(v)));
   *
   * @example With custom error message
   * const endpoint = ctx.vars.require("CALLBACK_URL", (v) =>
   *   v.startsWith("https://") ? true : "must start with https://"
   * );
   */
  require(key: string, validate?: ValidatorFn): string;

  /**
   * Returns a copy of all vars for diagnostics or logging.
   * Vars contain only non-sensitive config, so this is safe to log.
   *
   * @example
   * ctx.log("Config", ctx.vars.all());
   */
  all(): Record<string, string>;
}

/**
 * Provides safe access to secrets (API keys, tokens, passwords) for a test run.
 *
 * Secrets are loaded from `.secrets` files, automatically redacted in traces
 * and logs, and never appear in dashboards. Use `require` when a secret must
 * exist to avoid silent failures.
 *
 * **For non-sensitive config (URLs, ports, flags), use {@link VarsAccessor | ctx.vars} instead.**
 *
 * @example
 * const apiKey = ctx.secrets.require("API_KEY");
 * const token = ctx.secrets.require("JWT", (v) => v.split(".").length === 3);
 */
export interface SecretsAccessor {
  /**
   * Returns the secret value if present, otherwise undefined.
   *
   * @example
   * const token = ctx.secrets.get("REFRESH_TOKEN");
   */
  get(key: string): string | undefined;

  /**
   * Returns the secret value or throws a clear error if missing or invalid.
   * Optionally accepts a validator function for custom validation.
   *
   * @param key - The secret key to retrieve
   * @param validate - Optional validator function. Return false or error string if invalid.
   *
   * @example Basic usage
   * const apiKey = ctx.secrets.require("API_KEY");
   *
   * @example With custom error message
   * const key = ctx.secrets.require("API_KEY", (v) =>
   *   v.startsWith("sk-") ? true : "must start with 'sk-'"
   * );
   */
  require(key: string, validate?: ValidatorFn): string;
}

/**
 * The context passed to every test function.
 * Provides access to environment variables, secrets, logging, assertions, API tracing,
 * and a pre-configured HTTP client.
 *
 * @example Typical test using ctx
 * ```ts
 * export const getUsers = test("get-users", async (ctx) => {
 *   const baseUrl = ctx.vars.require("BASE_URL");
 *   const apiKey = ctx.secrets.require("API_KEY");
 *
 *   const res = await ctx.http.get(`${baseUrl}/users`, {
 *     headers: { Authorization: `Bearer ${apiKey}` },
 *   });
 *   ctx.expect(res).toHaveStatus(200);
 *
 *   const body = await res.json();
 *   ctx.expect(body.users).toHaveLength(10);
 * });
 * ```
 *
 * @example Anti-pattern: don't use vars for credentials
 * ```ts
 * // ❌ BAD: credential in vars — visible in traces and dashboards
 * const apiKey = ctx.vars.require("API_KEY");
 *
 * // ✅ GOOD: credential in secrets — auto-redacted in traces
 * const apiKey = ctx.secrets.require("API_KEY");
 * ```
 */
export interface TestContext {
  /** Environment variables accessor (e.g., BASE_URL) */
  vars: VarsAccessor;
  /** Secrets accessor (e.g., API_KEY) - injected securely */
  secrets: SecretsAccessor;

  /**
   * Pre-configured HTTP client with auto-tracing, auto-metrics, and retry.
   * Powered by ky. Every request automatically records:
   * - API trace via `ctx.trace()` (method, URL, status, duration)
   * - Metric `http_duration_ms` via `ctx.metric()` (with method and path tags)
   *
   * Can be called directly or via method shortcuts.
   *
   * @example GET request
   * ```ts
   * const users = await ctx.http.get(`${baseUrl}/users`).json();
   * ```
   *
   * @example POST with JSON body
   * ```ts
   * const user = await ctx.http.post(`${baseUrl}/users`, {
   *   json: { name: "test" },
   * }).json();
   * ```
   *
   * @example With retry
   * ```ts
   * const data = await ctx.http.get(`${baseUrl}/flaky`, { retry: 3 }).json();
   * ```
   *
   * @example Callable shorthand (same as ky(url, options))
   * ```ts
   * const res = await ctx.http(`${baseUrl}/users`);
   * ```
   *
   * @example Create scoped client with shared config
   * ```ts
   * const api = ctx.http.extend({
   *   prefixUrl: baseUrl,
   *   headers: { Authorization: `Bearer ${token}` },
   * });
   * const users = await api.get("users").json();
   * ```
   */
  http: HttpClient;

  /**
   * Logging function - streams to runner stdout.
   * @example ctx.log("User created", { id: 123 })
   */
  log(message: string, data?: unknown): void;

  /**
   * Low-level assertion — records a pass/fail event in the test trace.
   *
   * **Always provide a descriptive `message`** that explains *what* is being
   * checked and *why* it matters. Generic messages like `"status check"` are
   * unhelpful in dashboards, CI logs, and MCP tool output. Good messages read
   * like a sentence: `"GET /users should return 200"`.
   *
   * Prefer `ctx.expect` for most assertions (fluent, auto-generates actual/expected).
   * Use `ctx.assert` when you need a simple boolean guard with a custom message.
   *
   * Overload 1: Simple boolean check
   *
   * @example Good — descriptive message
   * ```ts
   * ctx.assert(res.ok, "GET /users should return 2xx");
   * ctx.assert(body.items.length > 0, "Response should contain at least one item");
   * ctx.assert(res.status === 200, "Create user status", { actual: res.status, expected: 200 });
   * ```
   *
   * @example Bad — vague message (avoid)
   * ```ts
   * ctx.assert(res.ok); // no message at all
   * ctx.assert(res.ok, "check"); // too vague
   * ```
   */
  assert(
    condition: boolean,
    message?: string,
    details?: AssertionDetails,
  ): void;

  /**
   * Low-level assertion — records a pass/fail event in the test trace.
   *
   * Overload 2: Explicit result object (useful for complex logic).
   *
   * @example
   * ```ts
   * ctx.assert(
   *   { passed: res.status === 200, actual: res.status, expected: 200 },
   *   "POST /orders should return 200",
   * );
   * ```
   */
  assert(result: AssertionResultInput, message?: string): void;

  /**
   * Fluent assertion API — Jest/Vitest style.
   *
   * **Soft-by-default**: failed assertions are recorded but do NOT throw.
   * All assertions run and all failures are collected.
   *
   * Use `.orFail()` to guard assertions where subsequent code depends on the result.
   * Use `.not` to negate any assertion.
   *
   * **Assertion messages**: Every matcher accepts an optional `message` string as
   * its **last argument**. When provided, it is prepended to the auto-generated
   * message, making failures far more actionable in Trace Viewer, CI, and MCP output.
   *
   * **Always pass a message** that describes the request or business context —
   * e.g. `"GET /users status"`, `"created order id"`, `"auth token format"`.
   *
   * @example With descriptive messages (recommended)
   * ```ts
   * ctx.expect(res.status).toBe(200, "GET /users status");
   * // on failure → "GET /users status: expected 401 to be 200"
   *
   * ctx.expect(body.items).toHaveLength(3, "search result count");
   * ctx.expect(res).toHaveHeader("content-type", /json/, "response content type");
   * ```
   *
   * @example Guard — abort if this fails
   * ```ts
   * ctx.expect(res.status).toBe(200, "POST /orders").orFail();
   * const body = await res.json(); // safe — status was 200
   * ```
   *
   * @example Without message (still works, less readable in reports)
   * ```ts
   * ctx.expect(res.status).toBe(200);
   * ctx.expect(body.name).toBeType("string");
   * ```
   *
   * @example Negation
   * ```ts
   * ctx.expect(body.banned).not.toBe(true, "user should not be banned");
   * ```
   *
   * @example HTTP-specific
   * ```ts
   * ctx.expect(res).toHaveStatus(200, "GET /users");
   * ctx.expect(res).toHaveHeader("content-type", /json/, "content type");
   * ```
   */
  expect<V>(actual: V): import("./expect.ts").Expectation<V>;

  /**
   * Soft check — records a warning but never affects test pass/fail.
   *
   * Use `ctx.warn` for "should" conditions that are not hard requirements.
   * Same mental model as `ctx.assert`: `condition=true` means OK, `condition=false` triggers a warning.
   *
   * - `assert` = **must** (failure = test fails)
   * - `warn` = **should** (failure = recorded but test still passes)
   *
   * @param condition `true` if OK, `false` triggers warning
   * @param message Human-readable description
   *
   * @example Performance budget
   * ```ts
   * ctx.warn(duration < 500, "Response should be under 500ms");
   * ```
   *
   * @example Best practice check
   * ```ts
   * ctx.warn(res.headers.has("cache-control"), "Should have cache headers");
   * ```
   *
   * @example HTTPS check
   * ```ts
   * ctx.warn(avatarUrl.startsWith("https"), "Avatar should use HTTPS");
   * ```
   */
  warn(condition: boolean, message: string): void;

  /**
   * Validate data against a schema (Zod, Valibot, or any `SchemaLike<T>`).
   *
   * The runner prefers `safeParse` (no-throw) and falls back to `parse` (try/catch).
   * Returns the parsed value on success, or `undefined` on failure.
   *
   * **Severity controls what happens on failure:**
   * - `"error"` (default) — counts as a failed assertion (test fails)
   * - `"warn"` — recorded as warning only (test still passes)
   * - `"fatal"` — immediately aborts test execution
   *
   * A `schema_validation` event is always emitted regardless of severity.
   *
   * @param data The data to validate
   * @param schema A schema implementing `safeParse` or `parse`
   * @param label Human-readable label (e.g., "response body", "query params")
   * @param options Severity and other options
   * @returns Parsed value on success, `undefined` on failure
   *
   * @example Default severity (error — counts as assertion failure)
   * ```ts
   * const user = ctx.validate(body, UserSchema, "response body");
   * ```
   *
   * @example Warning only — record but don't fail
   * ```ts
   * ctx.validate(body, StrictSchema, "strict contract", { severity: "warn" });
   * ```
   *
   * @example Fatal — abort test on invalid response
   * ```ts
   * const user = ctx.validate(body, UserSchema, "response body", { severity: "fatal" });
   * // Only reached if validation passed
   * ```
   */
  validate<T>(
    data: unknown,
    schema: SchemaLike<T>,
    label?: string,
    options?: ValidateOptions,
  ): T | undefined;

  /**
   * API Tracing - manually report network calls.
   * @example ctx.trace({ method: "GET", url: "...", status: 200, duration: 100 })
   */
  trace(request: ApiTrace): void;

  /**
   * Report a numeric metric for performance tracking and trending.
   *
   * Metrics are stored separately from logs/traces with longer retention (90 days)
   * and are optimized for time-series queries and dashboards.
   *
   * Security note: metric names and tags are observable metadata and are not
   * intended to carry secrets or PII. Never include tokens, API keys, emails,
   * phone numbers, or user identifiers in `name` / `options.tags`.
   *
   * @param name Metric name (e.g., "api_duration_ms", "response_size_bytes")
   * @param value Numeric value
   * @param options Optional unit and tags
   *
   * @example Basic usage
   * ```ts
   * ctx.metric("api_duration_ms", Date.now() - start);
   * ```
   *
   * @example With unit
   * ```ts
   * ctx.metric("response_size", body.length, { unit: "bytes" });
   * ```
   *
   * @example Server-side duration from response
   * ```ts
   * const data = await res.json();
   * ctx.metric("server_processing_ms", data.processing_time, { unit: "ms" });
   * ctx.metric("route_count", data.result.summary.routes, { unit: "count" });
   * ```
   *
   * @example With tags for slicing in dashboards
   * ```ts
   * ctx.metric("latency_ms", duration, {
   *   unit: "ms",
   *   tags: { endpoint: "/api/v2/optimize", method: "POST" },
   * });
   * ```
   *
   * @example Anti-pattern (do not do this)
   * ```ts
   * // Bad: secret data embedded in metric dimensions
   * ctx.metric("token_check", 1, { tags: { token: ctx.secrets.require("API_KEY") } });
   * ```
   */
  metric(name: string, value: number, options?: MetricOptions): void;

  /**
   * Dynamically skip the current test.
   * Throws a GlubeanSkipError that is caught by the runner.
   *
   * @param reason Optional reason for skipping
   *
   * @example Skip based on feature flag
   * ```ts
   * if (!ctx.vars.get("FEATURE_ENABLED")) {
   *   ctx.skip("Feature not enabled in this environment");
   * }
   * ```
   *
   * @example Skip if API key is missing
   * ```ts
   * const apiKey = ctx.secrets.get("API_KEY");
   * if (!apiKey) {
   *   ctx.skip("API_KEY not configured");
   * }
   * ```
   */
  skip(reason?: string): never;

  /**
   * Immediately fail and abort the current test.
   * Unlike `ctx.assert(false, msg)` which records a failure but continues,
   * `ctx.fail()` throws and stops execution immediately.
   *
   * Use this when execution reaches a point that should be unreachable,
   * or when a request unexpectedly succeeds and the test should abort.
   *
   * @param message Reason for the failure
   *
   * @example Fail if a request that should error succeeds
   * ```ts
   * const res = await ctx.http.delete(`${ctx.vars.require("BASE_URL")}/protected`, {
   *   throwHttpErrors: false,
   * });
   * if (res.ok) {
   *   ctx.fail("Expected 403 but request succeeded");
   * }
   * ctx.expect(res.status).toBe(403);
   * ```
   *
   * @example Guard against unreachable code
   * ```ts
   * if (status === "deleted") {
   *   ctx.fail("Resource should not be deleted at this point");
   * }
   * ```
   */
  fail(message: string): never;

  /**
   * Poll a function repeatedly until it returns a truthy value or times out.
   * Useful for eventually-consistent systems where state takes time to converge.
   *
   * **Behavior:**
   * - Calls `fn()` every `intervalMs` (default 1000ms)
   * - If `fn()` returns truthy → resolves immediately
   * - If `fn()` returns falsy → waits and retries
   * - If `fn()` throws → captures error, waits and retries
   * - If `timeoutMs` exceeded and no `onTimeout` → throws Error (test fails)
   * - If `timeoutMs` exceeded and `onTimeout` present → calls `onTimeout`, returns without throwing
   *
   * @param options Polling configuration
   * @param fn Async function to poll. Return truthy to stop.
   *
   * @example Wait for resource to be ready (timeout = test failure)
   * ```ts
   * await ctx.pollUntil({ timeoutMs: 30_000 }, async () => {
   *   const res = await ctx.http.get(`${baseUrl}/status`);
   *   return res.ok;
   * });
   * ```
   *
   * @example Silent timeout — log but don't fail
   * ```ts
   * await ctx.pollUntil(
   *   {
   *     timeoutMs: 5_000,
   *     intervalMs: 500,
   *     onTimeout: (err) => {
   *       ctx.log(`Webhook not received: ${err?.message ?? "timeout"}`);
   *     },
   *   },
   *   async () => {
   *     const hooks = await ctx.http.get(`${baseUrl}/webhooks`).json();
   *     return hooks.length > 0;
   *   }
   * );
   * ```
   */
  pollUntil(
    options: PollUntilOptions,
    fn: () => Promise<boolean | unknown>,
  ): Promise<void>;

  /**
   * Dynamically set the timeout for the current test.
   * Must be called before any async operations.
   *
   * Semantics: this updates the remaining runtime budget from the moment
   * `setTimeout()` is called (relative deadline), not from test start time.
   *
   * @param ms Timeout in milliseconds
   *
   * @example Increase timeout for slow endpoint
   * ```ts
   * ctx.setTimeout(60000); // 60 seconds
   * const res = await ctx.http.get(ctx.vars.require("SLOW_API_URL"));
   * ```
   *
   * @example Set timeout based on environment
   * ```ts
   * const isProd = ctx.vars.get("ENV") === "production";
   * ctx.setTimeout(isProd ? 30000 : 10000);
   * ```
   */
  setTimeout(ms: number): void;

  /**
   * Current execution retry count (0 for first attempt, 1+ for re-runs).
   *
   * Retry orchestration is owned by the runner/control plane, not by SDK user
   * code. `ctx.retryCount` is injected into context at execution start and is
   * read-only inside the test.
   *
   * Important distinction:
   * - `ctx.retryCount` tracks whole-test re-runs.
   * - Step retries from `StepMeta.retries` happen within one execution and do
   *   not increment `ctx.retryCount`.
   *
   * Useful for logging, backoff, or idempotency behavior on re-runs.
   *
   * @example Log retry attempts
   * ```ts
   * if (ctx.retryCount > 0) {
   *   ctx.log(`Retry attempt ${ctx.retryCount}`);
   * }
   * ```
   *
   * @example Different behavior on retry
   * ```ts
   * const timeout = ctx.retryCount === 0 ? 5000 : 10000;
   * const res = await ctx.http.get(url, { timeout });
   * ```
   */
  readonly retryCount: number;

  /**
   * Get current memory usage statistics.
   * Only available in Deno runtime (returns null in other environments).
   * Useful for debugging memory issues and profiling tests locally.
   *
   * @returns Memory usage stats or null if not available
   *
   * @example Log current memory usage
   * ```ts
   * const mem = ctx.getMemoryUsage();
   * if (mem) {
   *   ctx.log(`Heap used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
   *   ctx.log(`Heap total: ${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`);
   * }
   * ```
   *
   * @example Track memory delta
   * ```ts
   * const before = ctx.getMemoryUsage();
   * // ... perform memory-intensive operation
   * const after = ctx.getMemoryUsage();
   * if (before && after) {
   *   const delta = (after.heapUsed - before.heapUsed) / 1024 / 1024;
   *   ctx.log(`Memory delta: ${delta.toFixed(2)} MB`);
   * }
   * ```
   */
  getMemoryUsage(): {
    /** Heap memory currently used (bytes) */
    heapUsed: number;
    /** Total heap memory allocated (bytes) */
    heapTotal: number;
    /** Memory used by C++ objects bound to JS (bytes) */
    external: number;
    /** Resident set size - total memory allocated for the process (bytes) */
    rss: number;
  } | null;
}

// =============================================================================
// Configure API Types
// =============================================================================

/**
 * Options for the `configure()` function.
 *
 * Declares file-level dependencies on vars, secrets, and HTTP client
 * configuration. All declared vars and secrets are **required** — if missing
 * at runtime, the test fails immediately with a clear error.
 *
 * For optional vars, use `ctx.vars.get()` directly inside the test function
 * instead of declaring them in `configure()`.
 *
 * @example
 * ```ts
 * const { vars, secrets, http } = configure({
 *   vars: { baseUrl: "BASE_URL", orgId: "ORG_ID" },
 *   secrets: { apiKey: "API_KEY" },
 *   http: {
 *     prefixUrl: "BASE_URL",
 *     headers: { Authorization: "Bearer {{API_KEY}}" },
 *   },
 * });
 * ```
 */
export interface ConfigureOptions {
  /**
   * Map of friendly property names to var keys.
   * Each key becomes a property on the returned `vars` object.
   * All declared vars are **required** — missing values throw at runtime.
   *
   * @example
   * ```ts
   * const { vars } = configure({
   *   vars: { baseUrl: "BASE_URL", orgId: "ORG_ID" },
   * });
   * vars.baseUrl; // string (required, never undefined)
   * ```
   */
  vars?: Record<string, string>;

  /**
   * Map of friendly property names to secret keys.
   * Each key becomes a property on the returned `secrets` object.
   * All declared secrets are **required** — missing values throw at runtime.
   *
   * @example
   * ```ts
   * const { secrets } = configure({
   *   secrets: { apiKey: "API_KEY" },
   * });
   * secrets.apiKey; // string (required, never undefined)
   * ```
   */
  secrets?: Record<string, string>;

  /**
   * Pre-configure an HTTP client with shared defaults.
   *
   * - `prefixUrl`: A var key (string) whose runtime value becomes the base URL.
   * - `headers`: Header values can use `{{key}}` syntax to interpolate secrets.
   * - `timeout`, `retry`, `throwHttpErrors`: Passed through to ky.
   *
   * The returned `http` client inherits all `ctx.http` features
   * (auto-tracing, auto-metrics, schema validation) and supports `.extend()`.
   *
   * @example
   * ```ts
   * const { http } = configure({
   *   http: {
   *     prefixUrl: "base_url",
   *     headers: { Authorization: "Bearer {{api_key}}" },
   *   },
   * });
   * // In tests:
   * const res = await http.get("users").json();
   * ```
   */
  http?: ConfigureHttpOptions;

  /**
   * Plugin factories keyed by name.
   * Each plugin is lazily instantiated on first property access during test execution.
   * Use `definePlugin()` to create plugin factories.
   *
   * @example
   * ```ts
   * import { graphql } from "@glubean/graphql";
   *
   * const { http, graphql: gql } = configure({
   *   http: { prefixUrl: "base_url" },
   *   plugins: {
   *     graphql: graphql({
   *       endpoint: "graphql_url",
   *       headers: { Authorization: "Bearer {{api_key}}" },
   *     }),
   *   },
   * });
   * ```
   */
  // deno-lint-ignore no-explicit-any
  plugins?: Record<string, PluginFactory<any>>;
}

/**
 * HTTP configuration for `configure()`.
 *
 * `prefixUrl` is a **var key** (resolved at runtime), not a literal URL.
 * Header values can contain `{{key}}` placeholders that are resolved from
 * the combined vars + secrets at runtime.
 */
export interface ConfigureHttpOptions {
  /**
   * Var key whose runtime value is used as the base URL (ky `prefixUrl`).
   * This is a var key name, not the URL itself.
   *
   * @example "BASE_URL" → resolved to ctx.vars.require("BASE_URL")
   */
  prefixUrl?: string;

  /**
   * Default headers. Values may contain `{{key}}` placeholders that are
   * resolved from vars and secrets at runtime.
   *
   * @example
   * ```ts
   * headers: {
   *   Authorization: "Bearer {{API_KEY}}",
   *   "X-Org-Id": "{{ORG_ID}}",
   * }
   * ```
   */
  headers?: Record<string, string>;

  /** Default request timeout in milliseconds. */
  timeout?: number | false;

  /**
   * Default retry configuration.
   * Number for simple retry count, or object for fine-grained control.
   *
   * @example Simple retry count
   * ```ts
   * retry: 3
   * ```
   *
   * @example Fine-grained control
   * ```ts
   * retry: {
   *   limit: 3,
   *   statusCodes: [429, 503],
   *   maxRetryAfter: 5000,
   * }
   * ```
   */
  retry?: number | HttpRetryOptions;

  /** Whether to throw on non-2xx responses (default: true). */
  throwHttpErrors?: boolean;

  /**
   * Hooks for intercepting HTTP request/response lifecycle.
   * Passed through to the underlying ky client.
   *
   * @example OAuth token injection
   * ```ts
   * import { oauth2 } from "@glubean/auth";
   *
   * const { http } = configure({
   *   http: oauth2.clientCredentials({
   *     prefixUrl: "base_url",
   *     tokenUrl: "token_url",
   *     clientId: "client_id",
   *     clientSecret: "client_secret",
   *   }),
   * });
   * ```
   */
  hooks?: HttpHooks;
}

/**
 * Return type of `configure()`.
 *
 * All properties are lazy — values are resolved from the runtime context
 * when first accessed during test execution, not at module load time.
 *
 * @template V Shape of the vars object (inferred from `ConfigureOptions.vars`)
 * @template S Shape of the secrets object (inferred from `ConfigureOptions.secrets`)
 *
 * @example
 * ```ts
 * const { vars, secrets, http } = configure({
 *   vars: { baseUrl: "BASE_URL" },
 *   secrets: { apiKey: "API_KEY" },
 *   http: { prefixUrl: "BASE_URL", headers: { Authorization: "Bearer {{API_KEY}}" } },
 * });
 *
 * export const myTest = test("my-test", async (ctx) => {
 *   ctx.log(`Using ${vars.baseUrl}`);
 *   const res = await http.get("users").json();
 *   ctx.expect(res.length).toBeGreaterThan(0);
 * });
 * ```
 */
export interface ConfigureResult<
  V extends Record<string, string> = Record<string, string>,
  S extends Record<string, string> = Record<string, string>,
> {
  /**
   * Lazy vars accessor. Each property reads from the runtime vars
   * using `require()` semantics — throws if missing.
   */
  vars: Readonly<V>;

  /**
   * Lazy secrets accessor. Each property reads from the runtime secrets
   * using `require()` semantics — throws if missing.
   */
  secrets: Readonly<S>;

  /**
   * Pre-configured HTTP client. Lazily constructed from `ctx.http.extend()`
   * on first use during test execution. Inherits auto-tracing and auto-metrics.
   *
   * Supports further `.extend()` for per-test customization.
   */
  http: HttpClient;
}

// =============================================================================
// Plugin Types
// =============================================================================

/**
 * A plugin factory that creates a lazy instance of type T.
 * Used with `configure({ plugins: { key: factory } })`.
 * Plugin authors should use `definePlugin()` instead of implementing directly.
 *
 * @example
 * ```ts
 * import { definePlugin } from "@glubean/sdk";
 *
 * export const myPlugin = (opts: MyOptions) =>
 *   definePlugin((runtime) => new MyClient(runtime, opts));
 * ```
 */
export interface PluginFactory<T> {
  /** Phantom field for TypeScript inference. Not used at runtime. */
  readonly __type: T;
  /** Called lazily on first access during test execution. */
  create(runtime: GlubeanRuntime): T;
}

/**
 * Runtime context available to plugin factories.
 * Exposes the same capabilities the harness provides to configure().
 *
 * Stability: fields may be added (minor), but existing field semantics
 * must not change without a major version bump. This is the contract
 * between the SDK and all plugins.
 *
 * @example
 * ```ts
 * definePlugin((runtime) => {
 *   const baseUrl = runtime.requireVar("base_url");
 *   const token = runtime.requireSecret("api_key");
 *   const header = runtime.resolveTemplate("Bearer {{api_key}}");
 *   return new MyClient(baseUrl, header);
 * });
 * ```
 */
export interface GlubeanRuntime {
  /** Resolved vars with env fallback */
  vars: Record<string, string>;
  /** Resolved secrets with env fallback */
  secrets: Record<string, string>;
  /** Pre-configured HTTP client with auto-tracing */
  http: HttpClient;
  /** Require a var (throws if missing) */
  requireVar(key: string): string;
  /** Require a secret (throws if missing) */
  requireSecret(key: string): string;
  /** Resolve {{key}} template placeholders from vars and secrets */
  resolveTemplate(template: string): string;
}

/**
 * Maps plugin factories to their resolved types.
 * Used internally by `configure()` to infer the return type.
 */
export type ResolvePlugins<P> = {
  [K in keyof P]: P[K] extends PluginFactory<infer T> ? T : never;
};

/**
 * Keys reserved by `ConfigureResult` that plugin names must not shadow.
 * Using one of these as a plugin key causes a compile-time error.
 */
export type ReservedConfigureKeys = "vars" | "secrets" | "http";

// =============================================================================
// HTTP Client Types (powered by ky)
// =============================================================================

/**
 * Promise returned by HTTP client methods.
 * Extends native `Promise<Response>` with convenience body-parsing methods.
 *
 * @example Parse JSON response
 * ```ts
 * const users = await ctx.http.get(`${baseUrl}/users`).json<User[]>();
 * ```
 *
 * @example Parse text response
 * ```ts
 * const html = await ctx.http.get(`${baseUrl}/page`).text();
 * ```
 */
export interface HttpResponsePromise extends Promise<Response> {
  /** Parse response body as JSON */
  json<T = unknown>(): Promise<T>;
  /** Parse response body as text */
  text(): Promise<string>;
  /** Parse response body as Blob */
  blob(): Promise<Blob>;
  /** Parse response body as ArrayBuffer */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Retry configuration for HTTP requests.
 *
 * @example
 * ```ts
 * const res = await ctx.http.get(url, {
 *   retry: { limit: 3, statusCodes: [429, 503] },
 * });
 * ```
 */
export interface HttpRetryOptions {
  /** Number of retry attempts (default: 2) */
  limit?: number;
  /** HTTP methods to retry (default: GET, PUT, HEAD, DELETE, OPTIONS, TRACE) */
  methods?: string[];
  /** HTTP status codes that trigger a retry (default: 408, 413, 429, 500, 502, 503, 504) */
  statusCodes?: number[];
  /** Maximum delay (ms) to wait based on Retry-After header */
  maxRetryAfter?: number;
}

/**
 * Options for HTTP requests.
 * Compatible with ky's Options interface.
 *
 * @example POST with JSON
 * ```ts
 * ctx.http.post(url, { json: { name: "test" } });
 * ```
 *
 * @example With search params and timeout
 * ```ts
 * ctx.http.get(url, {
 *   searchParams: { page: 1, limit: 10 },
 *   timeout: 5000,
 * });
 * ```
 */
export interface HttpRequestOptions {
  /** JSON body (automatically serialized and sets Content-Type) */
  json?: unknown;
  /** URL search parameters */
  searchParams?:
    | Record<string, string | number | boolean>
    | URLSearchParams
    | string;
  /** Request headers */
  headers?: Record<string, string> | Headers;
  /** Request timeout in milliseconds (default: 10000). Set `false` to disable. */
  timeout?: number | false;
  /** Retry configuration. Number for simple retry count, or object for fine-grained control. */
  retry?: number | HttpRetryOptions;
  /** Base URL prefix (prepended to the request URL) */
  prefixUrl?: string | URL;
  /** Whether to throw on non-2xx responses (default: true) */
  throwHttpErrors?: boolean;
  /** HTTP method override */
  method?: string;
  /** Request body (for non-JSON payloads) */
  body?: BodyInit;
  /** AbortSignal for request cancellation */
  signal?: AbortSignal;
  /** Hooks for request/response interception */
  hooks?: HttpHooks;
  /**
   * Schema validation for request and response.
   *
   * Schemas are validated automatically:
   * - `query` and `request` — validated before the request is sent
   * - `response` — validated after the response is received
   *
   * Each entry can be a bare schema (severity defaults to `"error"`)
   * or `{ schema, severity }` for explicit control.
   *
   * @example
   * ```ts
   * const res = await ctx.http.post(url, {
   *   json: payload,
   *   schema: {
   *     request: RequestBodySchema,
   *     response: ResponseSchema,
   *     query: { schema: QuerySchema, severity: "warn" },
   *   },
   * });
   * ```
   */
  schema?: HttpSchemaOptions;
}

/**
 * Hooks for intercepting HTTP request/response lifecycle.
 *
 * @example Log all requests
 * ```ts
 * const api = ctx.http.extend({
 *   hooks: {
 *     beforeRequest: [(request) => {
 *       ctx.log(`→ ${request.method} ${request.url}`);
 *     }],
 *   },
 * });
 * ```
 */
export interface HttpHooks {
  /** Called before each request. Can modify or replace the request. */
  beforeRequest?: Array<
    (
      request: Request,
      options: HttpRequestOptions,
    ) => Request | Response | void | Promise<Request | Response | void>
  >;
  /** Called after each response. Can modify or replace the response. */
  afterResponse?: Array<
    (
      request: Request,
      options: HttpRequestOptions,
      response: Response,
    ) => Response | void | Promise<Response | void>
  >;
  /** Called before each retry attempt. */
  beforeRetry?: Array<
    (details: {
      request: Request;
      options: HttpRequestOptions;
      error: Error;
      retryCount: number;
    }) => void | Promise<void>
  >;
}

/**
 * HTTP client interface powered by ky.
 *
 * Pre-configured with auto-tracing and auto-metrics.
 * Every request automatically records:
 * - API trace: method, URL, status, duration (via `ctx.trace()`)
 * - Metric: `http_duration_ms` with method and path tags (via `ctx.metric()`)
 *
 * Supports ky features: retry, timeout, hooks, JSON shortcuts, and `.extend()`.
 *
 * @example
 * ```ts
 * // Method shortcuts
 * const users = await ctx.http.get(`${baseUrl}/users`).json();
 * const created = await ctx.http.post(`${baseUrl}/users`, { json: { name: "test" } }).json();
 *
 * // Callable shorthand
 * const res = await ctx.http(`${baseUrl}/users`);
 *
 * // Create scoped client
 * const api = ctx.http.extend({ prefixUrl: baseUrl });
 * const user = await api.get("users/1").json();
 * ```
 */
export interface HttpClient {
  /** Make a request (generic). Same as ky(url, options). */
  (
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /** HTTP GET request */
  get(
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /** HTTP POST request */
  post(
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /** HTTP PUT request */
  put(
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /** HTTP PATCH request */
  patch(
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /** HTTP DELETE request */
  delete(
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /** HTTP HEAD request */
  head(
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /**
   * Create a new HTTP client instance with merged defaults.
   * The new instance inherits auto-tracing and auto-metrics.
   *
   * @example Scoped client with base URL and auth
   * ```ts
   * const api = ctx.http.extend({
   *   prefixUrl: ctx.vars.require("BASE_URL"),
   *   headers: { Authorization: `Bearer ${ctx.secrets.require("API_TOKEN")}` },
   * });
   * const users = await api.get("users").json();
   * const user = await api.get("users/1").json();
   * ```
   */
  extend(options: HttpRequestOptions): HttpClient;
}

// =============================================================================
// Schema Validation Types
// =============================================================================

/**
 * Protocol interface for any schema library (Zod, Valibot, ArkType, etc.).
 *
 * A schema is `SchemaLike<T>` if it implements **at least** `.safeParse()`.
 * If only `.parse()` is available it is also accepted (the runner wraps it in try/catch).
 *
 * @example Zod
 * ```ts
 * import { z } from "zod";
 * const UserSchema = z.object({ id: z.number(), name: z.string() });
 * // z.ZodType satisfies SchemaLike<T> out of the box
 * ```
 *
 * @example Custom schema
 * ```ts
 * const MySchema: SchemaLike<User> = {
 *   safeParse(data) {
 *     if (isValid(data)) return { success: true, data };
 *     return { success: false, error: { issues: [{ message: "invalid" }] } };
 *   },
 * };
 * ```
 */
export interface SchemaLike<T> {
  /** Preferred — returns a result object without throwing. */
  safeParse?: (data: unknown) =>
    | { success: true; data: T }
    | {
      success: false;
      error: {
        issues: Array<{ message: string; path?: Array<string | number> }>;
      };
    };
  /** Fallback — throws on failure, returns parsed value on success. */
  parse?: (data: unknown) => T;
}

/**
 * A single issue reported by schema validation.
 */
export interface SchemaIssue {
  /** Human-readable error message */
  message: string;
  /** Property path (e.g., ["user", "email"]) */
  path?: Array<string | number>;
}

/**
 * Options for `ctx.validate()`.
 */
export interface ValidateOptions {
  /**
   * How a validation failure is treated:
   * - `"error"` (default) — counts as a failed assertion (test fails)
   * - `"warn"` — recorded as warning only (test still passes)
   * - `"fatal"` — immediately aborts test execution
   */
  severity?: "error" | "warn" | "fatal";
}

/**
 * Schema validation entry for an HTTP request.
 * Can be a bare schema (severity defaults to `"error"`) or an object with explicit severity.
 */
export type SchemaEntry<T> =
  | SchemaLike<T>
  | { schema: SchemaLike<T>; severity?: "error" | "warn" | "fatal" };

/**
 * Schema configuration for automatic HTTP request/response validation.
 *
 * @example
 * ```ts
 * ctx.http.post(url, {
 *   json: payload,
 *   schema: {
 *     request: RequestBodySchema,
 *     response: ResponseSchema,
 *     query: QueryParamsSchema,
 *   },
 * });
 * ```
 */
export interface HttpSchemaOptions {
  /** Validate the request body (json option) before sending */
  request?: SchemaEntry<unknown>;
  /** Validate the response body after receiving */
  response?: SchemaEntry<unknown>;
  /** Validate the query/searchParams before sending */
  query?: SchemaEntry<unknown>;
}

// =============================================================================
// Assertion Types
// =============================================================================

/**
 * Details for assertion (actual/expected values).
 *
 * @example
 * ```ts
 * ctx.assert(res.status === 200, "Expected 200", {
 *   actual: res.status,
 *   expected: 200,
 * });
 * ```
 */
export interface AssertionDetails {
  actual?: unknown;
  expected?: unknown;
}

/**
 * Input for explicit assertion result object.
 *
 * @example
 * ```ts
 * ctx.assertResult({
 *   passed: res.status === 200,
 *   actual: res.status,
 *   expected: 200,
 * });
 * ```
 */
export interface AssertionResultInput {
  passed: boolean;
  actual?: unknown;
  expected?: unknown;
}

/**
 * Options for metric reporting.
 *
 * @example
 * ```ts
 * ctx.metric("api_latency", duration, {
 *   unit: "ms",
 *   tags: { endpoint: "/users", method: "GET" },
 * });
 * ```
 */
export interface MetricOptions {
  /** Display unit (e.g., "ms", "bytes", "count", "%") */
  unit?: string;
  /** Key-value tags for grouping/filtering in dashboards */
  tags?: Record<string, string>;
}

/**
 * Options for `ctx.pollUntil()`.
 */
export interface PollUntilOptions {
  /** Maximum time to wait before giving up (milliseconds). */
  timeoutMs: number;
  /** Interval between poll attempts (milliseconds). Default: 1000. */
  intervalMs?: number;
  /**
   * Called when polling times out instead of throwing an error.
   * If present, `pollUntil` resolves silently on timeout.
   * If absent, `pollUntil` throws on timeout (test fails).
   *
   * @param lastError The last error thrown by the polling function, if any.
   */
  onTimeout?: (lastError?: Error) => void;
}

/**
 * API trace data for network call reporting.
 * Usually auto-generated by `ctx.http` — only use `ctx.trace()` directly
 * for non-HTTP calls (e.g., gRPC, WebSocket) or custom instrumentation.
 *
 * @example Manual trace for a non-HTTP call
 * ```ts
 * const start = Date.now();
 * const result = await grpcClient.getUser({ id: 1 });
 * ctx.trace({
 *   name: "gRPC GetUser",
 *   method: "gRPC",
 *   url: "user-service:50051/GetUser",
 *   status: result.ok ? 200 : 500,
 *   duration: Date.now() - start,
 * });
 * ```
 */
export interface ApiTrace {
  /** Optional human-readable name to quickly identify the API (e.g., "Create User", "Get Orders") */
  name?: string;
  /** Optional detailed description of what this API call does */
  description?: string;
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Request URL */
  url: string;
  /** Response status code */
  status: number;
  /** Request duration in milliseconds */
  duration: number;
  /** Optional request headers */
  requestHeaders?: Record<string, string>;
  /** Optional request body */
  requestBody?: unknown;
  /** Optional response headers */
  responseHeaders?: Record<string, string>;
  /** Optional response body */
  responseBody?: unknown;
}

/**
 * Result of a single assertion within a test.
 */
export interface AssertionResult {
  /** Whether the assertion passed */
  passed: boolean;
  /** Human-readable description of the assertion */
  message: string;
  /** The actual value received (optional) */
  actual?: unknown;
  /** The expected value (optional) */
  expected?: unknown;
}

// =============================================================================
// New Builder API Types
// =============================================================================

/**
 * Metadata for a test (unified for all test types).
 */
export interface TestMeta {
  /** Unique identifier for the test */
  id: string;
  /** Human-readable name (defaults to id) */
  name?: string;
  /** Detailed description */
  description?: string;
  /**
   * Tags for filtering (e.g., ["smoke", "auth"]).
   * Accepts a single string or an array.
   *
   * @example
   * tags: "smoke"
   * tags: ["smoke", "auth"]
   */
  tags?: string | string[];
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /**
   * If true, run only focused tests in this file/run context.
   * If both `only` and `skip` are true, `skip` takes precedence.
   */
  only?: boolean;
  /** If true, skip this test (takes precedence over `only`) */
  skip?: boolean;

  /**
   * Filter rows before generating tests (data-driven only).
   * Return `true` to include the row, `false` to exclude.
   * Applied before test registration — excluded rows never become tests.
   *
   * @example Exclude invalid data
   * ```ts
   * filter: (row) => !!row.endpoint && !!row.expected
   * ```
   *
   * @example Only include specific country
   * ```ts
   * filter: (row) => row.country === "JP"
   * ```
   */
  filter?: (row: Record<string, unknown>, index: number) => boolean;

  /**
   * Auto-tag tests with values from data row fields.
   * Each field generates a tag in `"field:value"` format.
   * Accepts a single field name or an array.
   *
   * Combined with static `tags` — both are included in the final tag list.
   * Use `glubean run --tag country:JP` to filter at runtime.
   *
   * @example Single field
   * ```ts
   * tagFields: "country"
   * // Row { country: "JP" } → tags include "country:JP"
   * ```
   *
   * @example Multiple fields
   * ```ts
   * tagFields: ["country", "region"]
   * // Row { country: "JP", region: "APAC" } → tags include "country:JP", "region:APAC"
   * ```
   */
  tagFields?: string | string[];
}

/**
 * Metadata for a step within a test.
 */
export interface StepMeta {
  /** Step name (used for display and reporting) */
  name: string;
  /** Optional timeout override for this step */
  timeout?: number;
  /** Number of retries for this step (default: 0) */
  retries?: number;
  /**
   * Logical group this step belongs to (set by `.group()`).
   * Used for visual grouping in reports and dashboards.
   */
  group?: string;
}

/**
 * The function signature for a simple test (no state).
 */
export type SimpleTestFunction = (ctx: TestContext) => Promise<void>;

/**
 * The function signature for a data-driven test (test.each).
 * Receives TestContext and the data row from the table.
 *
 * @template T The data row type
 *
 * @example
 * ```ts
 * const fn: EachTestFunction<{ id: number; expected: number }> =
 *   async (ctx, { id, expected }) => {
 *     const res = await ctx.http.get(`${ctx.vars.require("BASE_URL")}/users/${id}`, {
 *       throwHttpErrors: false,
 *     });
 *     ctx.expect(res.status).toBe(expected);
 *   };
 * ```
 */
export type EachTestFunction<T> = (ctx: TestContext, data: T) => Promise<void>;

/**
 * The function signature for a step with state.
 * @template S The state type passed between steps
 */
export type StepFunction<S = unknown> = (
  ctx: TestContext,
  state: S,
) => Promise<S | void>;

/**
 * Setup function that runs before all steps.
 * Returns state that will be passed to steps and teardown.
 * @template S The state type to return
 */
export type SetupFunction<S = unknown> = (ctx: TestContext) => Promise<S>;

/**
 * Teardown function that runs after all steps.
 *
 * **Important**: Teardown always runs, even if:
 * - Setup fails
 * - Any step fails
 * - The test times out
 *
 * Use teardown to clean up resources (close connections, delete test data, etc.).
 * Handle errors gracefully as teardown failures won't prevent other cleanup.
 *
 * @template S The state type received from setup
 *
 * @example
 * ```ts
 * const teardown: TeardownFunction<{ userId: string }> = async (ctx, state) => {
 *   // Always runs for cleanup
 *   try {
 *     await deleteUser(state.userId);
 *   } catch (err) {
 *     ctx.log("Cleanup warning:", err.message);
 *     // Don't throw - allow other cleanup to continue
 *   }
 * };
 * ```
 */
export type TeardownFunction<S = unknown> = (
  ctx: TestContext,
  state: S,
) => Promise<void>;

/**
 * Internal step definition (stored in builder).
 */
export interface StepDefinition<S = unknown> {
  meta: StepMeta;
  fn: StepFunction<S>;
}

/**
 * A complete test definition (output of builder).
 * @template S The state type for multi-step tests
 */
export interface Test<S = unknown> {
  /** Test metadata */
  meta: TestMeta;
  /** Test type: 'simple' for single-function tests, 'steps' for multi-step */
  type: "simple" | "steps";
  /** The test function (for simple tests) */
  fn?: SimpleTestFunction;
  /** Setup function (for step-based tests) */
  setup?: SetupFunction<S>;
  /** Teardown function (for step-based tests) */
  teardown?: TeardownFunction<S>;
  /** Steps (for step-based tests) */
  steps?: StepDefinition<S>[];
  /**
   * Fixture definitions provided by `test.extend()`.
   * The runner resolves these and merges results into `TestContext`
   * before invoking the test function / steps.
   */
  // deno-lint-ignore no-explicit-any
  fixtures?: Record<string, ExtensionFn<any>>;
}

// =============================================================================
// Extension Types (test.extend)
// =============================================================================

/**
 * Factory function for a context extension (fixture).
 *
 * Two forms:
 * - **Simple factory**: `(ctx) => instance` — called once per test, return value
 *   is merged into ctx.
 * - **Lifecycle factory**: `(ctx, use) => { setup; await use(instance); teardown; }`
 *   — wraps the test execution; cleanup runs after the `use` callback resolves.
 *
 * @template T The type of the fixture instance
 *
 * @example Simple factory
 * ```ts
 * const authFixture: ExtensionFn<AuthClient> = (ctx) =>
 *   createAuth(ctx.vars.require("AUTH_URL"));
 * ```
 *
 * @example Lifecycle factory
 * ```ts
 * const dbFixture: ExtensionFn<DbClient> = async (ctx, use) => {
 *   const db = await connect(ctx.vars.require("DB_URL"));
 *   await use(db);
 *   await db.disconnect();
 * };
 * ```
 */
export type ExtensionFn<T> =
  | ((ctx: TestContext) => T | Promise<T>)
  | ((ctx: TestContext, use: (instance: T) => Promise<void>) => Promise<void>);

/**
 * Resolve the instance type from a single extension factory function.
 *
 * Checks the lifecycle form first (2-param with `use` callback) because it
 * is more specific, then falls back to the simple factory forms.
 */
export type ResolveExtension<F> = F extends (
  ctx: TestContext,
  use: (instance: infer T) => Promise<void>,
) => Promise<void> ? T
  : F extends (ctx: TestContext) => Promise<infer T> ? T
  : F extends (ctx: TestContext) => infer T ? T
  : never;

/**
 * Map of extension factory functions to their resolved instance types.
 *
 * @example
 * ```ts
 * type R = ResolveExtensions<{
 *   auth: (ctx: TestContext) => AuthClient;
 *   db: (ctx: TestContext, use: (i: DbClient) => Promise<void>) => Promise<void>;
 * }>;
 * // R = { auth: AuthClient; db: DbClient }
 * ```
 */
export type ResolveExtensions<E> = {
  [K in keyof E]: ResolveExtension<E[K]>;
};

/**
 * Metadata registered to the global registry (for scanning).
 */
export interface RegisteredTestMeta {
  /** Test ID */
  id: string;
  /** Test name */
  name: string;
  /** Test type */
  type: "simple" | "steps";
  /** Tags */
  tags?: string[];
  /** Description */
  description?: string;
  /** Step metadata (for step-based tests) */
  steps?: { name: string; group?: string }[];
  /** Has setup hook */
  hasSetup?: boolean;
  /** Has teardown hook */
  hasTeardown?: boolean;
  /** Source file (set by scanner) */
  file?: string;
  /** Export name in the module */
  exportName?: string;
  /**
   * Trace grouping ID — the unresolved template ID for pick tests.
   * When set, the CLI uses this as the trace directory name so all
   * pick variants land in one directory for easy diffing.
   */
  groupId?: string;
}
