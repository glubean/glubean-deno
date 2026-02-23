# @glubean/sdk

The official SDK for writing Glubean verification tests. Write API tests that run locally and in the cloud with zero
configuration changes.

## Installation

```bash
# Using Deno
deno add jsr:@glubean/sdk

# Or import directly
import { test } from "jsr:@glubean/sdk";
```

### For Scanner/Tooling Only

If you're building tools that need to scan test metadata (like the Glubean scanner), use the internal API:

```typescript
// ⚠️ Internal API - not for test code
import { getRegistry } from "jsr:@glubean/sdk/internal";
```

**Note**: The internal API is not part of the public contract and may change without notice.

## Quick Start

```typescript
import { test } from "@glubean/sdk";

export const healthCheck = test("health-check", async (ctx) => {
  const baseUrl = ctx.vars.require("BASE_URL");

  // ctx.http gives you auto-tracing and HTTP duration metrics by default.
  const res = await ctx.http.get(`${baseUrl}/health`);
  ctx.expect(res.status).toBe(200).orFail();

  const body = await res.json<{ status: string }>();
  ctx.expect(body.status).toBe("ok");
});
```

Run locally:

```bash
glubean run ./api.test.ts
```

Output includes pass/fail result, duration, and memory usage:

```
● health-check
  ✓ PASSED (123ms, 8.5 MB)
```

## Test API

```typescript
import { test } from "@glubean/sdk";

// Quick mode - single function
export const login = test("login", async (ctx) => {
  const res = await ctx.http.post(`${ctx.vars.require("BASE_URL")}/login`, {
    json: { username: "demo", password: "demo" },
    throwHttpErrors: false,
  });
  ctx.expect(res.status).toBe(200);
});

// Focus or skip while debugging locally
export const loginOnly = test.only("login-only", async (ctx) => {
  const res = await ctx.http.get(`${ctx.vars.require("BASE_URL")}/login`);
  ctx.expect(res.status).toBe(200);
});

export const flakyFlow = test.skip("flaky-flow", async (ctx) => {
  ctx.log("Skipped for local iteration");
});

// If both flags are set, skip takes precedence at run selection time.
export const excludedEvenIfOnly = test("excluded-even-if-only")
  .only()
  .skip()
  .step("noop", async () => {});

// Builder mode - multi-step with lifecycle
export const checkout = test("checkout-flow")
  .meta({ tags: ["e2e", "critical"] })
  .setup(async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const cart = await ctx.http
      .post(`${baseUrl}/carts`, { json: {} })
      .json<{ id: string }>();
    return { baseUrl, cartId: cart.id };
  })
  .step("Add item", async (ctx, { baseUrl, cartId }) => {
    await ctx.http.post(`${baseUrl}/carts/${cartId}/items`, {
      json: { productId: "product-123" },
    });
    return { baseUrl, cartId };
  })
  .step("Complete checkout", async (ctx, { baseUrl, cartId }) => {
    const order = await ctx.http
      .post(`${baseUrl}/carts/${cartId}/checkout`)
      .json<{ status: string }>();
    ctx.expect(order.status).toBe("completed");
    return { baseUrl, cartId };
  })
  .teardown(async (ctx, { baseUrl, cartId }) => {
    await ctx.http.delete(`${baseUrl}/carts/${cartId}`);
  });
```

## Data-Driven and AI-Friendly Workflows

### `test.each()` — one row = one test

```typescript
import { test } from "@glubean/sdk";

export const statusChecks = test.each([
  { id: 1, expected: 200 },
  { id: 999, expected: 404 },
])("get-user-$id", async (ctx, { id, expected }) => {
  const res = await ctx.http.get(`${ctx.vars.require("BASE_URL")}/users/${id}`);
  ctx.expect(res.status).toBe(expected);
});
```

### `test.pick()` — run one named example (random by default)

```typescript
import { test } from "@glubean/sdk";

export const createUser = test.pick({
  normal: { body: { name: "Alice" }, expected: 201 },
  edge: { body: { name: "" }, expected: 400 },
})("create-user-$_pick", async (ctx, { body, expected }) => {
  const res = await ctx.http.post(`${ctx.vars.require("BASE_URL")}/users`, {
    json: body,
    throwHttpErrors: false,
  });
  ctx.expect(res.status).toBe(expected);
});
```

For deterministic CI runs, pin examples explicitly:

