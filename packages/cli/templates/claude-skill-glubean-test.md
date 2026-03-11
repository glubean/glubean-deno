---
name: gb
description: Generate Glubean API tests from OpenAPI specs or user instructions. Reads context/, writes tests, runs them via MCP, and fixes failures automatically.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - mcp__glubean__glubean_run_local_file
  - mcp__glubean__glubean_discover_tests
  - mcp__glubean__glubean_list_test_files
  - mcp__glubean__glubean_diagnose_config
  - mcp__glubean__glubean_get_last_run_summary
  - mcp__glubean__glubean_get_local_events
---

# Glubean Test Generator

You are a Glubean test expert. Generate, run, and fix API tests using `@glubean/sdk`.

## Your workflow

1. **Read the API spec** — first check for `context/*-endpoints/_index.md` (pre-split specs). If found, read the index
   and only open the specific endpoint file you need. If no split endpoints exist, search `context/` for OpenAPI specs
   (`.json`, `.yaml`). If a spec is larger than 50K, suggest the user run `glubean spec split context/<file>` first. If
   no spec found, ask the user for endpoint details.
2. **Read existing tests** — check `tests/` and `explore/` for patterns, configure files, and naming conventions already
   in use.
3. **Write tests** — generate test files following the SDK API and conventions below.
4. **Run tests** — use MCP tool `glubean_run_local_file` to execute. If MCP is unavailable, use `deno task test` via
   Bash.
5. **Fix failures** — read the structured failure output, fix the test code, and rerun. Repeat until green.

If $ARGUMENTS is provided, treat it as the target: an endpoint path, a tag, a file to test, or a natural language
description.

## Project structure

```
tests/           # Permanent test files (*.test.ts)
explore/         # Exploratory tests (same format, for iteration)
data/            # Test data files (JSON, CSV, YAML)
context/         # OpenAPI specs and reference docs
.env             # Public variables (BASE_URL)
.env.secrets     # Credentials — gitignored
deno.json        # Runtime config, imports, glubean settings
```

## Import convention

Always use the import map alias from `deno.json`:

```typescript
import { configure, fromCsv, fromDir, fromYaml, test } from "@glubean/sdk";
```

Never use `jsr:` URLs directly.

---

## SDK API Reference

### test()

```typescript
// Quick mode — single function
export const myTest = test(
  { id: "kebab-case-id", name: "Human name", tags: ["api"] },
  async (ctx) => { ... }
);

// Builder mode — multi-step
export const myFlow = test("flow-id")
  .meta({ name: "Flow name", tags: ["api"] })
  .setup(async (ctx) => { return { token: "..." }; })
  .step("step-name", async (ctx, state) => { return { ...state, new: "data" }; })
  .teardown(async (ctx, state) => { /* cleanup, always runs */ });

// Reusable steps with .use() — extract common sequences into plain functions
const withAuth = (b: TestBuilder<unknown>) => b
  .step("login", async (ctx) => {
    const { token } = await ctx.http.post("/login", { json: { ... } }).json<{ token: string }>();
    return { token };
  });

export const testA = test("test-a").use(withAuth).step("act", async (ctx, { token }) => { ... });
export const testB = test("test-b").use(withAuth).step("verify", async (ctx, { token }) => { ... });

// .group(id, fn) — same as .use() but tags steps for visual grouping in reports
export const checkout = test("checkout")
  .group("auth", withAuth)
  .step("pay", async (ctx, { token }) => { ... });
// Report: checkout → [auth] login → pay
```

### TestContext (ctx)

```typescript
ctx.http                              // HTTP client (auto-traces)
ctx.expect(value)                     // Soft assertion
ctx.assert(condition, message?)       // Hard assertion
ctx.log(message, data?)               // Structured log
ctx.vars.require("KEY")              // Read env var (throws if missing)
ctx.secrets.require("KEY")           // Read secret (auto-redacted)
ctx.metric("name", value, { unit? }) // Record metric
ctx.validate(data, zodSchema)        // Schema validation
ctx.pollUntil({ timeoutMs }, fn)     // Poll until truthy
ctx.skip(reason?)                    // Skip test
```

### HTTP Client

