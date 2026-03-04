import type {
  EachTestFunction,
  ExtensionFn,
  RegisteredTestMeta as _RegisteredTestMeta,
  ResolveExtensions,
  SetupFunction,
  SimpleTestFunction,
  StepDefinition,
  StepFunction,
  StepMeta,
  TeardownFunction,
  Test,
  TestContext,
  TestMeta,
} from "./types.ts";
import { registerTest } from "./internal.ts";
import { toArray } from "./data.ts";

/**
 * Glubean SDK spec version.
 *
 * This defines the API contract between the SDK, Scanner, and Runner.
 * - Major version: Breaking changes
 * - Minor version: New features (backward compatible)
 *
 * @example
 * ```ts
 * import { SPEC_VERSION } from "@glubean/sdk";
 * console.log("SDK spec version:", SPEC_VERSION);
 * ```
 */
export const SPEC_VERSION = "2.0";

// =============================================================================
// Note: Registry functions (getRegistry, clearRegistry) have been moved to
// internal.ts to keep the public API clean. Import from "@glubean/sdk/internal"
// if you need them (for scanner or testing purposes only).
// =============================================================================

// =============================================================================
// New Builder API
// =============================================================================

/**
 * Builder class for creating tests with a fluent API.
 *
 * @template S The state type for multi-step tests
 * @template Ctx The context type (defaults to TestContext; augmented by test.extend())
 *
 * @example Simple test (quick mode)
 * ```ts
 * export const login = test("login", async (ctx) => {
 *   ctx.assert(true, "works");
 * });
 * ```
 *
 * @example Multi-step test (builder mode)
 * ```ts
 * export const checkout = test("checkout")
 *   .meta({ tags: ["e2e"] })
 *   .setup(async (ctx) => ({ cart: await createCart() }))
 *   .step("Add to cart", async (ctx, state) => {
 *     await addItem(state.cart, "item-1");
 *     return state;
 *   })
 *   .step("Checkout", async (ctx, state) => {
 *     await checkout(state.cart);
 *     return state;
 *   })
 *   .teardown(async (ctx, state) => {
 *     await cleanup(state.cart);
 *   })
 *   .build();
 * ```
 */
export class TestBuilder<S = unknown, Ctx extends TestContext = TestContext> {
  private _meta: TestMeta;
  private _setup?: SetupFunction<S>;
  private _teardown?: TeardownFunction<S>;
  // deno-lint-ignore no-explicit-any
  private _steps: StepDefinition<any>[] = [];
  private _built = false;
  // deno-lint-ignore no-explicit-any
  _fixtures?: Record<string, ExtensionFn<any>>;

  /**
   * Marker property so the runner can detect un-built TestBuilder exports
   * without importing the SDK. The runner checks this string to auto-build.
   */
  readonly __glubean_type = "builder" as const;

  constructor(
    id: string,
    // deno-lint-ignore no-explicit-any
    fixtures?: Record<string, ExtensionFn<any>>,
  ) {
    this._meta = { id, name: id };
    this._fixtures = fixtures;
    // Auto-finalize (register) after all synchronous chaining completes.
    // Module top-level code is synchronous, so by the time the microtask
    // fires, all .step() / .meta() / .setup() / .teardown() calls are done.
    queueMicrotask(() => this._finalize());
  }

  /**
   * Set additional metadata for the test.
   *
   * @example
   * ```ts
   * test("my-test")
   *   .meta({ tags: ["smoke"], description: "A smoke test" })
   *   .step(...)
   * ```
   */
  meta(meta: Omit<TestMeta, "id">): TestBuilder<S, Ctx> {
    this._meta = { ...this._meta, ...meta };
    return this;
  }

  /**
   * Mark this test as focused.
   *
   * Focused tests are intended for local debugging sessions. When any tests in
   * a run are marked as `only`, non-focused tests may be excluded by discovery
   * tooling/orchestrators. If `skip` is also set on the same test, `skip`
   * still wins during run selection.
   */
  only(): TestBuilder<S, Ctx> {
    this._meta = { ...this._meta, only: true };
    return this;
  }

  /**
   * Mark this test as skipped.
   *
   * Skip takes precedence over `only` when both are present.
   */
  skip(): TestBuilder<S, Ctx> {
    this._meta = { ...this._meta, skip: true };
    return this;
  }

  /**
   * Set the setup function that runs before all steps.
   * The returned state is passed to all steps and teardown.
   *
   * @example
   * ```ts
   * test("auth")
   *   .setup(async (ctx) => {
   *     const baseUrl = ctx.vars.require("BASE_URL");
   *     const apiKey = ctx.secrets.require("API_KEY");
   *     const { token } = await ctx.http.post(`${baseUrl}/auth/token`, {
   *       headers: { "X-API-Key": apiKey },
   *     }).json();
   *     return { token };
   *   })
   *   .step("verify", async (ctx, { token }) => { ... })
   * ```
   */
  setup<NewS>(fn: (ctx: Ctx) => Promise<NewS>): TestBuilder<NewS, Ctx> {
    (this as unknown as TestBuilder<NewS, Ctx>)._setup = fn as unknown as SetupFunction<NewS>;
    return this as unknown as TestBuilder<NewS, Ctx>;
  }

  /**
   * Set the teardown function that runs after all steps (even on failure).
   *
   * @example
   * ```ts
   * test("db-test")
   *   .setup(async (ctx) => ({ conn: await connect() }))
   *   .step(...)
   *   .teardown(async (ctx, { conn }) => {
   *     await conn.close();
   *   })
   * ```
   */
  teardown(fn: (ctx: Ctx, state: S) => Promise<void>): TestBuilder<S, Ctx> {
    this._teardown = fn as unknown as TeardownFunction<S>;
    return this;
  }