```bash
# Run only specific named examples
glubean run ./users.test.ts --pick normal,edge
```

### `configure()` — file-level shared setup

```typescript
import { configure } from "@glubean/sdk";

export const { http, vars, secrets } = configure({
  vars: { baseUrl: "BASE_URL" },
  secrets: { apiKey: "API_KEY" },
  http: {
    prefixUrl: "BASE_URL",
    headers: { Authorization: "Bearer {{API_KEY}}" },
  },
});
```

All configured values are lazy and resolved at runtime, so they are safe at module top-level and safe for scanner
imports.

Then use them in any test file:

```typescript
import { test } from "@glubean/sdk";
import { http } from "./configure.ts";

export const listUsers = test("list-users", async (ctx) => {
  const data = await http.get("users?limit=5").json();
  ctx.expect(data.users.length).toBe(5);
});
```

## Features

### Test Context (`ctx`)

Every test function receives a `TestContext` with these capabilities:

#### Environment Variables

Use `ctx.vars` for non-sensitive configuration (URLs, ports, regions, feature flags). **For credentials (API keys,
tokens, passwords), use `ctx.secrets` instead** — see [Secrets](#secrets) below.

```typescript
// Safe access with explicit error handling
const baseUrl = ctx.vars.require("BASE_URL"); // Throws if missing
const region = ctx.vars.get("REGION") ?? "us-east-1"; // Optional with default
const allVars = ctx.vars.all(); // Get all vars (for debugging)

// With validation (boolean)
const port = ctx.vars.require("PORT", (v) => !isNaN(Number(v)));

// With custom error message
const endpoint = ctx.vars.require("CALLBACK_URL", (v) => v.startsWith("https://") ? true : "must start with https://");
```

#### Secrets

```typescript
// Safe access - same API as vars
const apiKey = ctx.secrets.require("API_KEY"); // Throws if missing
const optionalToken = ctx.secrets.get("REFRESH_TOKEN"); // Optional

// With validation
const jwt = ctx.secrets.require("JWT_TOKEN", (v) => {
  const parts = v.split(".");
  if (parts.length !== 3) return "must be a valid JWT (3 parts)";
});
```

#### Logging

```typescript
// Logs are streamed to the runner and dashboard
ctx.log("User created", { id: 123, email: "test@example.com" });
ctx.log("Processing order...");
```

#### Assertions

```typescript
// Simple boolean assertion
ctx.assert(res.ok, "Request should succeed");

// With actual/expected values (shown in reports)
ctx.assert(res.status === 200, "Status check", {
  actual: res.status,
  expected: 200,
});

// Explicit result object
ctx.assert(
  {
    passed: data.items.length > 0,
    actual: data.items.length,
    expected: "> 0",
  },
  "Should have items",
);
```

#### Fluent Assertions (`ctx.expect`)

```typescript
// Soft by default: failure is recorded, test continues
ctx.expect(res.status).toBe(200);
ctx.expect(body.roles).toContain("admin");
ctx.expect(body).toMatchObject({ active: true });

// Guard when later code depends on this condition
ctx.expect(res.status).toBe(200).orFail();
const data = await res.json(); // safe after guard

// Negation
ctx.expect(data.deleted).not.toBe(true);
```

#### Warnings (`ctx.warn`)

```typescript
// Warning is recorded but does not fail the test
ctx.warn(durationMs < 500, "Response should be under 500ms");
ctx.warn(res.headers.has("cache-control"), "Should include cache headers");
```

#### Schema Validation (`ctx.validate`)

Works with any schema library that implements `safeParse` or `parse` (Zod, Valibot, ArkType, etc.):

```typescript
// Given a Zod schema defined elsewhere:
// const UserSchema = z.object({ id: z.number(), email: z.string().email() });

const user = ctx.validate(await res.json(), UserSchema, "response body");
ctx.expect(user?.id).toBeDefined();

// Severity controls behavior on failure:
ctx.validate(body, StrictSchema, "strict check", { severity: "warn" }); // warning only
ctx.validate(body, UserSchema, "user", { severity: "fatal" }); // abort test
```

#### HTTP Request/Response Schema Validation

```typescript
const res = await ctx.http.post(`${baseUrl}/users`, {
  json: payload,
  schema: {
    request: CreateUserSchema,
    response: UserSchema,
    query: { schema: OrgQuerySchema, severity: "warn" },
  },
});
```

#### API Tracing

```typescript
// Manual tracing for custom HTTP clients
const start = Date.now();
const res = await myClient.get("/users");
ctx.trace({
  method: "GET",
  url: "/users",
  status: res.status,
  duration: Date.now() - start,
  responseBody: res.data,
});
```

#### Dynamic Test Control

```typescript
// Skip test based on conditions
if (!ctx.vars.get("FEATURE_ENABLED")) {
  ctx.skip("Feature not enabled in this environment");
}

// Set timeout dynamically
const isProd = ctx.vars.get("ENV") === "production";
ctx.setTimeout(isProd ? 30000 : 10000);

// Check retry count
if (ctx.retryCount > 0) {
  ctx.log(`Retry attempt ${ctx.retryCount}`);
}
```

#### Retry Model and `ctx.retryCount`

- Retry orchestration is owned by the runner/control plane, not by SDK code.
- `ctx.retryCount` represents whole-test re-runs:
  - `0` on the first execution attempt
  - `1+` on subsequent re-runs of the same test
- Step retries configured via `.step(..., { retries })` are internal to one execution and do not increment
  `ctx.retryCount`.

```typescript
if (ctx.retryCount > 0) {
  ctx.log(`Runner re-run #${ctx.retryCount} for this test`);
}
```

#### Memory Profiling

```typescript
// Check memory usage at any point
const mem = ctx.getMemoryUsage();
if (mem) {
  ctx.log(`Heap used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
}

// Track memory delta
const before = ctx.getMemoryUsage();
await loadLargeDataset();
const after = ctx.getMemoryUsage();
if (before && after) {
  const delta = (after.heapUsed - before.heapUsed) / 1024 / 1024;
  ctx.log(`Memory used: ${delta.toFixed(2)} MB`);
}
```

See [Memory Profiling Guide](../../docs/MEMORY_PROFILING.md) for detailed examples.

### Test Metadata

Both APIs support rich metadata:

```typescript
// Builder API
export const myTest = test({
  id: "my-test",
  name: "My Test",
  description: "Tests the login flow",
  tags: ["auth", "smoke", "critical"],
  timeout: 60000,  // 60 seconds
  skip: false,     // Set to true to skip
  only: false,     // Set to true to run only this test
}, async (ctx) => { ... });
```

### Step Options

For builder mode, each step can have its own configuration:

```typescript
export const resilientTest = test("resilient").step(
  "Flaky API call",
  { retries: 3, timeout: 10000 },
  async (ctx, state) => {
    // This step will retry up to 3 times on failure
    const res = await ctx.http.get("/flaky-endpoint", {
      throwHttpErrors: false,
    });
    ctx.expect(res.status).toBe(200);
  },
);
```

### Type-Safe State

State flows through your test with full TypeScript support:

```typescript
interface TestState {
  userId: string;
  sessionToken: string;
  orderId?: string;
}

export const orderFlow = test<TestState>("order-flow")
  .setup(async (ctx) => {
    const user = await createUser();
    const session = await login(user);
    return {
      userId: user.id,
      sessionToken: session.token,
    };
  })
  .step("Create order", async (ctx, state) => {
    const order = await createOrder(state.sessionToken);
    return { ...state, orderId: order.id }; // Type-safe state update
  })
  .step("Verify order", async (ctx, state) => {
    // TypeScript knows state.orderId might be undefined here
    // But after the previous step, it's guaranteed to exist
    ctx.assert(state.orderId, "Order should exist");
  })
  .teardown(async (ctx, state) => {
    if (state.orderId) await deleteOrder(state.orderId);
    await deleteUser(state.userId);
  });
```

### Step Composition (`.use()` / `.group()`)

Reusable step sequences are just plain functions. No new abstractions needed.

#### `.use()` — Apply a builder transform

```typescript
// Define reusable steps as a plain function
const withAuth = (b: TestBuilder<unknown>) =>
  b
    .step("login", async (ctx) => {
      const data = await ctx.http
        .post("/auth/login", { json: creds })
        .json<{ token: string }>();
      return { token: data.token };
    })
    .step("verify token", async (ctx, { token }) => {
      const me = await ctx.http
        .get("/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
        })
        .json<{ id: string }>();
      return { token, userId: me.id };
    });

// Reuse across tests
export const testA = test("test-a")
  .use(withAuth)
  .step("create order", async (ctx, { token, userId }) => {
    /* ... */
  });

export const testB = test("test-b")
  .use(withAuth)
  .step("update profile", async (ctx, { token, userId }) => {
    /* ... */
  });
```

#### `.group()` — Same as `.use()` with report grouping

Steps added inside `.group()` are tagged with a group ID for visual grouping in reports:

```typescript
export const checkout = test("checkout")
  .group("auth", withAuth)
  .group("cart", withCart)
  .step("pay", async (ctx, { token, cartId }) => {
    /* ... */
  });

// Report output:
// checkout
//   ├─ [auth]
//   │   ├─ login ✓
//   │   └─ verify token ✓
//   ├─ [cart]
//   │   └─ add to cart ✓
//   └─ pay ✓
```

You can also use `.group()` inline for organization without reuse:

```typescript
export const e2e = test("e2e")
  .group("setup", (b) =>
    b
      .step("seed database", async (ctx) => ({ dbId: "..." }))
      .step("create user", async (ctx, { dbId }) => ({ dbId, userId: "..." })))
  .step("verify", async (ctx, { dbId, userId }) => {
    /* ... */
  });
```

Both `.use()` and `.group()` are also available on `EachBuilder` for data-driven tests.

### GraphQL Support

GraphQL support is provided by the `@glubean/graphql` plugin package. Install it separately:

```typescript
import { configure, test } from "@glubean/sdk";
import { graphql } from "@glubean/graphql";

const { gql } = configure({
  plugins: {
    gql: graphql({
      endpoint: "{{graphql_url}}",
      headers: { Authorization: "Bearer {{api_key}}" },
      throwOnGraphQLErrors: true,
    }),
  },
});

export const getUser = test("get-user", async (ctx) => {
  const { data } = await gql.query<{ user: { name: string } }>(
    `query GetUser($id: ID!) { user(id: $id) { name } }`,
    { variables: { id: "1" } },
  );
  ctx.expect(data?.user.name).toBe("Alice");
});
```

See the [`@glubean/graphql` documentation](https://jsr.io/@glubean/graphql) for full API details, `.gql` file loading,
and standalone usage.

## API Reference

### Functions

| Function                             | Description                                                           |
| ------------------------------------ | --------------------------------------------------------------------- |
| `test(id, fn)`                       | Quick mode: creates a single-function test                            |
| `test(id)`                           | Builder mode: returns a `TestBuilder`                                 |
| `test.only(id[, fn])`                | Mark a test as focused (`only: true`)                                 |
| `test.skip(id[, fn])`                | Mark a test as skipped (`skip: true`)                                 |
| `test.each(table)`                   | Data-driven tests (simple or builder mode)                            |
| `test.pick(examples, count?)`        | Select named examples (random by default) and delegate to `test.each` |
| `configure(options)`                 | Declare file-level vars/secrets/http/plugins config (lazy at runtime) |
| `fromCsv/fromYaml/fromJsonl/fromDir` | Load data for `test.each`                                             |

### TestBuilder Methods

| Method                  | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `.meta(opts)`           | Set test metadata (tags, timeout, etc.)         |
| `.setup(fn)`            | Set setup function, returns state               |
| `.step(name, fn)`       | Add a test step                                 |
| `.step(name, opts, fn)` | Add a step with options (retries, timeout)      |
| `.use(fn)`              | Apply a builder transform for step composition  |
| `.group(id, fn)`        | Same as `.use()` but tags steps with a group ID |
| `.teardown(fn)`         | Set teardown function (runs even on failure)    |
| `.build()`              | Build and register (optional - auto-finalized)  |

### TestContext Properties

| Property                        | Type              | Description                                                 |
| ------------------------------- | ----------------- | ----------------------------------------------------------- |
| `vars`                          | `VarsAccessor`    | Environment variables                                       |
| `secrets`                       | `SecretsAccessor` | Secure secrets                                              |
| `http`                          | `HttpClient`      | HTTP client with auto-tracing and auto-metrics              |
| `log(msg, data?)`               | `function`        | Log message with optional data                              |
| `assert(...)`                   | `function`        | Record a hard assertion                                     |
| `expect(value)`                 | `function`        | Fluent assertions (soft by default, `.orFail()` for guards) |
| `warn(condition, message)`      | `function`        | Record non-failing warnings                                 |
| `validate(data, schema, ...)`   | `function`        | Validate data via schema libraries                          |
| `trace(req)`                    | `function`        | Record an API trace manually                                |
| `metric(name, value, options?)` | `function`        | Record numeric metrics                                      |
| `skip(reason?)`                 | `function`        | Dynamically skip current test                               |
| `fail(message)`                 | `function`        | Fail fast and abort test execution                          |
| `pollUntil(options, fn)`        | `function`        | Poll until condition becomes truthy                         |
| `setTimeout(ms)`                | `function`        | Dynamically set timeout                                     |
| `retryCount`                    | `number`          | Whole-test re-run count (0 on first execution attempt)      |
| `getMemoryUsage()`              | `function`        | Read memory usage stats when available                      |

### VarsAccessor Methods

| Method                    | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `get(key)`                | Returns value or `undefined`                         |
| `require(key, validate?)` | Returns value or throws; optional validator function |
| `all()`                   | Returns all variables                                |

### SecretsAccessor Methods

| Method                    | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| `get(key)`                | Returns secret or `undefined`                         |
| `require(key, validate?)` | Returns secret or throws; optional validator function |

## Best Practices

### 1. Use `require()` for Critical Variables

```typescript
// Good - fails fast with clear error
const baseUrl = ctx.vars.require("BASE_URL");

// Avoid - silent failures
const baseUrl = ctx.vars.get("BASE_URL") || "";
```

### 2. Keep Tests Independent

Each test should be able to run in isolation:

```typescript
// Good - creates and cleans up its own data
export const updateUser = test("update-user")
  .setup(async (ctx) => {
    const user = await ctx.http
      .post(`${ctx.vars.require("BASE_URL")}/users`, { json: { name: "Test" } })
      .json<{ id: string }>();
    return { userId: user.id };
  })
  .step("Update name", async (ctx, { userId }) => {
    const res = await ctx.http.patch(
      `${ctx.vars.require("BASE_URL")}/users/${userId}`,
      { json: { name: "New" } },
    );
    ctx.expect(res.status).toBe(200);
    return { userId };
  })
  .teardown(async (ctx, { userId }) => {
    await ctx.http.delete(`${ctx.vars.require("BASE_URL")}/users/${userId}`);
  });
```

### 3. Use Tags for Organization

```typescript
export const smokeTest = test({
  id: "api-health",
  tags: ["smoke", "critical", "p0"]
}, async (ctx) => { ... });

// Run only smoke tests
// glubean run --tag smoke
```

### 4. Log Meaningful Context

```typescript
ctx.log("Creating order", {
  userId: state.userId,
  items: cart.items.length,
  total: cart.total,
});
```

### 5. Use Setup/Teardown for Shared Resources

```typescript
export const dbTests = test<{ conn: Connection }>("db-tests")
  .setup(async (ctx) => {
    const conn = await db.connect();
    await conn.beginTransaction();
    return { conn };
  })
  .step("Insert", async (ctx, { conn }) => { ... })
  .step("Query", async (ctx, { conn }) => { ... })
  .teardown(async (ctx, { conn }) => {
    await conn.rollback();  // Clean up test data
    await conn.close();
  })
```

### 6. Handle Cleanup Gracefully

Teardown always runs, even on failure. Handle errors to ensure cleanup:

```typescript
export const dbTests = test<{ conn: Connection }>("db-cleanup")
  .setup(async (ctx) => {
    const conn = await db.connect();
    await conn.beginTransaction();
    return { conn };
  })
  .step("Insert", async (ctx, { conn }) => {
    /* ... */
  })
  .step("Query", async (ctx, { conn }) => {
    /* ... */
  })
  .teardown(async (ctx, { conn }) => {
    try {
      await conn.rollback();
      await conn.close();
    } catch (err) {
      ctx.log("Cleanup failed:", err.message);
    }
  });
```

### 7. Keep `test.pick()` Deterministic in CI

`test.pick()` defaults to random selection, which is great for local exploration. For CI pipelines, pin explicit
examples so failures are reproducible.

```bash
# Good (deterministic)
glubean run ./users.test.ts --pick normal,edge

# Local exploration (random)
glubean run ./users.test.ts
```

## Version

Current SDK spec version: **2.0**

```typescript
import { SPEC_VERSION } from "@glubean/sdk";
console.log(SPEC_VERSION); // "2.0"
```

## License

MIT