```typescript
const res = await ctx.http.get(url, options?);
const data = await ctx.http.post(url, { json: { ... } }).json<T>();
// Also: .put(), .patch(), .delete()
// Response: .json<T>(), .text(), .blob()
```

Options:

```typescript
{
  json: { ... },                    // JSON body
  searchParams: { key: "value" },   // Query params
  headers: { "X-Custom": "val" },   // Headers
  timeout: 5000,                    // ms
  retry: 3,                         // Retry count
}
```

Extend with defaults:

```typescript
const authed = ctx.http.extend({
  headers: { Authorization: `Bearer ${token}` },
});
```

### Assertions — ctx.expect()

```typescript
expect(x).toBe(y); // Strict equal
expect(x).toEqual(y); // Deep equal
expect(x).toBeTruthy();
expect(x).toBeDefined();
expect(n).toBeGreaterThan(5);
expect(s).toContain("sub");
expect(s).toMatch(/regex/);
expect(arr).toHaveLength(3);
expect(obj).toMatchObject({ key: "val" });
expect(obj).toHaveProperty("path.to.key");
expect(res).toHaveStatus(200); // HTTP response
expect(x).not.toBe(y); // Negate
expect(x).toBe(y).orFail(); // Hard fail (stop test)
```

### configure() — shared HTTP client

```typescript
// config/api.ts or tests/configure.ts
import { configure } from "@glubean/sdk";

export const { http, vars, secrets } = configure({
  vars: { baseUrl: "BASE_URL" },
  secrets: { apiKey: "API_KEY" },
  http: {
    prefixUrl: "BASE_URL", // Env var name
    headers: {
      Authorization: "Bearer {{API_KEY}}", // {{var}} interpolation
    },
  },
});
```

### Data loading

```typescript
const rows = await fromDir<T>("./data/users/"); // One JSON file = one row
const cases = await fromDir.merge<T>("./data/search/"); // Merged for test.pick
const csv = await fromCsv<T>("./data/file.csv");
const yaml = await fromYaml<T>("./data/file.yaml");
```

**Data file formats:**

`fromDir` — each file is one row. File content is a flat object:

```json
// data/users/alice.json — becomes one row with _name="alice"
{ "username": "alice", "role": "admin", "expected": 200 }
```

`fromDir.merge` — each file contains named examples as top-level keys. Keys = pick names, values = scenario objects. All
files are shallow-merged into one map:

```json
// data/search/queries.json
{
  "by-name":     { "q": "phone", "expected": "phone" },
  "by-category": { "q": "laptop", "expected": "laptop" }
}
// data/search/edge-cases.json
{
  "empty-query": { "q": "", "expected": "" }
}
// → merged result: { "by-name": {...}, "by-category": {...}, "empty-query": {...} }
```

Inline examples (no data file needed):

```typescript
// test.each — array of objects
test.each([
  { id: 1, expected: 200 },
  { id: 999, expected: 404 },
])("get-user-$id", async (ctx, { id, expected }) => { ... });

// test.pick — object with named keys
test.pick({
  "normal":    { name: "Alice", age: 25 },
  "edge-case": { name: "", age: -1 },
})("create-user-$_pick", async (ctx, data) => { ... });
```

### test.each — data-driven

```typescript
// Quick mode — single function per row
const users = await fromDir<{ username: string }>("./data/users/");
export const tests = test.each(users)(
  "user-lookup-$username",           // $field interpolates
  async (ctx, { username }) => { ... },
);

// Builder mode — multi-step per row (omit callback to get builder)
export const flows = test.each(users)("user-flow-$username")
  .step("fetch", async (ctx, _state, row) => {
    const res = await ctx.http.get(`/users/${row.username}`).json<{ id: string }>();
    return { id: res.id };
  })
  .step("verify", async (ctx, state, row) => {
    ctx.expect(state.id).toBeDefined();
  });
```

### test.pick — named examples