  /**
   * Add a step that does not return state (void).
   * The state type is preserved for subsequent steps.
   *
   * @param name Step name (displayed in reports)
   * @param fn Step function that performs assertions/side-effects without returning state
   */
  step(
    name: string,
    fn: (ctx: Ctx, state: S) => Promise<void>,
  ): TestBuilder<S, Ctx>;
  /**
   * Add a step that returns new state, replacing the current state type.
   *
   * The returned value becomes the `state` argument for subsequent steps.
   * This enables fully type-safe chained steps without needing `.setup()`.
   *
   * @param name Step name (displayed in reports)
   * @param fn Step function receiving context and current state, returning new state
   *
   * @example
   * ```ts
   * test("auth-flow")
   *   .step("login", async (ctx) => {
   *     const data = await ctx.http.post("/auth/login", { json: creds }).json<{ token: string }>();
   *     return { token: data.token };
   *   })
   *   .step("get profile", async (ctx, { token }) => {
   *     // token is inferred as string ✓
   *     const profile = await ctx.http.get("/auth/me", {
   *       headers: { Authorization: `Bearer ${token}` },
   *     }).json<{ name: string }>();
   *     return { token, name: profile.name };
   *   })
   * ```
   */
  step<NewS>(
    name: string,
    fn: (ctx: Ctx, state: S) => Promise<NewS>,
  ): TestBuilder<NewS, Ctx>;
  /**
   * Add a step with options (void return).
   */
  step(
    name: string,
    options: Omit<StepMeta, "name">,
    fn: (ctx: Ctx, state: S) => Promise<void>,
  ): TestBuilder<S, Ctx>;
  /**
   * Add a step with additional options, returning new state.
   */
  step<NewS>(
    name: string,
    options: Omit<StepMeta, "name">,
    fn: (ctx: Ctx, state: S) => Promise<NewS>,
  ): TestBuilder<NewS, Ctx>;
  step(
    name: string,
    optionsOrFn:
      | Omit<StepMeta, "name">
      // deno-lint-ignore no-explicit-any
      | ((ctx: Ctx, state: any) => Promise<any>),
    // deno-lint-ignore no-explicit-any
    maybeFn?: (ctx: Ctx, state: any) => Promise<any>,
    // deno-lint-ignore no-explicit-any
  ): TestBuilder<any, Ctx> {
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;
    const options = typeof optionsOrFn === "function" ? {} : (optionsOrFn as StepMeta);

    this._steps.push({
      meta: { name, ...options },
      fn: fn as unknown as StepFunction,
    });
    // deno-lint-ignore no-explicit-any
    return this as TestBuilder<any, Ctx>;
  }

  /**
   * Apply a builder transform function for step composition.
   *
   * Reusable step sequences are just plain functions that take a builder
   * and return a builder. `.use()` applies such a function to the current
   * chain, preserving state flow.
   *
   * @param fn Transform function that receives this builder and returns a (possibly re-typed) builder
   *
   * @example Reusable step sequence
   * ```ts
   * // Define once — just a function
   * const withAuth = (b: TestBuilder<unknown>) => b
   *   .step("login", async (ctx) => {
   *     const data = await ctx.http.post("/login", { json: creds }).json<{ token: string }>();
   *     return { token: data.token };
   *   });
   *
   * // Reuse across tests
   * export const testA = test("test-a").use(withAuth).step("act", async (ctx, { token }) => { ... });
   * export const testB = test("test-b").use(withAuth).step("verify", async (ctx, { token }) => { ... });
   * ```
   */
  use<NewS>(
    fn: (builder: TestBuilder<S, Ctx>) => TestBuilder<NewS, Ctx>,
  ): TestBuilder<NewS, Ctx> {
    return fn(this);
  }

  /**
   * Apply a builder transform and tag all newly added steps with a group ID.
   *
   * Works exactly like `.use()`, but every step added by `fn` is marked with
   * `group` metadata for visual grouping in reports and dashboards.
   *
   * @param id Group identifier (displayed in reports as a section header)
   * @param fn Transform function that adds steps to the builder
   *
   * @example Reusable steps with grouping
   * ```ts
   * const withAuth = (b: TestBuilder<unknown>) => b
   *   .step("login", async (ctx) => ({ token: "..." }))
   *   .step("verify", async (ctx, { token }) => ({ token, verified: true }));
   *
   * export const checkout = test("checkout")
   *   .group("auth", withAuth)
   *   .step("pay", async (ctx, { token }) => { ... });
   *
   * // Report output:
   * // checkout
   * //   ├─ [auth]
   * //   │   ├─ login ✓
   * //   │   └─ verify ✓
   * //   └─ pay ✓
   * ```
   *
   * @example Inline grouping (no reuse, just organization)
   * ```ts
   * export const e2e = test("e2e")
   *   .group("setup", b => b
   *     .step("seed db", async (ctx) => ({ dbId: "..." }))
   *     .step("create user", async (ctx, { dbId }) => ({ dbId, userId: "..." }))
   *   )
   *   .step("verify", async (ctx, { dbId, userId }) => { ... });
   * ```
   */
  group<NewS>(
    id: string,
    fn: (builder: TestBuilder<S, Ctx>) => TestBuilder<NewS, Ctx>,
  ): TestBuilder<NewS, Ctx> {
    const before = this._steps.length;
    const result = fn(this);
    for (let i = before; i < this._steps.length; i++) {
      this._steps[i].meta.group = id;
    }
    return result;
  }

  /**
   * Finalize and register the test in the global registry.
   * Called automatically via microtask if not explicitly invoked via build().
   * Idempotent — safe to call multiple times.
   * @internal
   */
  private _finalize(): void {
    if (this._built) return;
    this._built = true;

    registerTest({
      id: this._meta.id,
      name: this._meta.name || this._meta.id,
      type: "steps",
      tags: toArray(this._meta.tags),
      description: this._meta.description,
      steps: this._steps.map((s) => ({
        name: s.meta.name,
        ...(s.meta.group ? { group: s.meta.group } : {}),
      })),
      hasSetup: !!this._setup,
      hasTeardown: !!this._teardown,
    });
  }

  /**
   * Build and register the test. Returns a plain `Test<S>` object.
   *
   * **Optional** — if omitted, the builder auto-finalizes via microtask
   * after all synchronous chaining completes, and the runner will
   * auto-detect the builder export. Calling `.build()` explicitly is
   * still supported for backward compatibility.
   *
   * @example
   * ```ts
   * // With .build() (explicit — backward compatible)
   * export const myTest = test("my-test")
   *   .step("step-1", async (ctx) => { ... })
   *   .build();
   *
   * // Without .build() (auto-finalized — recommended)
   * export const myTest = test("my-test")
   *   .step("step-1", async (ctx) => { ... });
   * ```
   */
  build(): Test<S> {
    this._finalize();

    return {
      meta: this._meta,
      type: "steps",
      setup: this._setup,
      teardown: this._teardown,
      steps: this._steps as StepDefinition<S>[],
      ...(this._fixtures ? { fixtures: this._fixtures } : {}),
    };
  }
}

