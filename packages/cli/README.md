# @glubean/cli

Command-line interface for running and managing Glubean API tests.

Most users start with the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=glubean.glubean),
which auto-installs the CLI. This document covers the CLI directly — useful for CI pipelines, scripting, and advanced
workflows.

## Installation

```bash
# Recommended: install the VS Code extension (auto-installs Deno + CLI)
# Manual install:
curl -fsSL https://glubean.com/install.sh | sh

# Or with Deno directly:
deno install -Agf -n glubean jsr:@glubean/cli
```

## Quick Start

```bash
mkdir my-api && cd my-api
glubean init                          # Scaffold project
glubean run                           # Run all tests
```

---

## Commands at a Glance

| Command            | Description                          | Typical user          |
| ------------------ | ------------------------------------ | --------------------- |
| `glubean init`     | Scaffold a new project               | Everyone              |
| `glubean run`      | Run tests locally or in CI           | Everyone              |
| `glubean upgrade`  | Self-update to latest version        | Everyone              |
| `glubean diff`     | Show OpenAPI spec changes vs git ref | API teams             |
| `glubean coverage` | Analyze endpoint test coverage       | API teams             |
| `glubean context`  | Generate AI-optimized context file   | AI-assisted workflows |
| `glubean scan`     | Generate metadata.json               | CI / Cloud            |
| `glubean sync`     | Upload tests to Glubean Cloud        | Cloud (coming soon)   |
| `glubean trigger`  | Trigger a remote run                 | Cloud (coming soon)   |

---

## Core Commands

### `glubean init`

Interactive wizard that scaffolds a project with sample tests, `.env` template, and `deno.json` config.

```bash
glubean init                                    # Interactive wizard
glubean init --minimal                          # Minimal explore-only project (GET, POST, pick)
glubean init --github-actions                   # Scaffold GitHub Actions workflow
glubean init --hooks                            # Install git hooks (pre-commit, pre-push)
glubean init --no-interactive --base-url https://api.example.com   # Non-interactive (CI)
```

| Flag               | Description                                             |
| ------------------ | ------------------------------------------------------- |
| `--minimal`        | Scaffold minimal explore-only project (GET, POST, pick) |
| `--hooks`          | Install git hooks (pre-commit, pre-push)                |
| `--github-actions` | Scaffold GitHub Actions workflow                        |
| `--base-url <url>` | API base URL for `.env`                                 |
| `--no-interactive` | Disable prompts (use with flags for CI)                 |
| `--overwrite`      | Overwrite existing files (dangerous)                    |

### `glubean run [target]`

Run tests from a file, directory, or glob pattern. This is the main command for both local development and CI.

```bash
glubean run                            # Run all tests (from config testDir)
glubean run tests/auth.test.ts         # Run a specific file
glubean run tests/                     # Run all tests in a directory
```

#### Options

**Target & filtering**

| Flag                     | Type          | Default          | Description                                            |
| ------------------------ | ------------- | ---------------- | ------------------------------------------------------ |
| `[target]`               | string        | config `testDir` | File, directory, or glob pattern                       |
| `--explore`              | boolean       | `false`          | Run from `exploreDir` instead of `testDir`             |
| `-f, --filter <pattern>` | string        | —                | Run tests matching pattern (substring on name or id)   |
| `-t, --tag <tag>`        | string        | —                | Run tests with matching tag (repeatable)               |
| `--tag-mode <mode>`      | `or` \| `and` | `or`             | Tag match logic: any tag or all tags                   |
| `--pick <keys>`          | string        | —                | Select `test.pick` example(s) by key (comma-separated) |

**Output & logging**

| Flag                  | Type    | Default | Description                                                |
| --------------------- | ------- | ------- | ---------------------------------------------------------- |
| `--verbose`           | boolean | `false` | Show traces, assertions, and full output in console        |
| `--result-json`       | boolean | `false` | Write structured results to `.result.json`                 |
| `--reporter <format>` | string  | —       | Output format: `junit` writes JUnit XML (`.junit.xml`)     |
| `-l, --log-file`      | boolean | `false` | Write logs to `<testfile>.log`                             |
| `--pretty`            | boolean | `false` | Pretty-print JSON in log files (2-space indent)            |
| `--emit-full-trace`   | boolean | `false` | Include full request/response headers and bodies in traces |

**Execution control**

