<p align="center">
  <img src=".github/logo.png" width="120" alt="Glubean" />
</p>

<h1 align="center">Glubean</h1>
<p align="center">API collections, as real code.</p>
<p align="center">Open-source, code-first API testing toolkit. Write TypeScript, click play, see every request and response.</p>

## Install

```bash
# macOS / Linux
curl -fsSL https://glubean.com/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://glubean.com/install.ps1 | iex
```

```bash
# Or install directly if you already have Deno
deno install -Agf -n glubean jsr:@glubean/cli
```

## Quick Start

```bash
glubean init        # scaffold a project
glubean run         # run all tests
```

```typescript
import { test } from "jsr:@glubean/sdk";

export const listProducts = test("list-products", async (ctx) => {
  const baseUrl = ctx.vars.require("BASE_URL");

  const data = await ctx.http
    .get(`${baseUrl}/products?limit=5`)
    .json<{ products: unknown[]; total: number }>();

  ctx.expect(data.products.length).toBe(5);
  ctx.expect(data.total).toBeGreaterThan(0);
  ctx.log(`Found ${data.total} products`);
});
```

Chain multiple steps with shared state:

```typescript
export const createAndVerify = test("create-and-verify")
  .step("create product", async (ctx) => {
    const res = await ctx.http.post(`${baseUrl}/products`, {
      json: { name: "Widget" },
    });
    ctx.expect(res.status).toBe(201).orFail();
    return { id: (await res.json()).id };
  })
  .step("verify product", async (ctx, { id }) => {
    const product = await ctx.http.get(`${baseUrl}/products/${id}`).json();
    ctx.expect(product.name).toBe("Widget");
  });
```

Run the same test against a table of inputs:

```typescript
export const statusCodes = test.each([
  { path: "/products/1", expected: 200 },
  { path: "/products/0", expected: 404 },
])("check-$path", async (ctx, { path, expected }) => {
  const res = await ctx.http.get(`${baseUrl}${path}`);
  ctx.expect(res.status).toBe(expected);
});
```

Schema validation, `test.pick`, auth helpers, GraphQL, and more — see the [Getting Started](docs/getting-started.md)
guide.

## Packages

| Package                                     | Description                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| [`@glubean/sdk`](packages/sdk/)             | User-facing SDK — `test()`, `ctx.http`, assertions, structured logging |
| [`@glubean/runner`](packages/runner/)       | Sandboxed test execution engine (Deno subprocess)                      |
| [`@glubean/cli`](packages/cli/)             | CLI for running, scanning, and managing test projects                  |
| [`@glubean/scanner`](packages/scanner/)     | Static analysis for test file discovery and metadata extraction        |
| [`@glubean/auth`](packages/auth/)           | Auth helpers — bearer, basic, apiKey, OAuth 2.0, dynamic login         |
| [`@glubean/graphql`](packages/graphql/)     | GraphQL plugin — `.query()` / `.mutate()` with auto-tracing            |
| [`@glubean/redaction`](packages/redaction/) | Sensitive data redaction for logs and traces                           |
| [`@glubean/mcp`](packages/mcp/)             | Model Context Protocol server for AI agent integration                 |
| [`@glubean/worker`](packages/worker/)       | Worker agent for remote test execution                                 |

## VS Code Extension

Install from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=glubean.glubean). Source code in a
[separate repo](https://github.com/glubean/vscode).

Inline play buttons, Test Explorer sidebar, auto-traced `.trace.jsonc` viewer, environment switcher, breakpoint
debugging, diff with previous run, and `test.pick` CodeLens buttons.

## Documentation

|                                                      |                                                           |
| ---------------------------------------------------- | --------------------------------------------------------- |
| [Getting Started](docs/getting-started.md)           | Install, init, write, run — 5 minutes                     |
| [Assertions & Validation](docs/guides/assertions.md) | `ctx.expect`, `ctx.assert`, `ctx.warn`, schema validation |
| [Data-Driven Tests](docs/guides/data-loading.md)     | CSV, YAML, JSON, directory-based test data                |
| [AI Agent / MCP](docs/guides/mcp.md)                 | Set up the MCP server for Cursor                          |
| [SDK Reference](docs/reference/sdk.md)               | Full API reference                                        |
| [Event Reference](docs/reference/events.md)          | Runner event types                                        |
| [Architecture](docs/architecture/overview.md)        | Package map, relationships, security model                |

## CLI Commands

```bash
glubean init                           # Interactive project setup
glubean run                            # Run tests (defaults to tests/)
glubean run --explore                  # Run explore/ files
glubean run path/to/file.test.ts       # Run a specific file
glubean run --env-file .env.staging    # Use specific environment
glubean run --inspect-brk              # Debug with VS Code
glubean scan                           # Generate metadata.json
glubean upgrade                        # Self-update CLI
```

## Development

```bash
deno fmt              # Format
deno lint             # Lint
deno test -A          # Run tests
```

## License

MIT
