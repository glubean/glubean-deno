# Test Discovery Architecture

> Status: **Complete** — all phases (P0–P3) implemented\
> Last updated: 2025-02-17

## Problem

Test discovery (finding which tests exist, their IDs, tags, and metadata) is implemented **7 separate times** across the
Glubean ecosystem. These implementations vary in capability, leading to inconsistent behavior:

1. **Missing export shapes:** MCP fails to discover `test.each`, `test.pick`, and builder-without-`.build()` tests
   entirely.
2. **ID/exportName routing bug:** MCP passes `exportName` (e.g. `"listUsers"`) where the runner expects `meta.id` (e.g.
   `"list-users"`), causing "Test not found" failures for any test where `id !== exportName` — including plain simple
   tests.

## Three Discovery Methods

Every consumer of test metadata falls into one of three categories:

| Method       | How it works                       | Accuracy                                        | Cost                           | Use when                                   |
| ------------ | ---------------------------------- | ----------------------------------------------- | ------------------------------ | ------------------------------------------ |
| **Static**   | Regex scan of source code          | Template IDs only; no row expansion             | Zero side effects, fast        | IDE features, file indexing, quick preview |
| **Runtime**  | Import module + resolve exports    | Exact IDs, expanded rows, actual `Test` objects | Executes module top-level code | Local execution, precise discovery         |
| **Metadata** | Read pre-generated `metadata.json` | Matches the scan that generated it              | Offline, no execution          | Cloud worker, server, CI bundles           |

## Implementations (pre-consolidation snapshot)

> The descriptions below capture each implementation's state **before** the P0–P3 migration. See the Migration Plan
> section for what changed.

### 1. Scanner — `extractWithDeno` (Runtime, subprocess)

**Location:** `packages/scanner/extractor-deno.ts`\
**Used by:** `glubean scan`, `glubean sync`

Spawns a Deno subprocess, imports the test module, resolves all export shapes, and reads the SDK global registry as a
fallback.

| Capability                    | Supported              |
| ----------------------------- | ---------------------- |
| Plain `Test`                  | Yes                    |
| `Test[]` (test.each simple)   | Yes                    |
| `TestBuilder` (no `.build()`) | Yes (via registry)     |
| `EachBuilder`                 | Yes (calls `.build()`) |
| SDK registry fallback         | Yes                    |

**Verdict:** Most complete runtime extractor. Canonical for directory-level scanning.

### 2. Scanner — `extractFromSource` (Static, regex)

**Location:** `packages/scanner/extractor-static.ts`\
**Used by:** MCP `list_test_files` / `get_metadata(static)`, Node scanner

Pure-function regex extraction. No imports, no side effects. Produces one `ExportMeta` per export with template IDs
(e.g. `get-item-$id`, not expanded per row).

| Capability                             | Supported            |
| -------------------------------------- | -------------------- |
| `test("id", fn)`                       | Yes                  |
| `test({ id, name, tags }, fn)`         | Yes                  |
| `test("id").step(...)`                 | Yes (extracts steps) |
| `test.each(data)("id-$key", fn)`       | Yes (template ID)    |
| `test.pick(examples)("id-$_pick", fn)` | Yes (template ID)    |

**Verdict:** Best static extractor. Should be the single source for all regex-based discovery.

### 3. Runner — `harness.ts` (Runtime, in-process)

**Location:** `packages/runner/harness.ts` (private functions)\
**Used by:** Runner subprocess (test execution)

Runs inside the sandboxed subprocess. Imports the user module and resolves exports to find a specific test by ID.
Contains complete resolution logic: `isTestBuilder`, `isEachBuilder`, `autoResolve`, `findNewTest`,
`findNewTestByExport`.

| Capability                     | Supported |
| ------------------------------ | --------- |
| All export shapes              | Yes       |
| Find by test ID                | Yes       |
| Find by export name (fallback) | Yes       |
| Auto-build builders            | Yes       |