| Flag                   | Type    | Default | Description                                                     |
| ---------------------- | ------- | ------- | --------------------------------------------------------------- |
| `--env-file <path>`    | string  | `.env`  | Path to environment file (missing keys fall back to system env) |
| `--config <paths>`     | string  | —       | Config file(s), comma-separated or repeatable                   |
| `--fail-fast`          | boolean | `false` | Stop on first test failure                                      |
| `--fail-after <n>`     | number  | —       | Stop after N test failures                                      |
| `--inspect-brk [port]` | number  | `9229`  | Enable V8 Inspector for debugging                               |
| `--no-update-check`    | boolean | `false` | Skip CLI version check                                          |

**Exit codes**: `0` = all tests passed, `1` = any test failed or no tests found.

### `glubean upgrade`

```bash
glubean upgrade           # Update to latest version
glubean upgrade --force   # Force reinstall even if up to date
```

---

## Analysis Commands

### `glubean diff`

Compare the current OpenAPI spec against a git ref to find untested API changes.

```bash
glubean diff --openapi openapi.json              # Compare against HEAD
glubean diff --openapi openapi.json --base main  # Compare against main branch
glubean diff --openapi openapi.json --json       # Output raw JSON
```

### `glubean coverage`

Analyze API endpoint test coverage based on OpenAPI spec and test traces.

```bash
glubean coverage --openapi openapi.json          # Coverage report
glubean coverage --openapi openapi.json --json   # Machine-readable output
```

### `glubean context`

Generate an AI-optimized context file for use with LLMs and MCP servers.

```bash
glubean context                                  # Auto-detect spec
glubean context --openapi openapi.json --out .glubean-context.md
```

---

## Cloud Commands (Coming Soon)

### `glubean sync`

Bundle and upload tests to Glubean Cloud for remote execution.

```bash
glubean sync --project my-project
glubean sync --project my-project --dry-run      # Preview without uploading
```

### `glubean trigger`

Trigger a remote test run on Glubean Cloud.

```bash
glubean trigger --project my-project
glubean trigger --project my-project --follow    # Tail logs until complete
```

---

## Environment Files

Glubean uses paired `.env` files — variables for non-sensitive config, secrets for credentials:

| Environment | Variables      | Secrets                |
| ----------- | -------------- | ---------------------- |
| Default     | `.env`         | `.env.secrets`         |
| Staging     | `.env.staging` | `.env.staging.secrets` |
| Production  | `.env.prod`    | `.env.prod.secrets`    |

Access in tests:

```typescript
const baseUrl = ctx.vars.require("BASE_URL"); // from .env
const apiKey = ctx.secrets.require("API_KEY"); // from .env.secrets
```

Resolution order (per key):

- `ctx.vars.*("KEY")`: `.env` (or selected `--env-file`) -> system env `KEY`
- `ctx.secrets.*("KEY")`: matching `.secrets` file -> system env `KEY`

If your shell variable names differ from the names used in tests, map them with `${...}`:

```dotenv
# .env
BASE_URL=${GLUBEAN_URL}

# .env.secrets
API_KEY=${GLUBEAN_API_KEY}
```

This lets teams reuse locally configured keys without copying raw secret values into project files.

> **Tip**: Add `.env.secrets` and `.env.*.secrets` to `.gitignore`. Never commit secrets.

## Configuration

The CLI reads configuration from the `glubean` field in `deno.json`:

```json
{
  "glubean": {
    "include": ["tests/**/*.test.ts"],
    "exclude": ["tests/helpers/**"]
  }
}
```

---

## Recipes

### From VS Code to CI

You've been writing and running tests with the VS Code extension. Now you want them to run automatically on every PR.
Here's how.

**1. Make sure your tests pass locally**

```bash
glubean run --env-file .env.ci --fail-fast
```

**2. Create a `.env.ci` file** with your CI environment values:

```env
BASE_URL=https://api-staging.example.com
```

**3. Store secrets in CI** — add `API_KEY` and other secrets as repository secrets in GitHub/GitLab. Create
`.env.ci.secrets` dynamically in your workflow:

```yaml
- name: Write secrets
  run: echo "API_KEY=${{ secrets.API_KEY }}" > .env.ci.secrets
```

**4. Add the workflow**

<details>
<summary>GitHub Actions</summary>

```yaml
name: API Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Glubean
        run: curl -fsSL https://glubean.com/install.sh | sh

      - name: Write secrets
        run: echo "API_KEY=${{ secrets.API_KEY }}" > .env.ci.secrets

      - name: Run tests
        run: |
          export PATH="$HOME/.deno/bin:$PATH"
          glubean run --env-file .env.ci --fail-fast --reporter junit --result-json

      - name: Upload test report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: |
            **/*.junit.xml
            **/*.result.json
```

