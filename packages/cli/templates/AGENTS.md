# Glubean Test Project — AI Agent Guidelines

## Import Convention

Always use the import map alias defined in `deno.json`, never hardcoded JSR URLs:

```typescript
// ✅ Correct
import { test } from "@glubean/sdk";

// ❌ Wrong — breaks tooling features like trace grouping
import { test } from "jsr:@glubean/sdk@^X.Y.Z";
```

The alias ensures your test code and Glubean's internal tooling (scanner, trace writer) share the same SDK module
instance. Hardcoded URLs can cause a module-instance split where features silently stop working.

## Test Patterns — Builder vs Simple

**Rule: 2+ steps → MUST use builder API. Single request → simple API is fine.**

### Builder API (preferred)

Use for any test with multiple steps. Steps are visible in `glubean scan` metadata and dashboard visualizations.

```typescript
import { test } from "@glubean/sdk";

export const createAndVerify = test("create-and-verify")
  .meta({ tags: ["crud"] })
  .step("create resource", async (ctx) => {
    const res = await ctx.http.post(`${baseUrl}/items`, {
      json: { name: "test" },
    });
    const data = await res.json();
    ctx.assert(res.status === 201, "Should create");
    return { id: data.id }; // pass state to next step
  })
  .step("verify resource", async (ctx, state) => {
    const res = await ctx.http.get(`${baseUrl}/items/${state.id}`);
    ctx.assert(res.status === 200, "Should exist");
  });
```

With `setup` for shared config:

```typescript
export const authFlow = test("auth-flow")
  .meta({ tags: ["auth"] })
  .setup(async (ctx) => {
    const api = ctx.http.extend({
      headers: { Authorization: `Bearer ${ctx.secrets.require("TOKEN")}` },
    });
    return { api, baseUrl: ctx.vars.require("BASE_URL") };
  })
  .step("get profile", async (ctx, { api, baseUrl }) => {
    const res = await api.get(`${baseUrl}/me`);
    ctx.assert(res.status === 200, "Should return profile");
  });
```

### Simple API (single-request tests only)

```typescript
export const healthCheck = test(
  { id: "health", name: "Health Check", tags: ["smoke"] },
  async (ctx) => {
    const res = await ctx.http.get(`${ctx.vars.require("BASE_URL")}/health`);
    ctx.assert(res.ok, "API should be reachable");
  },
);
```

For local debugging, you can also use:

```typescript
export const focused = test.only("focus-this", async (ctx) => {
  // ...
});

export const temporarilySkipped = test.skip("skip-this", async (ctx) => {
  // ...
});
```

### Data-driven tests

```typescript
export const statusCodes = test.each([
  { id: 1, expected: 200 },
  { id: 999, expected: 404 },
])("get-item-$id", async (ctx, { id, expected }) => {
  const res = await ctx.http.get(`${ctx.vars.require("BASE_URL")}/items/${id}`);
  ctx.assert(res.status === expected, `status for id=${id}`);
});
```

### Example selection (pick one)

Use `test.pick` when you have multiple request variations for the same API and want to run one at a time (randomly by
default, or a specific one via CLI). Examples can contain any data shape — query params, body, headers, expected status,
or all combined.

```typescript
export const createUser = test.pick({
  normal: { body: { name: "Alice" }, query: { org: "acme" } },
  "edge-case": { body: { name: "" }, query: { org: "test" } },
})("create-user-$_pick", async ({ http, vars, expect }, { body, query }) => {
  const res = await http
    .post(`${vars.require("BASE_URL")}/users`, {
      json: body,
      searchParams: query,
    })
    .json();
  expect(res.id).toBeDefined();
});
// glubean run file.ts                 → random example
// glubean run file.ts --pick normal   → specific example
```

## ctx.http Quick Reference

