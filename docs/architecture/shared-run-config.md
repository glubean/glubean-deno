# Design: Unified SharedRunConfig

**Issue**: [glubean/glubean#1](https://github.com/glubean/glubean/issues/1) **Status**: Complete **Author**: AI
(reviewed by team)

## Problem

CLI, Worker, and MCP independently consume `@glubean/runner` but define overlapping execution config in separate
schemas. This leads to:

- **Divergent names** for the same concept (`failFast` vs `stopOnFailure`)
- **Missing features**: new run options must be added in 3 places
- **Inconsistent defaults**: CLI defaults to 30s timeout via runner; Worker defaults to 300s via its own config
- **Sandbox permissions hardcoded per consumer** instead of centralized

## Current State

### Runner (`packages/runner/executor.ts`)

The runner defines two option interfaces consumed by callers:

```typescript
// Per-test options
interface SingleExecutionOptions {
  onEvent?: EventHandler;
  includeTestId?: boolean;
  timeout?: number; // default: 30_000
}

// Batch options
interface ExecutionOptions {
  concurrency?: number; // default: 1
  stopOnFailure?: boolean;
  failAfter?: number;
  onEvent?: EventHandler;
}

// Constructor options
interface ExecutorOptions {
  maxHeapSizeMb?: number;
  v8Flags?: string[];
  permissions?: string[]; // default: ["--allow-net", "--allow-read", "--allow-env"]
  configPath?: string;
  cwd?: string;
  emitFullTrace?: boolean;
  inspectBrk?: number | boolean;
}
```

### CLI (`packages/cli/lib/config.ts`)

```typescript
interface GlubeanRunConfig {
  verbose: boolean;
  pretty: boolean;
  logFile: boolean;
  emitFullTrace: boolean; // ← also in ExecutorOptions
  envFile: string;
  failFast: boolean; // ← maps to stopOnFailure
  failAfter: number | null; // ← same as ExecutionOptions.failAfter
  testDir: string;
  exploreDir: string;
}
```

CLI translates `failFast` → `stopOnFailure: true` at call site in `run.ts`. No `timeout`, `concurrency`, or
`permissions` in config — hardcoded or absent.

### Worker (`packages/worker/config.ts`)

```typescript
interface WorkerConfig {
  // ... infrastructure fields ...
  allowNet: string; // ← used to build permissions[]
  executionTimeoutMs: number; // 300_000  — different name from runner
  executionConcurrency: number; // 1
  stopOnFailure: boolean; // ← different name from CLI's failFast
  // No failAfter
  // No emitFullTrace
}
```

Worker manually constructs `permissions` array with `--allow-net` and `--allow-read` only. **`--allow-env` is
intentionally omitted** — see Security section below.

### MCP (`packages/mcp/mod.ts`)

MCP's `runLocalTestsFromFile` accepts `stopOnFailure` and `concurrency` inline. It creates a bare `new TestExecutor()`
with no permissions/config, relying entirely on defaults.

## Security: `--allow-env` and Credential Isolation

### Why Worker omits `--allow-env`

The Worker process holds sensitive env vars (`GLUBEAN_WORKER_TOKEN`, `GLUBEAN_CONTROL_PLANE_URL`, etc.). Deno's
`Command` spawns subprocesses that inherit the parent's environment. If `--allow-env` is granted, user test code can
read these credentials:

```typescript
// User test code could do this:
const token = Deno.env.get("GLUBEAN_WORKER_TOKEN"); // ← credential leak
```

The harness has an env fallback path (`harness.ts:349-358`) where `ctx.vars.require("KEY")` falls back to
`Deno.env.get("KEY")`. This is designed for the CLI scenario (local dev, user's own machine). In Worker, all context is
passed explicitly via stdin — the fallback silently returns undefined, which is the correct and safe behavior.

### Permission model by context

| Context                      | `--allow-env` | `maskEnvPrefixes`          | Rationale                                   |
| ---------------------------- | ------------- | -------------------------- | ------------------------------------------- |
| CLI                          | Yes           | Not needed                 | Local dev, user's own machine               |
| MCP                          | Yes           | Not needed                 | Same as CLI — runs locally                  |
| Worker (cloud, multi-tenant) | No            | `["GLUBEAN_WORKER_TOKEN"]` | Double barrier: no env API + secrets masked |
| Worker (self-hosted)         | Yes           | `["GLUBEAN_WORKER_TOKEN"]` | Needs CI env; masking keeps secrets safe    |

**Decision rule**: `maskEnvPrefixes` is the **primary** security boundary. `--allow-env` is a **secondary** barrier. The
rule for each context is:

1. Always set `maskEnvPrefixes` when worker credentials exist in the process env.
2. Add `--allow-env` only when user test code legitimately needs `Deno.env.get()` (CLI, MCP, self-hosted workers with CI
   vars).
3. Omit `--allow-env` as an extra safety layer when there is no user need for it (cloud multi-tenant workers).

This means `permissions` **cannot have a single shared default**. The shared config provides a base that each consumer
augments:

```typescript
// SharedRunConfig provides only the universally safe permissions
permissions: ["--allow-read"];

// CLI/MCP add --allow-env at their layer (LOCAL_RUN_DEFAULTS)
// Cloud Worker does NOT add --allow-env (WORKER_RUN_DEFAULTS)
// Self-hosted Worker may add --allow-env — still safe because maskEnvPrefixes is set
```

### Defense in depth: env masking at the process level

`maskEnvPrefixes` is the mechanism that makes all Worker scenarios safe regardless of `--allow-env`. It overwrites
matching env vars with `"***"` in the subprocess, so even if `--allow-env` is present,
`Deno.env.get("GLUBEAN_WORKER_TOKEN")` returns `"***"`.

Currently the runner creates subprocesses without an explicit `env` field (`executor.ts:477`), which means the child
inherits the full parent environment. We add a `maskEnvPrefixes` option to `ExecutorOptions`:

```typescript
interface ExecutorOptions {
  // ... existing fields ...

  /**
   * Env var prefixes to mask in the subprocess environment.
   * Matching vars are overwritten with "***" (not removed).
   *
   * Why overwrite instead of remove? Deno.Command's `env` option
   * merges with (not replaces) the parent environment. Using
   * `clearEnv: true` would also wipe system vars (PATH, HOME, etc.).
   * Overwriting to "***" is safe and simple: the var exists but
   * holds no useful value.
   *
   * Worker sets: ["GLUBEAN_WORKER_TOKEN"]
   * CLI/MCP: undefined (no masking needed, user's own machine)
   */
  maskEnvPrefixes?: string[];
}
```

The executor builds the env overlay:

```typescript
private buildEnvOverlay(): Record<string, string> | undefined {
  const prefixes = this.options.maskEnvPrefixes;
  if (!prefixes?.length) return undefined; // inherit parent env as-is
  const overlay: Record<string, string> = {};
  for (const key of Object.keys(Deno.env.toObject())) {
    if (prefixes.some(p => key.startsWith(p))) {
      overlay[key] = "***";  // mask, don't remove
    }
  }
  return Object.keys(overlay).length > 0 ? overlay : undefined;
}
```

The overlay is passed to `Deno.Command`:

```typescript
const command = new Deno.Command(Deno.execPath(), {
  args,
  cwd: this.options.cwd,
  env: this.buildEnvOverlay(), // masks sensitive vars with "***"
  stdin: "piped",
  stdout: "piped",
  stderr: "piped",
});
```

This gives two independent layers of protection (cloud Worker uses both; self-hosted Worker relies on masking):

| Layer                  | Mechanism                                                        | Who uses it                                               |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| Env masking (primary)  | Sensitive vars overwritten with `"***"` before subprocess starts | All Workers (cloud + self-hosted)                         |
| Permission (secondary) | No `--allow-env` in subprocess                                   | Cloud Worker only (self-hosted may include `--allow-env`) |

### How masking works in practice

```
Worker process env:
  GLUBEAN_WORKER_TOKEN=secret123      ← sensitive credential
  GLUBEAN_CONTROL_PLANE_URL=https://  ← not sensitive, kept as-is
  DATABASE_URL=postgres://...         ← user's CI var

        │ maskEnvPrefixes: ["GLUBEAN_WORKER_TOKEN"]
        ▼

Subprocess env (what user code sees):
  GLUBEAN_WORKER_TOKEN=***            ← masked ✓
  GLUBEAN_CONTROL_PLANE_URL=https://  ← unchanged (not a secret)
  DATABASE_URL=postgres://...         ← preserved ✓
```

`GLUBEAN_CONTROL_PLANE_URL` is not a credential — it's a public endpoint URL. Only actual secrets (like
`GLUBEAN_WORKER_TOKEN`) need masking.

With masking in place, `--allow-env` controls only whether user code has the _API_ to call `Deno.env.get()` — but
`GLUBEAN_WORKER_TOKEN` already holds `"***"` in the subprocess. This is why cloud Worker omits `--allow-env` (extra
barrier, no user need) while self-hosted Worker can safely include it (user needs CI vars, secrets are masked).

## Proposed Design

### 1. Extract `SharedRunConfig` into `@glubean/runner`

Add a new interface in `packages/runner/config.ts`:

```typescript
/**
 * Shared execution configuration consumed by CLI, Worker, and MCP.
 *
 * This is the single source of truth for run-time behavior that is
 * common across all execution contexts.
 */
export interface SharedRunConfig {
  /** Stop after first failure. Default: false. */
  failFast: boolean;

  /** Stop after N failures. Takes precedence over failFast. Default: undefined. */
  failAfter?: number;

  /**
   * Per-test timeout in ms. Default: 30_000.
   *
   * Used as the timeout for each individual test execution (passed to
   * SingleExecutionOptions.timeout). NOT a batch-level timeout.
   *
   * For batch-level timeout, Worker uses its own `executionTimeoutMs`
   * (overall task deadline) and derives per-test timeout from it.
   */
  perTestTimeoutMs: number;

  /** Max parallel test execution. Default: 1. */
  concurrency: number;

  /**
   * Base Deno permission flags for the sandboxed subprocess.
   * Default: ["--allow-read"]
   *
   * SECURITY: This default is intentionally minimal. Consumers add
   * context-appropriate permissions on top:
   * - CLI/MCP add "--allow-env" (local dev, user's own machine)
   * - Worker does NOT add "--allow-env" (multi-tenant, holds credentials)
   *
   * Note: `--allow-net` is handled separately via `allowNet` because
   * it accepts a host allowlist (security policy, not a simple on/off).
   */
  permissions: string[];

  /**
   * Network access policy for the sandboxed subprocess.
   * - "*" or undefined: unrestricted (--allow-net)
   * - "api.example.com,db:5432": host allowlist (--allow-net=host1,host2)
   * - "": no network access (--allow-net omitted)
   *
   * Default: "*" (unrestricted)
   *
   * In cloud/multi-tenant workers, this is set per-team or per-job to
   * restrict which hosts user test code can reach.
   */
  allowNet: string;

  /** Include full HTTP request/response in trace events. Default: false. */
  emitFullTrace: boolean;
}

export const SHARED_RUN_DEFAULTS: SharedRunConfig = {
  failFast: false,
  perTestTimeoutMs: 30_000,
  concurrency: 1,
  permissions: ["--allow-read"], // minimal safe default
  allowNet: "*",
  emitFullTrace: false,
};

/** CLI/MCP preset: adds --allow-env for local development. */
export const LOCAL_RUN_DEFAULTS: SharedRunConfig = {
  ...SHARED_RUN_DEFAULTS,
  permissions: ["--allow-read", "--allow-env"],
};

/** Worker preset: no --allow-env, longer timeout. */
export const WORKER_RUN_DEFAULTS: SharedRunConfig = {
  ...SHARED_RUN_DEFAULTS,
  perTestTimeoutMs: 300_000,
  // permissions stays ["--allow-read"] — no --allow-env
};
```

### 2. Add `fromSharedConfig` factory and helpers

```typescript
/**
 * Create a TestExecutor pre-configured from SharedRunConfig.
 * Consumers only need to add context-specific overrides.
 */
static fromSharedConfig(
  shared: SharedRunConfig,
  overrides?: Partial<ExecutorOptions>,
): TestExecutor {
  // Sanitize: strip any --allow-net that leaked into permissions
  // (allowNet field is the single source for network policy).
  // --allow-env is NOT stripped here — it's a legitimate permission
  // that CLI/MCP presets include intentionally. Credential safety
  // is handled by maskEnvPrefixes, not by removing --allow-env.
  const sanitized = shared.permissions.filter(
    p => !p.startsWith("--allow-net"),
  );

  const netFlag = resolveAllowNetFlag(shared.allowNet);
  const permissions = netFlag
    ? [netFlag, ...sanitized]
    : [...sanitized];

  return new TestExecutor({
    permissions,
    emitFullTrace: shared.emitFullTrace,
    ...overrides,
  });
}

/**
 * Build ExecutionOptions from SharedRunConfig.
 * Maps failFast → stopOnFailure for backward compatibility
 * with the existing executeMany() interface.
 */
export function toExecutionOptions(
  shared: SharedRunConfig,
  extra?: Partial<ExecutionOptions>,
): ExecutionOptions {
  return {
    concurrency: shared.concurrency,
    stopOnFailure: shared.failFast,
    failAfter: shared.failAfter,
    ...extra,
  };
}

/**
 * Build SingleExecutionOptions from SharedRunConfig.
 * Wires perTestTimeoutMs to the per-test timeout parameter.
 */
export function toSingleExecutionOptions(
  shared: SharedRunConfig,
  extra?: Partial<SingleExecutionOptions>,
): SingleExecutionOptions {
  return {
    timeout: shared.perTestTimeoutMs,
    ...extra,
  };
}

function resolveAllowNetFlag(allowNet: string): string | null {
  const raw = (allowNet || "*").trim();
  if (raw === "") return null;
  if (raw === "*") return "--allow-net";
  const normalized = raw.split(",").map(h => h.trim()).filter(Boolean).join(",");
  return normalized ? `--allow-net=${normalized}` : "--allow-net";
}
```

### 3. Refactor consumers

#### CLI

The CLI config file format (`deno.json` `glubean` field) stays **flat** to avoid breaking existing configs. The internal
`GlubeanRunConfig` type absorbs the shared fields directly:

```typescript
// Internal type — NOT the file format
interface GlubeanRunConfig {
  // Fields from SharedRunConfig (flat, not nested)
  failFast: boolean;
  failAfter?: number;
  perTestTimeoutMs: number;
  concurrency: number;
  permissions: string[];
  allowNet: string;
  emitFullTrace: boolean;

  // CLI-specific fields
  verbose: boolean;
  pretty: boolean;
  logFile: boolean;
  envFile: string;
  testDir: string;
  exploreDir: string;
}
```

A helper extracts the shared portion:

```typescript
function toSharedRunConfig(run: GlubeanRunConfig): SharedRunConfig {
  return {
    failFast: run.failFast,
    failAfter: run.failAfter,
    perTestTimeoutMs: run.perTestTimeoutMs,
    concurrency: run.concurrency,
    permissions: run.permissions,
    allowNet: run.allowNet,
    emitFullTrace: run.emitFullTrace,
  };
}
```

CLI's `run.ts` creates the executor and wires timeout:

```typescript
const shared = toSharedRunConfig(effectiveRun);
const executor = TestExecutor.fromSharedConfig(shared, {
  configPath,
  cwd: rootDir,
  inspectBrk: options.inspectBrk,
});

// Per-test execution uses perTestTimeoutMs from config
for await (
  const event of executor.run(testFileUrl, testId, context, {
    ...toSingleExecutionOptions(shared), // ← wires perTestTimeoutMs
    exportName,
  })
) {
  // ...
}
```

**Config file compatibility**: The `deno.json` `glubean.run` object stays flat. New fields (`perTestTimeoutMs`,
`concurrency`, `permissions`, `allowNet`) are simply added — old configs without them get defaults. No nesting change,
no breaking change.

#### Worker

```typescript
// Before
interface WorkerConfig {
  // ... lots of fields including execution concerns ...
  allowNet: string;
  executionTimeoutMs: number;
  executionConcurrency: number;
  stopOnFailure: boolean;
}

// After
interface WorkerConfig {
  // Shared execution config (single source for run behavior)
  run: SharedRunConfig;

  // Infrastructure-specific (NOT in SharedRunConfig)
  controlPlaneUrl: string;
  workerToken: string;
  workerId: string;
  // ... heartbeat, event flush, download, etc. ...
  workDir: string;
  downloadTimeoutMs: number;

  // Worker-specific: overall task deadline (NOT per-test timeout)
  // Per-test timeout is derived: floor(taskTimeoutMs * 0.9 / testCount)
  taskTimeoutMs: number;
}
```

`allowNet` moves into `run: SharedRunConfig` — there is only one source. Worker's `loadConfig` populates `run.allowNet`
from `GLUBEAN_ALLOW_NET`.

Worker's `executor.ts` becomes:

```typescript
const executor = TestExecutor.fromSharedConfig(config.run, {
  maxHeapSizeMb,
  configPath,
  cwd: extractDir,
  maskEnvPrefixes: ["GLUBEAN_WORKER_TOKEN"],
});

// Guard: no tests → early return before timeout calculation
if (tests.length === 0) {
  pushEvent("result", { status: "completed", testId: "none", error: "No tests selected" });
  return { success: true, eventCount, aborted: false, timedOut: false };
}

// Per-test timeout derived from task deadline
const perTestTimeoutMs = Math.floor(config.taskTimeoutMs * 0.9 / tests.length);

const result = await executor.execute(testUrl, test.exportName, context, {
  ...toSingleExecutionOptions(config.run),
  timeout: perTestTimeoutMs > 0 ? perTestTimeoutMs : undefined, // override
  onEvent: handleEvent,
  includeTestId: true,
});
```

**Env var policy**: worker config accepts canonical names only:

| Canonical env var               | Purpose                     |
| ------------------------------- | --------------------------- |
| `GLUBEAN_FAIL_FAST`             | Per-test fail-fast behavior |
| `GLUBEAN_TASK_TIMEOUT_MS`       | Task timeout budget         |
| `GLUBEAN_EXECUTION_CONCURRENCY` | Test concurrency            |

Legacy keys such as `GLUBEAN_STOP_ON_FAILURE` and `GLUBEAN_EXECUTION_TIMEOUT_MS` fail fast with migration guidance.

#### MCP

```typescript
const shared: SharedRunConfig = {
  ...LOCAL_RUN_DEFAULTS, // includes --allow-env
  failFast: Boolean(args.stopOnFailure),
  concurrency: Math.max(1, args.concurrency ?? 1),
};

const executor = TestExecutor.fromSharedConfig(shared);

// Per-test execution wires timeout
for await (
  const event of executor.run(fileUrl, test.id, context, {
    ...toSingleExecutionOptions(shared), // ← wires perTestTimeoutMs
    exportName: test.exportName,
  })
) {
  // ...
}
```

### 4. Naming unification

| Concept            | Old (CLI)          | Old (Worker)                      | New (SharedRunConfig)            |
| ------------------ | ------------------ | --------------------------------- | -------------------------------- |
| Fail-fast          | `failFast`         | `stopOnFailure`                   | `failFast`                       |
| Fail after N       | `failAfter`        | —                                 | `failAfter`                      |
| Per-test timeout   | runner default 30s | derived from `executionTimeoutMs` | `perTestTimeoutMs`               |
| Task/batch timeout | —                  | `executionTimeoutMs`              | Worker-only: `taskTimeoutMs`     |
| Concurrency        | —                  | `executionConcurrency`            | `concurrency`                    |
| Full trace         | `emitFullTrace`    | —                                 | `emitFullTrace`                  |
| Network access     | —                  | `allowNet` (host list)            | `allowNet` (host list)           |
| Base permissions   | runner default     | hardcoded array                   | `permissions` (no `--allow-net`) |

### 5. Timeout semantics

Two distinct timeout concepts exist:

1. **`perTestTimeoutMs`** (SharedRunConfig): How long a single test can run before being killed. Passed to
   `SingleExecutionOptions.timeout`. Default: 30s (CLI/MCP), 300s (Worker preset).

2. **`taskTimeoutMs`** (Worker-only): Overall deadline for the entire task (download + extract + run all tests). Worker
   derives per-test timeout from this: `floor(taskTimeoutMs * 0.9 / testCount)`, overriding `perTestTimeoutMs` when the
   derived value is smaller.

CLI does not have a batch timeout — tests run sequentially or with concurrency but no overall deadline.

### 6. `allowNet` ownership

`allowNet` lives exclusively in `SharedRunConfig`. There is no second source:

- Worker populates `config.run.allowNet` from `GLUBEAN_ALLOW_NET` env var
- CLI populates it from config file (new optional field, defaults to `"*"`)
- `fromSharedConfig` resolves it into the correct `--allow-net` flag

No ambiguity, no conflict.

### 7. Worker threat models and egress guardrails

Worker runtime supports two deployment models:

1. `trusted` (self-hosted): operator-controlled infrastructure, no shared-tenant egress restrictions by default.
2. `shared_serverless`: multi-tenant serverless workers with mandatory egress guardrails.

In `shared_serverless` mode, guardrails are enforced inside harness runtime:

- Block sensitive destinations (localhost, private/link-local ranges, metadata endpoints).
- Resolve host IPs for each request and validate resolved addresses.
- Enforce protocol/port policy (`http`/`https` + configured allowed ports).
- Enforce per-execution limits (request count, in-flight concurrency, request timeout, response-byte budget).
- Emit warning events for blocked/limited traffic (rate-limited warning output).

## Migration Strategy

### Phase 1: Non-breaking (first PR)

1. Add `SharedRunConfig`, presets, `fromSharedConfig`, `toExecutionOptions`, `toSingleExecutionOptions` to
   `@glubean/runner`
2. Export `resolveAllowNetFlag` for consumers that need custom permission assembly
3. Keep existing interfaces intact — no breaking changes
4. Add deprecation JSDoc to `stopOnFailure` in `ExecutionOptions`

### Phase 2: Consumer migration (separate PRs per consumer)

5. **CLI**: Add new fields to `GlubeanRunConfig` (flat, backward-compatible), use `toSharedRunConfig` +
   `fromSharedConfig` in `run.ts`. Config file format stays flat — new fields are optional with defaults.
6. **Worker**: Replace execution fields with `run: SharedRunConfig`, add `taskTimeoutMs`, and enforce canonical env
   keys.
7. **MCP**: Use `LOCAL_RUN_DEFAULTS` + `fromSharedConfig`.
8. Update all tests in each consumer PR.

### Phase 3: Cleanup (after all workers are updated)

9. Remove deprecated `stopOnFailure` from `ExecutionOptions`
10. Enforce canonical worker env/file keys with explicit fail-fast errors
11. Remove redundant fields from consumer configs

## Risks

| Risk                                                         | Severity | Mitigation                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker env/file legacy keys are still used by deploy scripts | Medium   | Fail fast with clear error messages and update deployment docs/examples to canonical keys before rollout                                                                                                                                                                           |
| CLI config file format                                       | **Low**  | Format stays flat — only adds optional fields with defaults. No nesting change.                                                                                                                                                                                                    |
| `maskEnvPrefixes` misconfigured or omitted in Worker         | **High** | `maskEnvPrefixes` is the primary credential isolation barrier. Worker must always set it. Enforce via: (1) test that verifies Worker passes `maskEnvPrefixes` to `fromSharedConfig`, (2) code review checklist. `--allow-env` absence is a secondary barrier, not the primary one. |
| Version coordination (runner published before consumers)     | Low      | Already the normal flow — runner is a JSR dependency                                                                                                                                                                                                                               |

## Files Changed

| Package  | File                    | Change                                                                                                                                                                      |
| -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner` | new `config.ts`         | Add `SharedRunConfig`, presets, factory, helpers                                                                                                                            |
| `runner` | `executor.ts`           | Add `fromSharedConfig`, `maskEnvPrefixes`, `buildEnvOverlay`                                                                                                                |
| `runner` | `executor_test.ts`      | Tests for `fromSharedConfig`, permission sanitization, env masking, `resolveAllowNetFlag`                                                                                   |
| `cli`    | `lib/config.ts`         | Add shared fields to `GlubeanRunConfig`, `toSharedRunConfig` helper                                                                                                         |
| `cli`    | `lib/config_test.ts`    | Update tests for new fields + backward compat                                                                                                                               |
| `cli`    | `commands/run.ts`       | Use `fromSharedConfig` + `toSingleExecutionOptions`. (`toExecutionOptions` is provided for future batch paths like `executeMany`, not used in CLI's current per-test loop.) |
| `cli`    | `commands/init.ts`      | Check if generated `deno.json` glubean section needs new fields                                                                                                             |
| `cli`    | `templates/AGENTS.md`   | Update if config examples change                                                                                                                                            |
| `cli`    | `commands/init_test.ts` | Verify generated config matches expectations                                                                                                                                |
| `worker` | `config.ts`             | Replace execution fields with `run: SharedRunConfig` + `taskTimeoutMs`                                                                                                      |
| `worker` | `config_test.ts`        | Update tests, verify dual env var name support                                                                                                                              |
| `worker` | `executor.ts`           | Use `fromSharedConfig`, remove manual permission assembly                                                                                                                   |
| `worker` | `executor_test.ts`      | Update tests                                                                                                                                                                |
| `mcp`    | `mod.ts`                | Use `LOCAL_RUN_DEFAULTS` + `fromSharedConfig`                                                                                                                               |

## Open Questions

1. Should `perTestTimeoutMs` be configurable in the CLI's `deno.json` glubean section? Currently CLI has no timeout
   config — it relies on the runner default (30s) or per-test `ctx.setTimeout()`.
2. Should we add a `--timeout` CLI flag in this round, or defer?
3. Worker's `taskTimeoutMs` can also come from `context.limits?.timeoutMs` (per-job override from control plane). Should
   `SharedRunConfig.perTestTimeoutMs` be overridable at the job level too?