**Verdict (before P0):** Complete but locked inside `harness.ts` as private functions. Extracted to
`packages/runner/resolve.ts` in P0.

### 4. CLI — `commands/run.ts` (Runtime, subprocess)

**Location:** `packages/cli/commands/run.ts:274-389`\
**Used by:** `glubean run`

Independent subprocess-based discovery with its own `isTest`, `isBuilder`, `isEachBuilder`. Accesses private fields
(`_meta`, `_baseMeta`, `_table`) to read EachBuilder metadata without calling `.build()`.

| Capability                | Supported                     |
| ------------------------- | ----------------------------- |
| All export shapes         | Yes                           |
| EachBuilder row expansion | Yes (reads `_table` directly) |
| Builder metadata          | Yes (reads `_meta`)           |

**Verdict (before P1):** Worked but was a redundant reimplementation. Migrated to scanner's `extractWithDeno` in P1.

### 5. MCP — `mod.ts` (Runtime, in-process) — fixed in P0

**Location:** `packages/mcp/mod.ts`\
**Used by:** `glubean_discover_tests`, `glubean_run_local_file`

**Before P0:** In-process import with a primitive `isTest()` that only recognized plain `Test` objects. `run_local_file`
passed `exportName` as the `testId` argument, but the runner matches by `meta.id`. When `id !== exportName`, the test
was not found.

| Capability                       | Before P0 | After P0 |
| -------------------------------- | --------- | -------- |
| Plain `Test` (id === exportName) | Yes       | Yes      |
| Plain `Test` (id !== exportName) | **No**    | Yes      |
| `Test[]` (test.each simple)      | **No**    | Yes      |
| `TestBuilder` (no `.build()`)    | **No**    | Yes      |
| `EachBuilder`                    | **No**    | Yes      |

**After P0:** Replaced `isTest`/`discoverTestsFromFile` with runner's `resolveModuleTests`. Routing now uses `test.id`
(primary) with `exportName` fallback.

### 6. VSCode — `src/parser.ts` (Static, regex)

**Location:** `vscode/src/parser.ts` (separate repo)\
**Used by:** Test Explorer, CodeLens, Trace CodeLens

Fork of scanner's `extractor-static.ts`, adapted for VSCode. Maintained independently — will diverge over time.

| Capability                      | Supported                     |
| ------------------------------- | ----------------------------- |
| Same patterns as scanner static | Yes (at time of fork)         |
| `test.pick` example extraction  | Yes (extended beyond scanner) |

**Verdict (before P2):** Worked but was a fork. Migrated to `@glubean/scanner/static` in P2.

### 7. glubean-v1 — `packages/shared/src/scanner.ts` (Static, regex) — removed in P3

**Location:** `glubean-v1/packages/shared/src/scanner.ts`\
**Used by:** Nothing (server reads `metadata.json`, not source)

Legacy static extractor using old `testCase`/`testSuite` schema. Not aligned with current `test()` API.

**Verdict:** Dead code. Removed in P3.

### Non-discovery consumers (Metadata readers)

| Consumer         | Location                      | Method                                                               |
| ---------------- | ----------------------------- | -------------------------------------------------------------------- |
| **Worker**       | `packages/worker/executor.ts` | Reads `metadata.json` from bundle, `selectTests()` filters by ID/tag |
| **Cloud server** | `glubean-v1/apps/server/`     | Reads `metadata.json` from bundle upload, stores in MongoDB          |

These are correct by design — they consume metadata generated upstream by the scanner.

## Target Architecture

Three authoritative sources, zero duplication:

