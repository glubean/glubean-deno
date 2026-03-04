# Glubean SDK — Rules for AI Assistants

> Copy the content below into your project's `CLAUDE.md` (or equivalent AI config file) so that AI assistants write
> correct Glubean tests.

---

## Test Framework

This project uses **Glubean SDK** (`@glubean/sdk`) for API and E2E testing. Tests run with `glubean run`, NOT
`deno test` or `npm test`.

## File Conventions

- Test files: `*.test.ts` (only this suffix is discovered)
- Env vars: `.env` (non-sensitive), `.env.secrets` (gitignored, auto-redacted in traces)
- Config: `deno.json` with `"glubean"` field
- Browser config: `config/browser.ts` (shared fixture)

## Test Syntax

**There is NO `.run()` method. Never use `Deno.test()`. Never use `ctx.` prefix — always destructure.**

### Simple test

```ts
import { test } from "@glubean/sdk";

export const getUser = test(
  { id: "get-user", name: "GET user", tags: ["smoke"] },
  async ({ http, expect, log, vars }) => {
    const baseUrl = vars.require("BASE_URL");
    const user = await http.get(`${baseUrl}/users/1`).json<{ id: number; name: string }>();

    expect(user.id).toBe(1, "user id");
    log(`User: ${user.name}`);
  },
);
```

### Multi-step test

```ts
export const orderFlow = test("order-flow")
  .meta({ name: "Create order", tags: ["e2e"] })
  .step("login", async ({ http, vars, secrets }) => {
    const baseUrl = vars.require("BASE_URL");
    const key = secrets.require("API_KEY");
    const body = await http.post(`${baseUrl}/auth/login`, {
      json: { key },
    }).json<{ token: string }>();
    return { token: body.token };
  })
  .step("create order", async ({ http, expect, vars, log }, { token }) => {
    const baseUrl = vars.require("BASE_URL");
    const order = await http.post(`${baseUrl}/orders`, {
      json: { item: "prod_1" },
      headers: { Authorization: `Bearer ${token}` },
    }).json<{ id: string }>();

    expect(order.id).toBeDefined("order id");
    log(`Order: ${order.id}`);
  });
```

### Data-driven test

```ts
export const statusTests = test.each([
  { path: "/users/1", expected: 200 },
  { path: "/users/0", expected: 404 },
])("status-$path", async ({ http, expect, vars }, { path, expected }) => {
  const baseUrl = vars.require("BASE_URL");
  try {
    const res = await http.get(`${baseUrl}${path}`);
    expect(res.status).toBe(expected, `GET ${path}`);
  } catch (error) {
    const e = error as { response?: { status?: number }; status?: number };
    expect(e.response?.status ?? e.status).toBe(expected, `GET ${path} error`);
  }
});
```

## Browser Tests

Requires `@glubean/browser`. Create a shared config:

```ts
// config/browser.ts
import { configure, test } from "@glubean/sdk";
import { browser } from "@glubean/browser";
import type { InstrumentedPage } from "@glubean/browser";

export const { chrome } = configure({
  plugins: {
    chrome: browser({ launch: true, launchOptions: { headless: true } }),
  },
});

export const browserTest = test.extend({
  page: async (ctx, use: (instance: InstrumentedPage) => Promise<void>) => {
    const pg = await chrome.newPage(ctx);
    try {
      await use(pg);
    } finally {
      await pg.close();
    }
  },
});
```

Then write browser tests:

```ts
import { browserTest } from "../../config/browser.ts";

export const loginFlow = browserTest(
  { id: "login-flow", name: "Login via UI", tags: ["e2e"] },
  async ({ page, expect }) => {
    await page.goto("https://app.example.com/login");
    await page.type("#email", "user@test.com");
    await page.type("#password", "pass");
    await page.clickAndNavigate('button[type="submit"]');
    await page.expectURL("/dashboard");
    await page.expectText("h1", "Welcome");
  },
);
```

**Page API:** `goto()`, `type()`, `click()`, `clickAndNavigate()`, `select()`, `evaluate()`, `textContent()`,
`expectURL()`, `expectText()`, `expectVisible()`, `expectHidden()`, `expectCount()`, `expectAttribute()`

## Pre-configured HTTP Client

Use `configure()` for shared auth / base URL:

```ts
// config/api.ts
import { configure } from "@glubean/sdk";

export const { http: api } = configure({
  secrets: { token: "API_KEY" },
  http: {
    prefixUrl: "BASE_URL",
    headers: { Authorization: "Bearer {{API_KEY}}" },
  },
});
```