/**
 * Create a new test.
 *
 * This is the unified entry point for all test definitions.
 * Supports both quick mode (single function) and builder mode (multi-step).
 *
 * @example Quick mode (simple test)
 * ```ts
 * import { test } from "@glubean/sdk";
 *
 * export const login = test("login", async (ctx) => {
 *   const res = await ctx.http.get(`${ctx.vars.require("BASE_URL")}/login`);
 *   ctx.assert(res.ok, "Login should succeed");
 * });
 * ```
 *
 * @example Quick mode with metadata
 * ```ts
 * export const login = test(
 *   { id: "login", tags: ["auth", "smoke"] },
 *   async (ctx) => {
 *     ctx.assert(true, "works");
 *   }
 * );
 * ```
 *
 * @example Builder mode (multi-step) — .build() is optional
 * ```ts
 * export const checkout = test("checkout")
 *   .meta({ tags: ["e2e"] })
 *   .setup(async (ctx) => ({ cart: await createCart() }))
 *   .step("Add item", async (ctx, state) => { ... })
 *   .step("Pay", async (ctx, state) => { ... })
 *   .teardown(async (ctx, state) => { ... });
 * ```
 *
 * @param idOrMeta Test ID (string) or full metadata object
 * @param fn Optional test function (quick mode)
 * @returns Test object (quick mode) or TestBuilder (builder mode)
 */
export function test<S = unknown>(idOrMeta: string | TestMeta): TestBuilder<S>;
export function test(idOrMeta: string | TestMeta, fn: SimpleTestFunction): Test;
export function test<S = unknown>(
  idOrMeta: string | TestMeta,
  fn?: SimpleTestFunction,
): Test | TestBuilder<S> {
  const meta: TestMeta = typeof idOrMeta === "string"
    ? { id: idOrMeta, name: idOrMeta }
    : { name: idOrMeta.id, ...idOrMeta };

  // Normalize tags to string[]
  if (meta.tags) {
    meta.tags = toArray(meta.tags);
  }

  // Quick mode: test("id", fn) -> returns Test directly
  if (fn) {
    const testDef: Test = {
      meta,
      type: "simple",
      fn,
    };

    // Register to global registry
    registerTest({
      id: meta.id,
      name: meta.name || meta.id,
      type: "simple",
      tags: toArray(meta.tags),
      description: meta.description,
    });

    return testDef;
  }

  // Builder mode: test("id") -> returns TestBuilder
  const builder = new TestBuilder<S>(meta.id);
  if (typeof idOrMeta !== "string") {
    builder.meta(idOrMeta);
  }
  return builder;
}

// =============================================================================
// Data-Driven API (test.each)
// =============================================================================

/**
 * Interpolate `$key` placeholders in a template string with data values.
 * Supports `$index` for the row index and `$key` for any key in the data object.
 *
 * @internal
 */
function interpolateTemplate(
  template: string,
  data: Record<string, unknown>,
  index: number,
): string {
  let result = template.replace(/\$index/g, String(index));
  for (const [key, value] of Object.entries(data)) {
    result = result.replaceAll(`$${key}`, String(value));
  }
  return result;
}

/**
 * Resolve baseMeta from string or TestMeta input.
 * @internal
 */
function resolveBaseMeta(idOrMeta: string | TestMeta): TestMeta {
  return typeof idOrMeta === "string" ? { id: idOrMeta, name: idOrMeta } : { name: idOrMeta.id, ...idOrMeta };
}

// =============================================================================
// EachBuilder — data-driven builder with step support
// =============================================================================

/**
 * Step function for data-driven builder tests.
 * Receives context, current state, and the data row for this test.
 *
 * @template S The state type passed between steps
 * @template T The data row type
 * @template Ctx The context type (defaults to TestContext)
 *
 * @example
 * ```ts
 * const stepFn: EachStepFunction<{ token: string }, { userId: number }> =
 *   async (ctx, state, row) => {
 *     const res = await ctx.http.get(`/users/${row.userId}`);
 *     ctx.assert(res.ok, `user ${row.userId} found`);
 *     return state; // pass state to next step
 *   };
 * ```
 */
export type EachStepFunction<S, T, Ctx extends TestContext = TestContext> = (
  ctx: Ctx,
  state: S,
  row: T,
) => Promise<S | void>;

/**
 * Setup function for data-driven builder tests.
 * Receives context and the data row, returns initial state.
 *
 * @template S The state type to return
 * @template T The data row type
 * @template Ctx The context type (defaults to TestContext)
 *
 * @example
 * ```ts
 * const setupFn: EachSetupFunction<{ api: HttpClient }, { env: string }> =
 *   async (ctx, row) => {
 *     const api = ctx.http.extend({ prefixUrl: row.env });
 *     return { api };
 *   };
 * ```
 */
export type EachSetupFunction<S, T, Ctx extends TestContext = TestContext> = (
  ctx: Ctx,
  row: T,
) => Promise<S>;

/**
 * Teardown function for data-driven builder tests.
 *
 * @template S The state type received from setup
 * @template T The data row type
 * @template Ctx The context type (defaults to TestContext)
 *
 * @example
 * ```ts
 * const teardownFn: EachTeardownFunction<{ sessionId: string }, { userId: number }> =
 *   async (ctx, state, row) => {
 *     await ctx.http.delete(`/sessions/${state.sessionId}`);
 *     ctx.log(`cleaned up session for user ${row.userId}`);
 *   };
 * ```
 */
export type EachTeardownFunction<
  S,
  T,
  Ctx extends TestContext = TestContext,
> = (ctx: Ctx, state: S, row: T) => Promise<void>;

