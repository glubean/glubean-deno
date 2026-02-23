# Glubean MCP Server

> **Early-stage / experimental** — APIs may change without notice.

This package provides a **Model Context Protocol (MCP)** server that gives AI agents (Cursor, Windsurf, etc.) the
ability to discover, run, and debug Glubean API tests — closing the loop:

> AI writes checks → runs → sees structured failures → fixes → reruns. You review the diff.

## Prerequisites

**Deno** and a **Glubean project** are required. The MCP server runs tests via the Glubean runner, which is a Deno
module. Without an existing Glubean project (`deno.json`, `.env`, test files), every tool returns empty results or
errors.

If you use the [Glubean VS Code extension](https://marketplace.visualstudio.com/items?itemName=glubean.glubean), Deno is
already present — the extension checks for it on activation. The MCP server is a natural companion to the extension: the
extension gives you a visual runner and trace viewer, while the MCP server lets your AI agent participate in the same
workflow programmatically.

| Component              | Role                                                  |
| ---------------------- | ----------------------------------------------------- |
| **Glubean Extension**  | Visual runner, trace viewer, debug with breakpoints   |
| **Glubean MCP Server** | AI agent loop — discover, run, diagnose, fix          |
| **Glubean CLI**        | CI/CD, headless execution, `glubean init` scaffolding |

All three share the same SDK, runner, and project structure.

## Configuration

### Cursor

Add to `.cursor/mcp.json` in your project root (or globally in `~/.cursor/mcp.json`):

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

### VS Code (Copilot MCP)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "glubean": {
      "type": "stdio",
      "command": "deno",
      "args": ["run", "-A", "jsr:@glubean/mcp"]
    }
  }
}
```

### Windsurf / other MCP clients

Any MCP client that supports stdio transport can use the same command:

```bash
deno run -A jsr:@glubean/mcp
```

## Tools

### Test discovery & execution

- `glubean_discover_tests` — list all `test` exports in a file
- `glubean_run_local_file` — run tests locally and return structured results
- `glubean_list_test_files` — find test files in the project

### Debugging & diagnostics

- `glubean_get_last_run_summary` — summary of the most recent local run
- `glubean_get_local_events` — flattened events (`result`, `assertion`, `log`, `trace`) with optional filtering
- `glubean_diagnose_config` — checks project health (`deno.json`, `.env`, `.env.secrets`, `tests/`, `explore/`) and
  returns actionable recommendations

### Metadata & remote runs

- `glubean_get_metadata` — project metadata (test count, tags, files)
- `glubean_open_trigger_run` — trigger a remote run via Glubean Open Platform API
- `glubean_open_get_run` — fetch remote run status
- `glubean_open_get_run_events` — fetch remote run events

## Talking to your AI

Once configured, you can interact with the MCP tools using natural language. The AI agent will automatically pick the
right tool based on your prompt. Here are common scenarios:

### Generate and run a test

> "Write an API test for GET /users that checks status 200 and validates the response has an array of users. Run it."

The agent will create a test file, then call `glubean_run_local_file` to execute it. If assertions fail, it sees the
structured failures and can fix the code automatically.

### Debug a failing test

> "Run tests/users.test.ts and tell me what's failing."

Triggers `glubean_run_local_file` → the agent reads assertion results, traces, and logs to explain the failure.

### Check project setup

> "Is my Glubean project configured correctly?"

Triggers `glubean_diagnose_config` → returns missing `.env` vars, missing `deno.json`, or missing test directories with
fix suggestions.

### Explore existing tests

> "What tests do we have? Show me all test files."

Triggers `glubean_list_test_files` → lists all test files in the project.

> "What test cases are in tests/orders.test.ts?"

Triggers `glubean_discover_tests` → lists every exported `test` in that file with names and tags.

### Iterate on failures

> "The /orders endpoint now returns 201 instead of 200. Update the test and re-run."

The agent edits the test file, calls `glubean_run_local_file` again, and confirms all assertions pass. This is the core
AI loop — write, run, see facts, fix, repeat.

### Check the last run

> "What happened in the last test run? Show me the assertions."

Triggers `glubean_get_last_run_summary` and `glubean_get_local_events` to return structured results without re-running.

## Notes

- This is a **stdio** transport server. It must not write to stdout except MCP JSON-RPC messages.
- The server uses stderr for debug logs.
- Local execution spawns a Deno subprocess — the `-A` flag (or at least `--allow-run --allow-read --allow-net`) is
  required.

## Security

- The MCP server **never returns `.env.secrets` values** in tool output. Secret values are redacted.
- Remote run tools require a **project token** (Open Platform) with least-privilege scopes.