```
@glubean/scanner
├── extractFromSource()     ← Static (regex, pure function)
│   Used by: VSCode, MCP list_test_files, MCP get_metadata(static)
│
├── extractWithDeno()       ← Runtime (subprocess, most accurate)
│   Used by: CLI scan/sync, CLI run (P1 migration)
│
└── types.ts                ← Shared types (ExportMeta, FileMeta, etc.)

@glubean/runner
└── resolve.ts (NEW)        ← Runtime (in-process, for execution context)
    ├── resolveModuleTests()  — enumerate all tests from imported module
    ├── findTestById()        — find specific test by meta.id (primary)
    └── findTestByExport()    — find test by export name (fallback)
    Used by: Runner harness, MCP discover_tests/run_local_file
    Contract: resolveModuleTests returns { exportName, id, ... } —
              consumers MUST use id for routing, exportName for display

metadata.json               ← Offline (pre-generated)
    Used by: Worker, Cloud server
```

### Scanner subpath exports (enables VSCode consumption)

```jsonc
// packages/scanner/deno.json
{
  "exports": {
    ".": "./mod.ts", // Full scanner (Deno-only)
    "./static": "./static.ts" // Pure function (any runtime)
  }
}
```

This allows the VSCode extension (Node.js + esbuild) to:

```typescript
import { extractFromSource } from "@glubean/scanner/static";
```

without pulling in Deno-specific modules.

## Migration Plan

### P0: Fix MCP discovery and routing — DONE

**Problems:**

1. MCP `discover_tests` and `run_local_file` miss all `test.each`, `test.pick`, and builder exports (broken `isTest()`
   only recognizes plain `Test`).
2. MCP passes `exportName` as `testId` to the runner, causing "Test not found" for any test where `id !== exportName` —
   including simple tests.
3. Minor: Windows path bug, secrets pairing, silent zero-test "success".

**Solution:** Extract runner's resolution logic into `packages/runner/resolve.ts`, export `resolveModuleTests` from
`@glubean/runner`, replace MCP's broken `isTest()`/`discoverTestsFromFile()`. Fix test routing to pass `test.id` as
`testId` and `test.exportName` via the `exportName` option.

**Files changed:**

| File                              | Change                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/runner/resolve.ts`      | **New** — extracted resolution logic                                                                    |
| `packages/runner/resolve_test.ts` | **New** — contract tests (see below)                                                                    |
| `packages/runner/harness.ts`      | Import from `./resolve.ts` instead of private functions                                                 |
| `packages/runner/mod.ts`          | Export `resolveModuleTests`, `ResolvedTest`                                                             |
| `packages/mcp/mod.ts`             | Delete `isTest`/`isRecord`/`discoverTestsFromFile`, use runner's `resolveModuleTests`; fix test routing |

**MCP routing fix:**

```typescript
// Before (broken): passes exportName where runner expects meta.id
executor.run(fileUrl, test.exportName, { vars, secrets });

