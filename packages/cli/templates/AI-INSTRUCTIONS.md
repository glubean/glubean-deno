# Glubean Test Project

API test automation project using `@glubean/sdk`. Runtime is **Deno**. Packages are from **JSR**.

## Project Structure

```
tests/           # Permanent test files — run in CI and Cloud
explore/         # Exploratory tests — quick iteration in your editor
data/            # Test data files (JSON, CSV, YAML)
context/         # API specs and reference docs for AI and tooling
.env             # Public variables (BASE_URL)
.env.secrets     # Credentials — gitignored
deno.json        # Runtime config, imports, glubean settings
```

## Setup

If `deno check` or `glubean run` fails with module-not-found errors, run:

```bash
deno install
```

## BEFORE Writing or Modifying Any Test (MANDATORY)

You MUST complete these steps before writing any test code. Do NOT skip this — not even for "simple" tests.

1. Search `context/` for the API you are testing. Check OpenAPI specs (`context/*.json`) for exact paths, methods,
   request/response schemas. **Do NOT guess endpoint paths or response shapes.**
2. Check `.glubean/docs/` exists. If missing, download:
   ```bash
   mkdir -p .glubean/docs
   curl -sL https://raw.githubusercontent.com/glubean/cheatsheet/main/sdk-reference.md -o .glubean/docs/sdk-reference.md
   curl -sL https://raw.githubusercontent.com/glubean/cheatsheet/main/patterns.md -o .glubean/docs/patterns.md
   curl -sL https://raw.githubusercontent.com/glubean/cheatsheet/main/cli-reference.md -o .glubean/docs/cli-reference.md
   ```
3. Read `.glubean/docs/sdk-reference.md` — all exports, signatures, options.
4. Read `.glubean/docs/patterns.md` — runnable examples for every test type.
5. THEN write the test using only patterns from those docs and API details from step 1.

**If you write test code without completing steps 1-4, you are violating this rule.** Do NOT guess — the endpoint paths,
response schemas, and SDK API are all documented.

**If `context/` has no spec or docs for the API under test:** Unless it is a well-known public API (e.g. GitHub,
Stripe), STOP and ask the user for the endpoint path, method, and response schema. Do NOT hallucinate paths or response
shapes.

**If the OpenAPI spec exists but lacks response schemas:** Warn the user that response structure will be inferred at
runtime, which lowers first-pass accuracy. Suggest adding response examples to `context/` to enable one-shot test
generation.

## Quick Checklist

Before submitting any test, verify:

- [ ] Checked `context/` for endpoint spec + response schema
- [ ] Response schema available? If not, warned user about reduced accuracy
- [ ] Test ID is kebab-case and unique across the project
- [ ] Tags are set (e.g. `["api"]`, `["smoke"]`, `["e2e"]`)
- [ ] Creates resources → has `.teardown()` cleanup
- [ ] No hardcoded secrets or test data in the test file

## Coverage Expectations

Do not stop at a single happy-path test unless the user explicitly asks for only one case.

- For authentication/identity endpoints, include:
  - one authenticated success case
  - one unauthenticated or invalid-credential case
- For protected resources, include authorization failure cases (`401` or `403`) when applicable.
- For create/update endpoints, include at least one invalid-input case when the contract documents validation rules.
- If the OpenAPI spec lacks enough detail for a negative case, say so explicitly and choose the safest verifiable case.

## Definition of Done for API Tests

Before considering an API test complete, verify whether the endpoint has:

- a success path
- an auth boundary
- a validation boundary
- a not-found or forbidden boundary

Cover all applicable boundaries unless the user asked for a narrower scope.

## Import Convention

Always use the import map alias defined in `deno.json`, never hardcoded JSR URLs:

```typescript
// Correct
import { test } from "@glubean/sdk";

// Wrong — breaks tooling features like trace grouping
import { test } from "jsr:@glubean/sdk@^X.Y.Z";
```

## Conventions

- **One test export per behavior.** Each `export const` is a test case.
- **Tags:** `["smoke"]` for health checks, `["api"]` for API tests, `["e2e"]` for browser tests.
- **IDs:** kebab-case, unique across the project. Used for history tracking.
- **Data separation:** keep test data in `data/`, never hardcode payloads in test files.
- **Secrets:** use `secrets.require("KEY")` or configure's secret binding. Never hardcode credentials.
- **Cleanup:** use `.teardown()` for any resource created during the test.
- **Imports:** use `.ts` extensions for local files.

## Running Tests

```bash
glubean run                          # Run all tests in tests/
glubean run tests/                   # Run a specific directory
glubean run --filter smoke           # Run by tag
glubean run --explore                # Run explore/ tests
glubean run --upload                 # Run and upload results to Cloud
```

For all CLI options, run `glubean --help` or `glubean run --help`.

## MCP Setup (enables AI closed-loop)

Without MCP, the AI can only write tests. With MCP, the AI can: **write → run → read failures → fix → rerun → pass** —
without human intervention.

### Claude Code

```bash
claude mcp add glubean -- deno run -A jsr:@glubean/mcp
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "glubean": {
      "command": "deno",
      "args": ["run", "-A", "jsr:@glubean/mcp"]
    }
  }
}
```

### Available MCP Tools

- `glubean_run_local_file` — run a test file locally, returns structured results (assertions, logs, traces)
- `glubean_discover_tests` — scan a file and return test export metadata (id, name, tags)
- `glubean_list_test_files` — list all test files in the project
- `glubean_diagnose_config` — check project config for common issues (.env, deno.json, dirs)
- `glubean_get_last_run_summary` — get summary of the most recent local run
- `glubean_get_local_events` — get filtered events (assertions, logs, traces) from the last run; useful for debugging
  failures

## Type Definitions

For full API details beyond the cheatsheet, go to the import source:

```typescript
import { configure, fromDir, test } from "@glubean/sdk";
// Go-to-definition on these for exact signatures and options
```