`ctx.http` is a **thin wrapper around [ky](https://github.com/sindresorhus/ky)** with auto-tracing. All ky options are
supported. **There is no `form` shortcut** — use `body: new URLSearchParams(...)` for form data.

```typescript
// GET with JSON parsing
const users = await ctx.http.get(`${baseUrl}/users`).json();

// POST with JSON body
const created = await ctx.http
  .post(`${baseUrl}/users`, { json: { name: "test" } })
  .json();

// POST with form-urlencoded data (e.g. OAuth token requests)
const tokenRes = await ctx.http.post(`${authUrl}/token`, {
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: ctx.secrets.require("CLIENT_ID"),
    client_secret: ctx.secrets.require("CLIENT_SECRET"),
  }),
});

// Scoped client with shared config
const api = ctx.http.extend({ prefixUrl: baseUrl });
const user = await api.get("users/1").json();
```

Every request automatically records API traces and `http_duration_ms` metrics. Manual `ctx.trace()` calls are NOT needed
when using `ctx.http`.

## Assertions and Validation

### ctx.expect — Fluent Assertions (Recommended)

Soft-by-default: records failure but continues. Use `.orFail()` as a guard.

Every matcher accepts an optional **message** as the last argument. Always pass a descriptive message — it makes
failures actionable in Trace Viewer, CI, and MCP output.

```typescript
// With messages (recommended) — on failure: "GET /users status: expected 401 to be 200"
ctx.expect(res.status).toBe(200, "GET /users status");
ctx.expect(body.name).toEqual("Alice", "user name");
ctx.expect(body.roles).toContain("admin", "user roles");
ctx.expect(body).toMatchObject({ active: true }, "user active flag");

// Negation
ctx.expect(body.banned).not.toBe(true, "user should not be banned");

// Guard — abort if this fails (e.g., before parsing body)
ctx.expect(res.status).toBe(200, "POST /orders").orFail();
const body = await res.json(); // safe
```

Available methods: `toBe`, `toEqual`, `toBeType`, `toBeTruthy`, `toBeFalsy`, `toBeNull`, `toBeUndefined`, `toBeDefined`,
`toBeGreaterThan`, `toBeLessThan`, `toBeWithin`, `toHaveLength`, `toContain`, `toMatch`, `toMatchObject`,
`toHaveProperty`, `toSatisfy`, `toHaveStatus`, `toHaveHeader`, `toHaveJsonBody`.

### ctx.assert — Low-level Assertion

Always provide a descriptive message explaining what is being checked.

```typescript
ctx.assert(res.status === 200, "GET /users should return 200", {
  actual: res.status,
  expected: 200,
});
```

### ctx.warn — Soft Check (Non-failing)

Warnings are recorded but never fail the test. Use for best-practice checks.

```typescript
ctx.warn(duration < 500, "Response should be under 500ms");
ctx.warn(res.headers.has("cache-control"), "Should set cache headers");
```

### ctx.validate — Schema Validation

Validate data against a schema (Zod, Valibot, etc.). Severity controls behavior:

- `"error"` (default) — counts as failed assertion
- `"warn"` — warning only, test still passes
- `"fatal"` — abort test immediately

```typescript
import { z } from "zod";
const UserSchema = z.object({ id: z.number(), name: z.string() });

const user = ctx.validate(body, UserSchema, "response body");
ctx.validate(body, StrictSchema, "strict check", { severity: "warn" });
```

### HTTP Schema Auto-validation

Add `schema` to any `ctx.http` call for automatic request/response validation:

```typescript
const res = await ctx.http.post(`${baseUrl}/users`, {
  json: payload,
  searchParams: { org: "acme" },
  schema: {
    request: CreateUserSchema,
    response: UserSchema,
    query: OrgQuerySchema,
  },
});
```

## Other ctx APIs

- `ctx.vars.get(key)` / `ctx.vars.require(key)` — non-sensitive config (URLs, ports, regions)
- `ctx.secrets.get(key)` / `ctx.secrets.require(key)` — credentials (API keys, tokens, passwords). **Always use secrets
  for sensitive values** — they are auto-redacted in traces and never appear in logs.
- `ctx.fail(message)` — immediately abort test
- `ctx.skip(reason)` — skip test
- `ctx.log(message)` — structured log
- `ctx.metric(name, value, options?)` — custom metric (never put secrets/PII in metric names or tags)
- `ctx.pollUntil(options, fn)` — poll until truthy or timeout
- `ctx.setTimeout(ms)` — adjust test timeout

## Available CLI Tools

| Command                             | Purpose                                 |
| ----------------------------------- | --------------------------------------- |
| `deno task test`                    | Run all tests locally                   |
| `glubean run <file> --verbose`      | Run a specific test file                |
| `glubean run <file> -t <tag>`       | Run tests matching a tag                |
| `glubean run <file> --fail-fast`    | Stop on first test failure              |
| `glubean run <file> --fail-after 3` | Stop after N test failures              |
| `glubean diff`                      | Show OpenAPI spec changes (vs git HEAD) |
| `glubean coverage --openapi <spec>` | Show which endpoints have test coverage |
| `glubean context --openapi <spec>`  | Generate AI context file                |
| `glubean scan`                      | Regenerate metadata.json                |

## AI Context File

If an OpenAPI spec exists in `context/` (or elsewhere in the project) but `.glubean/ai-context.md` does not exist,
generate it first:

    glubean context --openapi context/openapi.sample.json

Then read `.glubean/ai-context.md` before writing new tests. It contains:

- SDK quick reference
- Existing test patterns from this project
- Uncovered endpoints and their schemas

## Project Directory Conventions

| Directory  | Purpose                                                  |
| ---------- | -------------------------------------------------------- |
| `tests/`   | Permanent test files — run in CI and Cloud               |
| `explore/` | Exploratory tests — quick iteration in your editor       |
| `data/`    | Shared test data (JSON, CSV, YAML) for tests and explore |
| `context/` | API specs and reference docs for AI and tooling          |

All test files must end in `*.test.ts`. The `data/` and `context/` directories are recommended conventions, not
required. Place new tests in `tests/` unless you are doing interactive exploration (use `explore/` for that).