// After: passes actual test ID, with exportName as fallback
executor.run(fileUrl, test.id, { vars, secrets }, { exportName: test.exportName });
```

**Additional MCP fixes (same PR):**

- `findProjectRoot`: fix Windows infinite loop (`while (dir !== "/")` → `dirname` check)
- `testDir`: replace `lastIndexOf("/")` with `dirname()`
- Secrets pairing: `.env.staging` → `.env.staging.secrets`
- Zero-test error: return explicit error when `summary.total === 0`

#### Contract tests (required for P0)

A shared test fixture file exercises all export shapes. The `resolve_test.ts` test imports this fixture and asserts that
`resolveModuleTests` produces the expected set of test IDs.

**Fixture covers:**

| Shape                             | Export example                                                 | Expected ID(s)                |
| --------------------------------- | -------------------------------------------------------------- | ----------------------------- |
| Simple test (`id === exportName`) | `export const health = test("health", fn)`                     | `"health"`                    |
| Simple test (`id !== exportName`) | `export const listUsers = test({ id: "list-users" }, fn)`      | `"list-users"`                |
| Builder (no `.build()`)           | `export const flow = test("flow").step(...)`                   | `"flow"`                      |
| Builder (with `.build()`)         | `export const flow2 = test("flow2").step(...).build()`         | `"flow2"`                     |
| `test.each` (simple mode)         | `export const items = test.each(data)("item-$id", fn)`         | `"item-1"`, `"item-2"`, ...   |
| `test.each` (builder mode)        | `export const items2 = test.each(data)("item2-$id").step(...)` | `"item2-1"`, `"item2-2"`, ... |
| `test.pick`                       | `export const pick = test.pick(examples)("p-$_pick", fn)`      | `"p-<selected>"`              |
| `only` flag                       | `export const onlyTest = test({ id: "only", only: true }, fn)` | `"only"` with `only: true`    |
| `skip` flag                       | `export const skipTest = test({ id: "skip", skip: true }, fn)` | `"skip"` with `skip: true`    |

This same fixture can later be reused by scanner and MCP tests to verify cross-package semantic consistency.

### P1: Deduplicate CLI `run.ts` discovery — DONE

**Problem:** CLI had a ~100-line inline subprocess discovery script with `isTest`, `isBuilder`, `isEachBuilder` that
duplicated scanner's `extractWithDeno`. The Map-keyed-by-`exportName` return type silently dropped all but the last test
for `test.each`.

**Solution:** Extended `ExportMeta` with `skip`/`only` fields, wrote alignment contract tests for `extractWithDeno`
against the shared all-shapes fixture (13 tests), then replaced `discoverTests()` with a thin adapter calling
`extractWithDeno()`. Changed return from `Map<exportName>` to array, fixing the test.each data loss bug.

**Files changed:**

| File                                      | Change                                                         |
| ----------------------------------------- | -------------------------------------------------------------- |
| `packages/scanner/types.ts`               | Added `skip?` and `only?` to `ExportMeta`                      |
| `packages/scanner/extractor-deno.ts`      | Populated `skip`/`only` in subprocess script                   |
| `packages/scanner/extractor-deno_test.ts` | **New** — 13 contract tests                                    |
| `packages/cli/commands/run.ts`            | Replaced 100-line inline script with `extractWithDeno` adapter |

### P2: VSCode imports from scanner (cross-repo) — DONE

**Problem:** `vscode/src/parser.ts` is a fork of `extractor-static.ts` that will diverge.

**Solution:**

1. Add `"./static"` subpath export to scanner's `deno.json`
2. Publish scanner to JSR
3. VSCode installs via `npx jsr add @glubean/scanner`
4. Replace `parser.ts` regex with `import { extractFromSource } from "@glubean/scanner/static"`

**Changes:**

| File (OSS repo)                             | Change                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/scanner/types.ts`                 | Added `variant?: "each" \| "pick"` to `ExportMeta`                     |
| `packages/scanner/extractor-static.ts`      | Added `isGlubeanFile()`, populated `variant` in `parseTestDeclaration` |
| `packages/scanner/static.ts`                | **New** — Deno-free entry point re-exporting static analysis API       |
| `packages/scanner/deno.json`                | Added `"./static"` subpath export, bumped to 0.11.0                    |
| `packages/scanner/mod.ts`                   | Re-exported `isGlubeanFile` from main entry                            |
| `packages/scanner/extractor-static_test.ts` | Added 12 tests for `isGlubeanFile` and `variant`                       |

| File (VSCode repo)   | Change                                                                |
| -------------------- | --------------------------------------------------------------------- |
| `src/parser.ts`      | Replaced ~250 lines of regex logic with `extractFromSource` + adapter |
| `src/parser.test.ts` | Updated "id-missing" test to match scanner behavior                   |
| `package.json`       | Added `@glubean/scanner@^0.11.0` dependency                           |

**Note:** VSCode migration depends on scanner 0.11.0 being published to JSR. Scanner changes are shippable
independently. `extractPickExamples` remains VSCode-local — it serves CodeLens and has no scanner equivalent.

### P3: Remove legacy glubean-v1 scanner — DONE

**Problem:** `glubean-v1/packages/shared/src/scanner.ts` used old `testCase`/`testSuite` schema. Neither
`extractFromSource()` nor `hasGlubeanSdkImport()` were imported anywhere in the server or apps. The server defines its
own `ExportMeta`/`FileMeta`/`SuiteTestMeta` in `apps/server/src/bundles/schemas/bundle.schema.ts`.