</details>

<details>
<summary>GitLab CI</summary>

```yaml
api-tests:
  image: ubuntu:latest
  script:
    - apt-get update && apt-get install -y curl unzip
    - curl -fsSL https://glubean.com/install.sh | sh
    - export PATH="$HOME/.deno/bin:$PATH"
    - echo "API_KEY=$API_KEY" > .env.ci.secrets
    - glubean run --env-file .env.ci --fail-fast --reporter junit --result-json
  artifacts:
    when: always
    paths:
      - "**/*.junit.xml"
      - "**/*.result.json"
    reports:
      junit: "**/*.junit.xml"
```

</details>

> **Shortcut**: `glubean init --github-actions` scaffolds a starter workflow for you.

### Run smoke tests only

Tag your critical tests, then filter:

```typescript
test("health check", { tags: ["smoke"] }, async (ctx) => { ... });
```

```bash
glubean run --tag smoke --fail-fast
```

### Run a specific `test.pick` example

```bash
glubean run tests/products.test.ts --pick "electronics,clothing"
```

### Run with verbose output for debugging

```bash
glubean run tests/auth.test.ts --verbose --emit-full-trace
```

See full request/response headers and bodies in the console.

### Debug with breakpoints

```bash
glubean run tests/auth.test.ts --inspect-brk
```

Then attach VS Code debugger to port 9229 (the extension does this automatically when you use the debug button).

### Run against staging

```bash
glubean run --env-file .env.staging
```

This loads `.env.staging` for variables and `.env.staging.secrets` for secrets (if it exists).

### Generate machine-readable results

```bash
glubean run --result-json --emit-full-trace
```

Results are written to `.result.json`. Here's what the structure looks like:

```jsonc
{
  "target": "tests/",
  "files": ["tests/auth.test.ts", "tests/products.test.ts"],
  "runAt": "2026-02-14T08:30:00.000Z",
  "summary": {
    "total": 5,
    "passed": 4,
    "failed": 1, // ← use this for pass/fail notifications
    "skipped": 0,
    "durationMs": 3200,
    "stats": {
      "httpRequestTotal": 12,
      "httpErrorTotal": 1, // ← flag HTTP-level failures
      "assertionTotal": 18,
      "assertionFailed": 2
    }
  },
  "tests": [
    {
      "testId": "create-product",
      "testName": "Create Product",
      "tags": ["smoke", "write"],
      "success": false, // ← per-test pass/fail
      "durationMs": 820,
      "events": [
        {
          "type": "trace",
          "data": {
            "method": "POST",
            "url": "...",
            "status": 500,
            "duration": 650
          }
        },
        {
          "type": "assertion",
          "passed": false,
          "message": "expected 201 but got 500"
        },
        {
          "type": "status",
          "status": "failed",
          "error": "Assertion failed: expected 201 but got 500"
        }
        // ... more events
      ]
    }
    // ... more tests
  ]
}
```

Use this in CI to build custom notifications — for example, post a Slack message when `summary.failed > 0`, or send an
email with the list of failed test names:

```bash
# Example: extract failed test names with jq
jq -r '.tests[] | select(.success == false) | .testName' glubean-run.result.json
```

### JUnit XML for CI test reporting

```bash
glubean run --reporter junit
```

Writes a `.junit.xml` file that GitHub Actions, GitLab CI, Jenkins, and most CI systems natively understand. The XML
follows the standard `<testsuite>` / `<testcase>` schema:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="tests/" tests="5" failures="1" skipped="0" time="3.200">
  <testcase classname="tests/auth.test.ts" name="Login with valid creds" time="0.820" />
  <testcase classname="tests/auth.test.ts" name="Login with bad password" time="0.340">
    <failure message="expected 401 but got 500">expected 401 but got 500</failure>
  </testcase>
</testsuite>
```

Combine with `--result-json` for both human-readable results and CI integration:

```bash
glubean run --reporter junit --result-json
```

**GitHub Actions**: Upload as an artifact and it appears in the PR "Checks" tab:

```yaml
- name: Run tests
  run: glubean run --reporter junit --fail-fast

- name: Upload JUnit report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: junit-report
    path: "**/*.junit.xml"
```

**GitLab CI**: Use the `reports:junit` keyword for native test report integration:

```yaml
artifacts:
  reports:
    junit: "**/*.junit.xml"
```

---

## License

MIT