Then tests skip auth boilerplate:

```ts
import { api } from "../../config/api.ts";

export const listUsers = test(
  { id: "list-users", name: "List users", tags: ["api"] },
  async ({ expect }) => {
    const users = await api.get("users").json<{ id: string }[]>();
    expect(users.length).toBeGreaterThan(0, "user count");
  },
);
```

## Setup / Teardown

```ts
export const withCleanup = test("resource-lifecycle")
  .setup(async ({ http, vars }) => {
    const res = await http.post(`${vars.require("BASE_URL")}/resources`, {
      json: { name: "temp" },
    }).json<{ id: string }>();
    return { resourceId: res.id };
  })
  .step("use resource", async ({ http, expect, vars }, { resourceId }) => {
    const res = await http.get(`${vars.require("BASE_URL")}/resources/${resourceId}`);
    expect(res.status).toBe(200, "resource exists");
    return { resourceId };
  })
  .teardown(async ({ http, vars, log }, { resourceId }) => {
    await http.delete(`${vars.require("BASE_URL")}/resources/${resourceId}`);
    log("Cleaned up");
  });
```

## Context API

Always destructure: `async ({ http, expect, log, vars, secrets, assert }) =>`

| Property               | Usage                                                                             |
| ---------------------- | --------------------------------------------------------------------------------- |
| `http`                 | `http.get(url).json<T>()`, `http.post(url, { json: {...} })`                      |
| `expect(v)`            | `.toBe()`, `.toBeDefined()`, `.toBeGreaterThan()`, `.toHaveLength()`, `.orFail()` |
| `assert(bool, msg)`    | Low-level boolean assertion                                                       |
| `log(msg)`             | Structured log                                                                    |
| `vars.require("K")`    | Load from `.env`                                                                  |
| `secrets.require("K")` | Load from `.env.secrets` (auto-redacted)                                          |

## Running & Debugging

```bash
glubean run                              # all tests
glubean run tests/api/                   # directory
glubean run tests/api/auth.test.ts       # single file
glubean run --filter login               # by test id/name substring
glubean run --tag smoke                  # by tag
glubean run --verbose                    # full HTTP request/response bodies
glubean run --upload                     # upload results to Glubean Cloud
```

### AI Debug Loop

When a test fails, follow this loop:

1. **Run the test** — `glubean run <file> --filter <test-id> --verbose`
2. **Read the output** — look for:
   - `✗` lines show which step failed
   - HTTP status codes (e.g. `→ 401` means auth problem)
   - Assertion messages with `expected X to be Y`
   - Error messages after `Error:`
3. **Fix the code** — based on the failure:
   - `401/403` → auth issue, check token/cookie/guard type
   - `404` → wrong path or missing resource
   - `400` → wrong request body shape
   - Assertion mismatch → fix expected value or test logic
4. **Rerun** — same command, confirm it passes
5. **Repeat** until all tests pass

### Output Format

Glubean CLI outputs structured, readable results:

```
● Test Name [tags]
  ┌ step 1/N step name
    ↳ GET /endpoint → 200 320ms     # HTTP trace
      ✓ assertion message            # passed assertion
      ✗ expected 200 to be 201       # failed assertion
  └ ✓ 320ms · 1 assertions · 1 API call
  ✓ PASSED (1200ms, 3 calls, 5 checks)
```

Key signals: HTTP method + path + status code on every `↳` line, assertion pass/fail on `✓`/`✗` lines. Use `--verbose`
for full request/response bodies.

### Result JSON

Use `--result-json <path>` for machine-readable output:

```bash
glubean run tests/api/ --result-json results/api.result.json
```

The `.result.json` contains structured test results with assertions, traces, and timing data — useful for CI integration
or programmatic analysis.

## Rules

1. **No `.run()` method.** Use `test(meta, fn)` or `test("id").step(...)`.
2. **No `Deno.test()`.** Always `import { test } from "@glubean/sdk"`.
3. **No `body: JSON.stringify()`** — use `json: { ... }`.
4. **No `ctx.http`** — destructure: `({ http, expect }) =>`.
5. **Always add assertion messages** — `expect(x).toBe(1, "user id")`.
6. **HTTP throws on non-2xx** — use try/catch for expected errors.
7. **Exports must be named** — `export const x = test(...)`.
8. **POST body** — `{ json: { key: "value" } }` not `{ body: ..., headers: { "Content-Type": ... } }`.