**Solution:** Deleted `packages/shared/src/scanner.ts` and removed scanner re-exports from
`packages/shared/src/index.ts`. Verified `tsc --noEmit` clean (no scanner-related errors).

**Files changed:**

| File                                        | Change                               |
| ------------------------------------------- | ------------------------------------ |
| `glubean-v1/packages/shared/src/scanner.ts` | **Deleted** — 334 lines of dead code |
| `glubean-v1/packages/shared/src/index.ts`   | Removed scanner re-exports           |

## Decision Log

| Date       | Decision                                                          | Rationale                                                                                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2025-02-17 | Runner extracts `resolve.ts` instead of MCP using scanner         | Runner does in-process resolution (needs `Test` objects for execution). Scanner's `extractWithDeno` spawns a subprocess and returns metadata only — wrong abstraction for MCP's `run_local_file`.                                                                          |
| 2025-02-17 | Scanner adds subpath exports instead of new package               | `extractFromSource` is already in scanner, just needs a Deno-free entry point. No need for a new package.                                                                                                                                                                  |
| 2025-02-17 | Worker and server stay on `metadata.json`                         | They operate on pre-built bundles. Runtime discovery would be wasteful and insecure.                                                                                                                                                                                       |
| 2025-02-17 | P0 must include `id !== exportName` routing fix                   | The bug is not limited to data-driven tests — any test where the JS export name differs from the declared `id` fails silently. Fixing only `isTest` shapes without fixing routing would leave a critical hole.                                                             |
| 2025-02-17 | P0 must include cross-package contract tests                      | Without a shared fixture that scanner/runner/mcp all validate against, the "7 implementations" problem can regress after consolidation. Contract tests lock the semantic contract.                                                                                         |
| 2025-02-17 | P1 requires behavior-alignment tests before migration             | CLI's `discoverTests()` may have subtle behavioral differences from scanner's `extractWithDeno()`. Testing both against the same fixtures before switching prevents silent regressions.                                                                                    |
| 2025-02-17 | P1 extends ExportMeta with skip/only instead of separate CLI type | CLI needs skip/only for filtering. Adding to ExportMeta is non-breaking and avoids a CLI-specific discovery type. Static extractors return undefined for these (cannot determine at parse time).                                                                           |
| 2025-02-17 | P1 switches CLI discovery from Map to array                       | Old code keyed by exportName, silently dropping all but the last test.each row. Array preserves all entries and fixes the bug.                                                                                                                                             |
| 2025-02-17 | P2 adds `variant` to ExportMeta instead of ID prefixes            | VSCode needs to distinguish each/pick for routing. Adding `variant` to scanner types is neutral and informative. VSCode adapter applies `each:`/`pick:` prefixes from the field. Runtime extractor leaves it undefined — SDK uses same `EachBuilder` for both.             |
| 2025-02-17 | P2 adds `isGlubeanFile` to scanner                                | SDK import detection is generic static analysis, belongs in the shared scanner, not forked in VSCode.                                                                                                                                                                      |
| 2025-02-17 | P2 uses `typesVersions` for backward-compatible subpath types     | VSCode tsconfig uses `moduleResolution: "node"` (classic). Classic resolution ignores `exports` in package.json. `typesVersions` provides the fallback path for type resolution.                                                                                           |
| 2025-02-17 | P2 keeps `extractPickExamples` in VSCode                          | CodeLens pick-key extraction is a VSCode UX concern. Moving it to scanner would add presentation logic to a data extraction package. Can be ported later if other consumers need it.                                                                                       |
| 2025-02-17 | P3 deletes shared scanner without migrating server                | Server defines its own `ExportMeta`/`FileMeta`/`SuiteTestMeta` in `bundle.schema.ts` and has its own `extractExportMeta` in `builder.service.ts`. The shared scanner's functions (`extractFromSource`, `hasGlubeanSdkImport`) had zero imports across the entire codebase. |