/**
 * Builder for data-driven tests with multi-step workflow support.
 *
 * Created by `test.each(table)(idTemplate)` (without a callback).
 * Provides the same fluent `.step()` / `.setup()` / `.teardown()` API
 * as `TestBuilder`, but each step/setup/teardown also receives the
 * data row for the current test.
 *
 * On finalization, creates one `Test` per row in the table, each with
 * full step definitions visible in `glubean scan` metadata and dashboards.
 *
 * @template S The state type for multi-step tests
 * @template T The data row type
 *
 * @example
 * ```ts
 * export const userFlows = test.each([
 *   { userId: 1 },
 *   { userId: 2 },
 * ])("user-flow-$userId")
 *   .step("fetch user", async (ctx, state, { userId }) => {
 *     const res = await ctx.http.get(`/users/${userId}`);
 *     ctx.assert(res.ok, "user exists");
 *     return { user: await res.json() };
 *   })
 *   .step("verify posts", async (ctx, { user }) => {
 *     const res = await ctx.http.get(`/users/${user.id}/posts`);
 *     ctx.assert(res.ok, "posts accessible");
 *   });
 * ```
 */
export class EachBuilder<
  S = unknown,
  T extends Record<string, unknown> = Record<string, unknown>,
  Ctx extends TestContext = TestContext,
> {
  private _baseMeta: TestMeta;
  private _table: readonly T[];
  private _setup?: EachSetupFunction<S, T, Ctx>;
  private _teardown?: EachTeardownFunction<S, T, Ctx>;
  // deno-lint-ignore no-explicit-any
  private _steps: { meta: StepMeta; fn: EachStepFunction<any, T, Ctx> }[] = [];
  private _built = false;
  // deno-lint-ignore no-explicit-any
  _fixtures?: Record<string, ExtensionFn<any>>;

  /**
   * Marker property so the runner and scanner can detect EachBuilder exports.
   */
  readonly __glubean_type = "each-builder" as const;

  constructor(
    baseMeta: TestMeta,
    table: readonly T[],
    // deno-lint-ignore no-explicit-any
    fixtures?: Record<string, ExtensionFn<any>>,
  ) {
    this._baseMeta = baseMeta;
    this._table = table;
    this._fixtures = fixtures;
    // Auto-finalize after all synchronous chaining completes.
    queueMicrotask(() => this._finalize());
  }

  /**
   * Set additional metadata for all generated tests.
   *
   * @example
   * ```ts
   * test.each(table)("user-$userId")
   *   .meta({ tags: ["smoke"], timeout: 10000 })
   *   .step("fetch", async (ctx, state, row) => { ... });
   * ```
   */
  meta(meta: Omit<TestMeta, "id">): EachBuilder<S, T, Ctx> {
    this._baseMeta = { ...this._baseMeta, ...meta };
    return this;
  }

  /**
   * Mark all generated tests from this data set as focused.
   * If `skip` is also set, skipped tests are still excluded.
   */
  only(): EachBuilder<S, T, Ctx> {
    this._baseMeta = { ...this._baseMeta, only: true };
    return this;
  }

  /**
   * Mark all generated tests from this data set as skipped.
   * Skip takes precedence over `only` when both are present.
   */
  skip(): EachBuilder<S, T, Ctx> {
    this._baseMeta = { ...this._baseMeta, skip: true };
    return this;
  }

  /**
   * Set the setup function. Receives context and data row, returns state.
   *
   * @example
   * ```ts
   * test.each(table)("id-$key")
   *   .setup(async (ctx, row) => {
   *     const api = ctx.http.extend({ headers: { "X-User": row.userId } });
   *     return { api };
   *   })
   *   .step("use api", async (ctx, { api }) => { ... });
   * ```
   */
  setup<NewS>(
    fn: (ctx: Ctx, row: T) => Promise<NewS>,
  ): EachBuilder<NewS, T, Ctx> {
    (this as unknown as EachBuilder<NewS, T, Ctx>)._setup = fn as unknown as EachSetupFunction<NewS, T, Ctx>;
    return this as unknown as EachBuilder<NewS, T, Ctx>;
  }

  /**
   * Set the teardown function. Runs after all steps (even on failure).
   *
   * @example
   * ```ts
   * test.each(table)("user-$userId")
   *   .setup(async (ctx, row) => ({ token: await login(ctx, row) }))
   *   .step("test", async (ctx, { token }) => { ... })
   *   .teardown(async (ctx, state, row) => {
   *     await ctx.http.post("/logout", { body: { token: state.token } });
   *   });
   * ```
   */
  teardown(
    fn: (ctx: Ctx, state: S, row: T) => Promise<void>,
  ): EachBuilder<S, T, Ctx> {
    this._teardown = fn as unknown as EachTeardownFunction<S, T, Ctx>;
    return this;
  }

  /**
   * Add a step that does not return state (void).
   *
   * @example
   * ```ts
   * test.each(users)("user-$id")
   *   .step("verify", async (ctx, state, row) => {
   *     const res = await ctx.http.get(`/users/${row.id}`);
   *     ctx.expect(res.status).toBe(200);
   *   });
   * ```
   */
  step(
    name: string,
    fn: (ctx: Ctx, state: S, row: T) => Promise<void>,
  ): EachBuilder<S, T, Ctx>;
  /**
   * Add a step that returns new state, replacing the current state type.
   */
  step<NewS>(
    name: string,
    fn: (ctx: Ctx, state: S, row: T) => Promise<NewS>,
  ): EachBuilder<NewS, T, Ctx>;
  /**
   * Add a step with options (void return).
   */
  step(
    name: string,
    options: Omit<StepMeta, "name">,
    fn: (ctx: Ctx, state: S, row: T) => Promise<void>,
  ): EachBuilder<S, T, Ctx>;
  /**
   * Add a step with options, returning new state.
   */
  step<NewS>(
    name: string,
    options: Omit<StepMeta, "name">,
    fn: (ctx: Ctx, state: S, row: T) => Promise<NewS>,
  ): EachBuilder<NewS, T, Ctx>;
  step(
    name: string,
    optionsOrFn:
      | Omit<StepMeta, "name">
      // deno-lint-ignore no-explicit-any
      | ((ctx: Ctx, state: any, row: T) => Promise<any>),
    // deno-lint-ignore no-explicit-any
    maybeFn?: (ctx: Ctx, state: any, row: T) => Promise<any>,
    // deno-lint-ignore no-explicit-any
  ): EachBuilder<any, T, Ctx> {
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;
    const options = typeof optionsOrFn === "function" ? {} : (optionsOrFn as StepMeta);

    this._steps.push({
      meta: { name, ...options },
      fn,
    });
    // deno-lint-ignore no-explicit-any
    return this as EachBuilder<any, T, Ctx>;
  }

  /**
   * Apply a builder transform function for step composition.
   *
   * Works the same as `TestBuilder.use()` — reusable step sequences
   * are plain functions that take a builder and return a builder.
   *
   * @param fn Transform function that receives this builder and returns a (possibly re-typed) builder
   *
   * @example
   * ```ts
   * const withVerify = (b: EachBuilder<{ id: string }, { userId: number }>) => b
   *   .step("verify", async (ctx, { id }, row) => {
   *     ctx.expect(id).toBeTruthy();
   *   });
   *
   * export const users = test.each(table)("user-$userId")
   *   .setup(async (ctx, row) => ({ id: String(row.userId) }))
   *   .use(withVerify);
   * ```
   */
  use<NewS>(
    fn: (builder: EachBuilder<S, T, Ctx>) => EachBuilder<NewS, T, Ctx>,
  ): EachBuilder<NewS, T, Ctx> {
    return fn(this);
  }

  /**
   * Apply a builder transform and tag all newly added steps with a group ID.
   *
   * Works the same as `TestBuilder.group()` — steps added by `fn` are marked
   * with `group` metadata for visual grouping in reports.
   *
   * @param id Group identifier (displayed in reports as a section header)
   * @param fn Transform function that adds steps to the builder
   *
   * @example
   * ```ts
   * export const users = test.each(table)("user-$userId")
   *   .group("setup", b => b
   *     .step("init", async (ctx, state, row) => ({ id: String(row.userId) }))
   *   )
   *   .step("verify", async (ctx, { id }) => { ... });
   * ```
   */
  group<NewS>(
    id: string,
    fn: (builder: EachBuilder<S, T, Ctx>) => EachBuilder<NewS, T, Ctx>,
  ): EachBuilder<NewS, T, Ctx> {
    const before = this._steps.length;
    const result = fn(this);
    for (let i = before; i < this._steps.length; i++) {
      this._steps[i].meta.group = id;
    }
    return result;
  }

  /**
   * Get the filtered table (apply filter callback if present).
   * @internal
   */
  private _filteredTable(): readonly T[] {
    const filter = this._baseMeta.filter;
    if (!filter) return this._table;
    return this._table.filter((row, index) => filter(row as Record<string, unknown>, index));
  }

  /**
   * Compute tags for a specific row (static tags + tagFields).
   * @internal
   */
  private _tagsForRow(row: T): string[] {
    const staticTags = toArray(this._baseMeta.tags);
    const tagFieldNames = toArray(this._baseMeta.tagFields);
    const dynamicTags = tagFieldNames
      .map((field) => {
        const value = row[field];
        return value != null ? `${field}:${value}` : null;
      })
      .filter((t): t is string => t !== null);
    return [...staticTags, ...dynamicTags];
  }

  /**
   * Finalize and register all tests in the global registry.
   * Called automatically via microtask if not explicitly invoked via build().
   * Idempotent — safe to call multiple times.
   * @internal
   */
  private _finalize(): void {
    if (this._built) return;
    this._built = true;

    const stepMetas = this._steps.map((s) => ({
      name: s.meta.name,
      ...(s.meta.group ? { group: s.meta.group } : {}),
    }));
    const table = this._filteredTable();
    const isPick = table.length > 0 && "_pick" in table[0];
    for (let i = 0; i < table.length; i++) {
      const row = table[i];
      const id = interpolateTemplate(this._baseMeta.id, row, i);
      const name = this._baseMeta.name ? interpolateTemplate(this._baseMeta.name, row, i) : id;

      registerTest({
        id,
        name,
        type: "steps",
        tags: this._tagsForRow(row),
        description: this._baseMeta.description,
        steps: stepMetas,
        hasSetup: !!this._setup,
        hasTeardown: !!this._teardown,
        ...(isPick ? { groupId: this._baseMeta.id } : {}),
      });
    }
  }

  /**
   * Build and register all tests. Returns a `Test[]` array.
   *
   * **Optional** — if omitted, the builder auto-finalizes via microtask
   * and the runner will auto-detect the EachBuilder export.
   */
  build(): Test<S>[] {
    this._finalize();

    const table = this._filteredTable();
    return table.map((row, index) => {
      const id = interpolateTemplate(this._baseMeta.id, row, index);
      const name = this._baseMeta.name ? interpolateTemplate(this._baseMeta.name, row, index) : id;

      const meta: TestMeta = {
        ...this._baseMeta,
        id,
        name,
        tags: this._tagsForRow(row),
      };

      const setup = this._setup;
      const teardown = this._teardown;

      return {
        meta,
        type: "steps" as const,
        setup: setup ? (((ctx: TestContext) => setup(ctx as Ctx, row)) as SetupFunction<S>) : undefined,
        teardown: teardown
          ? (((ctx: TestContext, state: S) => teardown(ctx as Ctx, state, row)) as TeardownFunction<S>)
          : undefined,
        steps: this._steps.map((s) => ({
          meta: s.meta,
          fn: ((ctx: TestContext, state: S) => s.fn(ctx as Ctx, state, row)) as StepFunction<S>,
        })),
        ...(this._fixtures ? { fixtures: this._fixtures } : {}),
      };
    });
  }
}