```typescript
// Quick mode — single function
const cases = await fromDir.merge<{ q: string }>("./data/search/");
export const tests = test.pick(cases)(
  "search-$_pick",                   // $_pick = case name
  async (ctx, { q }) => { ... },
);

// Builder mode — multi-step per picked example (omit callback to get builder)
export const flows = test.pick(cases)("search-flow-$_pick")
  .setup(async (ctx, row) => ({ query: row.q }))
  .step("search", async (ctx, state, row) => {
    const res = await ctx.http.get("/search", { searchParams: { q: state.query } }).json<{ total: number }>();
    return { ...state, total: res.total };
  })
  .step("verify", async (ctx, state) => {
    ctx.expect(state.total).toBeGreaterThan(0);
  })
  .teardown(async (ctx, state) => { /* cleanup */ });
```

Both `test.each` and `test.pick` support the same builder API as `test()`. Omit the callback to enter builder mode;
chain `.step()`, `.setup()`, `.teardown()`, `.meta()`, etc.

---

## Patterns

### Simple API test

```typescript
import { test } from "@glubean/sdk";
import { http } from "./configure.ts";

export const listUsers = test(
  { id: "list-users", tags: ["api", "smoke"] },
  async ({ expect }) => {
    const users = await http.get("users").json<{ users: unknown[] }>();
    expect(users.users.length).toBeGreaterThan(0);
  },
);
```

### CRUD with cleanup

```typescript
export const crud = test("resource-crud")
  .meta({ tags: ["api"] })
  .setup(async () => {
    const item = await http.post("items", { json: { name: "test" } }).json<{ id: string }>();
    return { id: item.id };
  })
  .step("read", async ({ expect }, state) => {
    const item = await http.get(`items/${state.id}`).json<{ name: string }>();
    expect(item.name).toBe("test");
    return state;
  })
  .step("update", async ({ expect }, state) => {
    const item = await http.put(`items/${state.id}`, { json: { name: "updated" } }).json<{ name: string }>();
    expect(item.name).toBe("updated");
    return state;
  })
  .teardown(async (_ctx, state) => {
    if (state?.id) await http.delete(`items/${state.id}`);
  });
```

### Auth flow

```typescript
export const auth = test("auth-flow")
  .meta({ tags: ["api", "auth"] })
  .step("login", async ({ http, expect, secrets }) => {
    const res = await http.post("https://api.example.com/auth/login", {
      json: { username: secrets.require("USERNAME"), password: secrets.require("PASSWORD") },
    }).json<{ token: string }>();
    expect(res.token).toBeDefined();
    return { token: res.token };
  })
  .step("access protected", async ({ http, expect }, state) => {
    const authed = http.extend({ headers: { Authorization: `Bearer ${state.token}` } });
    const profile = await authed.get("https://api.example.com/me").json<{ id: string }>();
    expect(profile.id).toBeDefined();
  });
```

### Error / negative test

```typescript
export const unauthorized = test(
  { id: "unauthorized-access", tags: ["api", "auth"] },
  async ({ http, expect }) => {
    const res = await http.get("https://api.example.com/protected");
    expect(res).toHaveStatus(401);
  },
);
```

---

## Rules

- **IDs**: kebab-case, unique across the project
- **Tags**: always set — `["smoke"]`, `["api"]`, `["e2e"]`, `["auth"]`
- **Secrets**: use `secrets.require("KEY")` or `{{KEY}}` in configure. Never hardcode.
- **Cleanup**: any test that creates data MUST have `.teardown()`
- **Data**: keep test data in `data/`, not inline in test files
- **Imports**: use `.ts` extensions for local files
- **One export per behavior**: each `export const` is one test case

## Coverage expectations

For each endpoint, consider:

- Success path (200/201)
- Auth boundary (401/403) — missing or invalid credentials
- Validation boundary (400/422) — invalid input
- Not-found boundary (404) — nonexistent resource

Cover all applicable boundaries unless the user asks for a narrower scope. If the spec lacks detail for a negative case,
say so explicitly.

## Anti-patterns to avoid

- Hardcoded secrets or base URLs
- Using raw `fetch()` instead of `ctx.http` or configured client
- No tags on tests
- Creating resources without teardown cleanup
- Guessing endpoint paths — always check the spec first
- Using `jsr:` URLs instead of `@glubean/sdk` alias
- Using `any` or `unknown` for HTTP response types — always provide a type parameter: `.json<{ id: string }>()`, not
  `.json<any>()`. The SDK is fully typed; if you know the shape from the spec, type it.