/**
 * Data-driven test generation.
 *
 * Creates one independent test per row in the data table.
 * Each test gets its own ID (from template interpolation), runs independently,
 * and reports its own pass/fail status.
 *
 * Use `$key` in the ID/name template to interpolate values from the data row.
 * Use `$index` for the row index (0-based).
 *
 * Supports two modes:
 *
 * 1. **Simple mode** — pass a callback to get `Test[]` (single-function tests).
 * 2. **Builder mode** — omit the callback to get an `EachBuilder` with
 *    `.step()` / `.setup()` / `.teardown()` support for multi-step workflows.
 *
 * @example Simple mode (backward compatible)
 * ```ts
 * import { test } from "@glubean/sdk";
 *
 * export const statusTests = test.each([
 *   { id: 1, expected: 200 },
 *   { id: 999, expected: 404 },
 * ])("get-user-$id", async (ctx, { id, expected }) => {
 *   const res = await ctx.http.get(`${ctx.vars.require("BASE_URL")}/users/${id}`, {
 *     throwHttpErrors: false,
 *   });
 *   ctx.expect(res.status).toBe(expected);
 * });
 * ```
 *
 * @example Builder mode (multi-step per data row)
 * ```ts
 * export const userFlows = test.each([
 *   { userId: 1 },
 *   { userId: 2 },
 * ])("user-flow-$userId")
 *   .step("fetch user", async (ctx, _state, { userId }) => {
 *     const res = await ctx.http.get(`/users/${userId}`);
 *     ctx.assert(res.ok, "user exists");
 *     return { user: await res.json() };
 *   })
 *   .step("verify posts", async (ctx, { user }) => {
 *     const res = await ctx.http.get(`/users/${user.id}/posts`);
 *     ctx.assert(res.ok, "posts accessible");
 *   });
 * ```
 *
 * @param table Array of data rows. Each row produces one test.
 * @returns A function that accepts an ID template and optional test function
 */
// =============================================================================
// Extended Test (test.extend)
// =============================================================================

/** Keys that cannot be used as extension names (they shadow core TestContext). */
const EXTEND_RESERVED_KEYS = new Set(["vars", "secrets", "http"]);

/**
 * An extended `test` function created by `test.extend()`.
 *
 * Behaves identically to the base `test()` but augments the context type
 * with fixture properties. Supports quick mode, builder mode, `.each()`,
 * `.pick()`, and chained `.extend()`.
 *
 * @template Ctx The augmented context type (TestContext & extensions)
 */
export interface ExtendedTest<Ctx extends TestContext> {
  /** Quick mode: single-function test with augmented context. */
  (idOrMeta: string | TestMeta, fn: (ctx: Ctx) => Promise<void>): Test;
  /** Builder mode: multi-step test with augmented context. */
  <S = unknown>(idOrMeta: string | TestMeta): TestBuilder<S, Ctx>;

  /**
   * Chain another set of extensions on top of the current ones.
   * The returned test function has `Ctx & NewExtensions` as its context type.
   */
  extend<E extends Record<string, ExtensionFn<unknown>>>(
    extensions: E,
  ): ExtendedTest<Ctx & ResolveExtensions<E>>;

  /** Data-driven tests with augmented context. */
  each<T extends Record<string, unknown>>(
    table: readonly T[],
  ): {
    (
      idOrMeta: string | TestMeta,
      fn: (ctx: Ctx, data: T) => Promise<void>,
    ): Test[];
    (idOrMeta: string | TestMeta): EachBuilder<unknown, T, Ctx>;
  };

  /** Example-selection tests with augmented context. */
  pick<T extends Record<string, unknown>>(
    examples: Record<string, T>,
    count?: number,
  ): {
    (
      idOrMeta: string | TestMeta,
      fn: (ctx: Ctx, data: T & { _pick: string }) => Promise<void>,
    ): Test[];
    (
      idOrMeta: string | TestMeta,
    ): EachBuilder<unknown, T & { _pick: string }, Ctx>;
  };
}

/**
 * Select examples from a named map based on the GLUBEAN_PICK env var
 * or random selection. Shared between `test.pick` and extended test `.pick()`.
 *
 * @internal
 */
function selectPickExamples<T extends Record<string, unknown>>(
  examples: Record<string, T>,
  count: number,
): (T & { _pick: string })[] {
  const keys = Object.keys(examples);
  if (keys.length === 0) {
    throw new Error("test.pick requires at least one example");
  }

  let pickedEnv: string | undefined;
  try {
    pickedEnv = typeof Deno !== "undefined" ? Deno.env.get("GLUBEAN_PICK") : undefined;
  } catch {
    pickedEnv = undefined;
  }

  if (pickedEnv) {
    const trimmed = pickedEnv.trim();

    if (trimmed === "all" || trimmed === "*") {
      return keys.map((k) => ({ ...examples[k], _pick: k }));
    }

    const pickedKeys = trimmed
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    const hasGlob = pickedKeys.some((k) => k.includes("*"));

    let validKeys: string[];
    if (hasGlob) {
      const patterns = pickedKeys.map((p) => globToRegExp(p));
      validKeys = keys.filter((k) => patterns.some((re) => re.test(k)));
    } else {
      validKeys = pickedKeys.filter((k) => k in examples);
    }

    if (validKeys.length > 0) {
      return validKeys.map((k) => ({ ...examples[k], _pick: k }));
    }
  }

  // Random selection fallback
  const shuffled = [...keys].sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, Math.min(count, keys.length));
  return picked.map((k) => ({ ...examples[k], _pick: k }));
}

/**
 * Create an extended test function with fixture definitions.
 *
 * @internal
 */
function createExtendedTest<Ctx extends TestContext>(
  // deno-lint-ignore no-explicit-any
  allFixtures: Record<string, ExtensionFn<any>>,
): ExtendedTest<Ctx> {
  // Validate no reserved keys
  for (const key of Object.keys(allFixtures)) {
    if (EXTEND_RESERVED_KEYS.has(key)) {
      throw new Error(
        `Cannot extend test context with reserved key "${key}". ` +
          `Reserved keys: ${[...EXTEND_RESERVED_KEYS].join(", ")}.`,
      );
    }
  }

  // The callable part — quick mode and builder mode
  function extTest(
    idOrMeta: string | TestMeta,
    fn?: (ctx: Ctx) => Promise<void>,
    // deno-lint-ignore no-explicit-any
  ): Test | TestBuilder<any, Ctx> {
    if (fn) {
      // Quick mode
      const meta: TestMeta = typeof idOrMeta === "string"
        ? { id: idOrMeta, name: idOrMeta }
        : { name: idOrMeta.id, ...idOrMeta };
      if (meta.tags) meta.tags = toArray(meta.tags);

      const testDef: Test = {
        meta,
        type: "simple",
        fn: fn as unknown as SimpleTestFunction,
        fixtures: allFixtures,
      };

      registerTest({
        id: meta.id,
        name: meta.name || meta.id,
        type: "simple",
        tags: toArray(meta.tags),
        description: meta.description,
      });

      return testDef;
    }

    // Builder mode
    const id = typeof idOrMeta === "string" ? idOrMeta : idOrMeta.id;
    const builder = new TestBuilder<unknown, Ctx>(id, allFixtures);
    if (typeof idOrMeta !== "string") {
      builder.meta(idOrMeta);
    }
    return builder;
  }

  // .extend() — chained extension
  extTest.extend = <E extends Record<string, ExtensionFn<unknown>>>(
    extensions: E,
  ): ExtendedTest<Ctx & ResolveExtensions<E>> => {
    return createExtendedTest<Ctx & ResolveExtensions<E>>({
      ...allFixtures,
      ...extensions,
    });
  };

  // .each() — data-driven with fixtures
  extTest.each = <T extends Record<string, unknown>>(table: readonly T[]) => {
    return ((
      idOrMeta: string | TestMeta,
      fn?: (ctx: Ctx, data: T) => Promise<void>,
    ): Test[] | EachBuilder<unknown, T, Ctx> => {
      const baseMeta = resolveBaseMeta(idOrMeta);

      if (!fn) {
        return new EachBuilder<unknown, T, Ctx>(baseMeta, table, allFixtures);
      }

      // Simple mode with fixtures
      const filteredTable = baseMeta.filter
        ? table.filter((row, i) => baseMeta.filter!(row as Record<string, unknown>, i))
        : table;
      const tagFieldNames = toArray(baseMeta.tagFields);
      const staticTags = toArray(baseMeta.tags);
      const isPick = filteredTable.length > 0 && "_pick" in filteredTable[0];

      return filteredTable.map((row, index) => {
        const id = interpolateTemplate(baseMeta.id, row, index);
        const name = baseMeta.name ? interpolateTemplate(baseMeta.name, row, index) : id;
        const dynamicTags = tagFieldNames
          .map((field) => {
            const value = (row as Record<string, unknown>)[field];
            return value != null ? `${field}:${value}` : null;
          })
          .filter((t): t is string => t !== null);
        const allTags = [...staticTags, ...dynamicTags];

        const meta: TestMeta = {
          ...baseMeta,
          id,
          name,
          tags: allTags.length > 0 ? allTags : undefined,
        };

        const testDef: Test = {
          meta,
          type: "simple",
          fn: (async (ctx) => await fn(ctx as unknown as Ctx, row)) as SimpleTestFunction,
          fixtures: allFixtures,
        };

        registerTest({
          id: meta.id,
          name: meta.name || meta.id,
          type: "simple",
          tags: allTags.length > 0 ? allTags : undefined,
          description: meta.description,
          ...(isPick ? { groupId: baseMeta.id } : {}),
        });

        return testDef;
      });
    }) as ReturnType<ExtendedTest<Ctx>["each"]>;
  };

  // .pick() — example selection with fixtures
  extTest.pick = <T extends Record<string, unknown>>(
    examples: Record<string, T>,
    count = 1,
  ) => {
    const selected = selectPickExamples(examples, count);
    return extTest.each(selected);
  };

  return extTest as unknown as ExtendedTest<Ctx>;
}

// deno-lint-ignore no-namespace
export namespace test {
  /**
   * Mark a test definition as focused (`only: true`).
   *
   * Works in both quick mode and builder mode.
   * If `skip` is also set on the same test, `skip` takes precedence.
   *
   * @example Quick mode
   * ```ts
   * export const focused = test.only("focused-login", async (ctx) => {
   *   ctx.expect(true).toBeTruthy();
   * });
   * ```
   *
   * @example Builder mode
   * ```ts
   * export const focusedFlow = test.only("focused-flow")
   *   .step("run", async (ctx) => {
   *     ctx.expect(true).toBeTruthy();
   *   });
   * ```
   */
  export function only<S = unknown>(idOrMeta: string | TestMeta): TestBuilder<S>;
  export function only(
    idOrMeta: string | TestMeta,
    fn: SimpleTestFunction,
  ): Test;
  export function only<S = unknown>(
    idOrMeta: string | TestMeta,
    fn?: SimpleTestFunction,
  ): Test | TestBuilder<S> {
    const baseMeta: TestMeta = typeof idOrMeta === "string" ? { id: idOrMeta, name: idOrMeta } : idOrMeta;
    const metaWithOnly: TestMeta = { ...baseMeta, only: true };
    return fn ? test(metaWithOnly, fn) : test<S>(metaWithOnly);
  }

  /**
   * Mark a test definition as skipped (`skip: true`).
   *
   * Works in both quick mode and builder mode.
   * Skip takes precedence over `only` when both are present.
   */
  export function skip<S = unknown>(idOrMeta: string | TestMeta): TestBuilder<S>;
  export function skip(
    idOrMeta: string | TestMeta,
    fn: SimpleTestFunction,
  ): Test;
  export function skip<S = unknown>(
    idOrMeta: string | TestMeta,
    fn?: SimpleTestFunction,
  ): Test | TestBuilder<S> {
    const baseMeta: TestMeta = typeof idOrMeta === "string" ? { id: idOrMeta, name: idOrMeta } : idOrMeta;
    const metaWithSkip: TestMeta = { ...baseMeta, skip: true };
    return fn ? test(metaWithSkip, fn) : test<S>(metaWithSkip);
  }

  export function each<T extends Record<string, unknown>>(
    table: readonly T[],
  ): {
    // Simple mode: with callback → Test[]
    (idOrMeta: string, fn: EachTestFunction<T>): Test[];
    (idOrMeta: TestMeta, fn: EachTestFunction<T>): Test[];
    // Builder mode: without callback → EachBuilder
    (idOrMeta: string): EachBuilder<unknown, T>;
    (idOrMeta: TestMeta): EachBuilder<unknown, T>;
  } {
    return ((
      idOrMeta: string | TestMeta,
      fn?: EachTestFunction<T>,
    ): Test[] | EachBuilder<unknown, T> => {
      const baseMeta = resolveBaseMeta(idOrMeta);

      // Builder mode: no callback → return EachBuilder
      if (!fn) {
        return new EachBuilder<unknown, T>(baseMeta, table);
      }

      // Apply filter if present
      const filteredTable = baseMeta.filter
        ? table.filter((row, index) => baseMeta.filter!(row as Record<string, unknown>, index))
        : table;

      const tagFieldNames = toArray(baseMeta.tagFields);
      const staticTags = toArray(baseMeta.tags);
      const isPick = filteredTable.length > 0 && "_pick" in filteredTable[0];

      // Simple mode: with callback → return Test[]
      return filteredTable.map((row, index) => {
        const id = interpolateTemplate(baseMeta.id, row, index);
        const name = baseMeta.name ? interpolateTemplate(baseMeta.name, row, index) : id;

        // Compute tags: static tags + dynamic tagFields
        const dynamicTags = tagFieldNames
          .map((field) => {
            const value = (row as Record<string, unknown>)[field];
            return value != null ? `${field}:${value}` : null;
          })
          .filter((t): t is string => t !== null);
        const allTags = [...staticTags, ...dynamicTags];

        const meta: TestMeta = {
          ...baseMeta,
          id,
          name,
          tags: allTags.length > 0 ? allTags : undefined,
        };

        const testDef: Test = {
          meta,
          type: "simple",
          fn: async (ctx) => await fn(ctx, row),
        };

        registerTest({
          id: meta.id,
          name: meta.name || meta.id,
          type: "simple",
          tags: allTags.length > 0 ? allTags : undefined,
          description: meta.description,
          ...(isPick ? { groupId: baseMeta.id } : {}),
        });

        return testDef;
      });
    }) as ReturnType<typeof each<T>>;
  }

  /**
   * Example-selection API — randomly picks N examples from a named map.
   *
   * `test.pick` is a thin wrapper over `test.each`. It selects a subset of
   * examples from a `Record<string, T>`, injects a `_pick` field containing
   * the example key name, and delegates to `test.each`.
   *
   * Because the return value is identical to `test.each`, all `test.each`
   * options (`filter`, `tagFields`, `tags`) work transparently with `test.pick`.
   *
   * **Default behavior (no CLI override):** randomly selects `count` examples
   * (default 1). This provides lightweight fuzz / smoke-test coverage.
   *
   * **CLI override:** `--pick key1,key2` (or env var `GLUBEAN_PICK`) selects
   * specific examples by name, overriding random selection.
   *
   * **Run all:** `--pick all` or `--pick '*'` runs every example.
   * Recommended for CI where you want full coverage.
   *
   * **Glob patterns:** `--pick 'us-*'` selects all keys matching the pattern.
   * Useful when examples are grouped by prefix (e.g. regions, tenants).
   *
   * **VSCode integration:** CodeLens buttons let users click a specific
   * example to run, which passes `--pick <key>` under the hood.
   *
   * Use `$_pick` in the ID template to include the example key in the test ID.
   *
   * @param examples A named map of example data rows
   * @param count Number of examples to randomly select (default 1)
   * @returns Same as `test.each` — a function accepting ID template and callback
   *
   * @example Inline examples
   * ```ts
   * export const createUser = test.pick({
   *   "normal":    { name: "Alice", age: 25 },
   *   "edge-case": { name: "", age: -1 },
   *   "admin":     { name: "Admin", role: "admin" },
   * })("create-user-$_pick", async (ctx, example) => {
   *   await ctx.http.post("/api/users", { json: example });
   * });
   * ```
   *
   * @example With filter and tagFields (inherited from test.each)
   * ```ts
   * export const regionTests = test.pick(allRegions)({
   *   id: "region-$_pick",
   *   tagFields: ["currency", "_pick"],
   *   filter: (row) => row.currency === "USD",
   * }, async (ctx, data) => {
   *   const res = await ctx.http.get(data.endpoint);
   *   ctx.expect(res).toHaveStatus(200);
   * });
   * ```
   *
   * @example CLI usage
   * ```bash
   * glubean run file.ts                    # random example (default)
   * glubean run file.ts --pick normal      # specific example
   * glubean run file.ts --pick normal,admin  # multiple examples
   * glubean run file.ts --pick all         # every example (CI)
   * glubean run file.ts --pick 'us-*'      # glob pattern
   * ```
   */
  export function pick<T extends Record<string, unknown>>(
    examples: Record<string, T>,
    count = 1,
  ): ReturnType<typeof each<T & { _pick: string }>> {
    const selected = selectPickExamples(examples, count);
    return test.each(selected);
  }

  /**
   * Create an extended `test` function with augmented context.
   *
   * Inspired by Playwright's `test.extend()`. Returns a new test function
   * where `ctx` includes the resolved fixture properties alongside the
   * base `TestContext` methods.
   *
   * @example Define shared fixtures
   * ```ts
   * // tests/fixtures.ts
   * import { test as base } from "@glubean/sdk";
   *
   * export const test = base.extend({
   *   auth: (ctx) => createAuth(ctx.vars.require("AUTH_URL")),
   *   db: async (ctx, use) => {
   *     const db = await connect(ctx.vars.require("DB_URL"));
   *     await use(db);
   *     await db.disconnect();
   *   },
   * });
   * ```
   *
   * @example Use in tests
   * ```ts
   * // tests/users.test.ts
   * import { test } from "./fixtures.ts";
   *
   * export const myTest = test("my-test", async (ctx) => {
   *   ctx.auth; // full autocomplete
   *   ctx.db;   // full autocomplete
   * });
   * ```
   *
   * @example Chained extend
   * ```ts
   * import { test as withAuth } from "./auth-fixtures.ts";
   * export const test = withAuth.extend({ db: ... });
   * ```
   */
  export function extend<E extends Record<string, ExtensionFn<unknown>>>(
    extensions: E,
  ): ExtendedTest<TestContext & ResolveExtensions<E>> {
    return createExtendedTest<TestContext & ResolveExtensions<E>>(extensions);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob pattern (with `*` wildcards) to a RegExp.
 * Only `*` is supported (matches any sequence of characters).
 * @internal
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = "^" + escaped.replace(/\*/g, ".*") + "$";
  return new RegExp(regexStr);
}

// Re-export all types for user convenience
export * from "./types.ts";

// Re-export data loaders for convenience
// Users can also import from "@glubean/sdk/data" directly
export { fromCsv, fromDir, fromJsonl, fromYaml, toArray } from "./data.ts";
export type { FromCsvOptions, FromDirConcatOptions, FromDirOptions, FromYamlOptions } from "./data.ts";

// Re-export configure API
export { configure, resolveTemplate } from "./configure.ts";

// Re-export plugin utilities
export { definePlugin } from "./plugin.ts";

// Re-export assertion utilities
export { Expectation, ExpectFailError } from "./expect.ts";
export type { AssertEmitter, AssertionEmission, CustomMatchers, MatcherFn, MatcherResult } from "./expect.ts";

// Re-export ky — SDK wraps ky for HTTP, so it's a first-class dependency.
// This ensures runner/harness can import ky via SDK without requiring users
// to declare ky in their own deno.json.
export { default as ky } from "ky";
