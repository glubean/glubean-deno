# Extend Alias Auto-Discovery

> Status: **Implemented**\
> Last updated: 2026-03-02

## Problem

The static parser (`extractFromSource`) only recognizes the literal function names `test` and `task`. When plugin
authors create custom test functions via `test.extend()` — a core SDK feature — those functions are **invisible** to
static analysis:

```typescript
// config/browser.ts — plugin author creates a custom test function
import { test } from "@glubean/sdk";
export const browserTest = test.extend({
  page: async (ctx, use) => {
    const pg = await chrome.newPage(ctx);
    try {
      await use(pg);
    } finally {
      await pg.close();
    }
  },
});

// tests/dynamic.test.ts — test file uses the custom function
import { browserTest } from "../config/browser.ts";
export const dropdown = browserTest({ id: "browser-dynamic-dropdown" }, async ({ page }) => {
  // ... test body
});
```

**Impact:** `dropdown` never appears in VSCode's Test Explorer, gets no play button in the gutter, and is excluded from
`glubean scan` static output. This defeats the purpose of the plugin system — extended tests are first-class at runtime
but second-class in tooling.

### Why import-based file detection fails

The original design used `isGlubeanFile()` as a gate: check if a file imports from `@glubean/sdk` before running
extraction. This fundamentally conflicts with the plugin pattern:

```
User creates helper → test.extend() in config/browser.ts
   ↓
Test file: import { browserTest } from "../../config/browser.ts"
   ↓
No @glubean/sdk import → isGlubeanFile() returns false → file skipped
```

In practice, Glubean projects only contain Glubean tests — there's no mixed-framework scenario. The `*.test.ts`
extension **is** the convention. Import-based detection is redundant at best, and actively breaks the plugin pattern.

## Solution

Two changes work together:

1. **File detection:** The `*.test.ts` extension is the sole convention. No import-based `isGlubeanFile()` gate. All
   `*.test.ts` files are processed; if extraction produces no results, the file is silently skipped.

2. **Test extraction:** Auto-discover `.extend()` aliases across the workspace, then use them to build the extraction
   regex so `extractFromSource` recognizes `browserTest(...)`, `withAuth(...)`, etc.

### Phase 1: Alias Discovery

Scan all `.ts` files for patterns like:

```typescript
const browserTest = test.extend({...})
export const screenshotTest = browserTest.extend({...})
```

The regex:

```typescript
/(?:export\s+)?const\s+(\w+)\s*=\s*\w+\.extend\s*\(/g;
```

This captures the variable name (e.g. `browserTest`, `screenshotTest`) without needing to resolve which base function it
extends from. The `.extend()` pattern is unique to the SDK — false positives from other libraries are harmless because
extraction still requires a valid test declaration to produce an `ExportMeta`.

**Output:** Array of alias names, e.g. `["browserTest", "screenshotTest"]`

### Phase 2: Test Extraction

With aliases known, `extractFromSource()` accepts an optional `customFns` parameter:

```typescript
extractFromSource(content, ["browserTest", "screenshotTest"]);
// → matches: export const x = browserTest("id", fn)
// → matches: export const x = screenshotTest.each(data)("id-$k", fn)
```

When `customFns` is provided, the regex becomes an explicit alternation:

```typescript
// With customFns=["browserTest"]:
/export\s+const\s+(\w+)\s*=\s*(test|task|browserTest)\b/g

// Without customFns (convention fallback):
/export\s+const\s+(\w+)\s*=\s*(\w*(?:Test|Task)|test|task)\b/g
```

The convention fallback (`*Test`, `*Task`) is used when no aliases have been discovered. It provides reasonable
out-of-the-box behavior for projects that follow the naming convention.

## Architecture

```
*.test.ts files ──────────────────────────────────────────┐
(detected by extension, no import check)                  │
                                                          │
                  ┌─────────────────────────────┐         │
                  │     .ts files in workspace   │         │
                  └──────────────┬───────────────┘         │
                                 │                         │
                    Phase 1: extractAliasesFromSource()    │
                    scans for .extend() calls              │
                                 │                         │
                                 ▼                         ▼
                  ┌─────────────────────────────┐    ┌──────────┐
                  │   Alias Set                  │──▶│ extract  │
                  │   {"browserTest",            │    │ FromSrc  │
                  │    "screenshotTest"}          │    └──────────┘
                  └─────────────────────────────┘
```

### API Changes

#### `extractAliasesFromSource(content: string): string[]`

**New export** from `@glubean/scanner/static`.

Scans TypeScript source for `.extend()` variable assignments. Returns discovered alias names. Comments are stripped
before scanning to avoid false matches in commented-out code.

#### `extractFromSource(content: string, customFns?: string[]): ExportMeta[]`

**Updated signature** — added optional `customFns` parameter.

Builds the export detection regex from `customFns` (explicit list) or convention fallback (`*Test`/`*Task`). All
downstream parsing (`.each()`, `.pick()`, `.step()`, `.meta()`) works the same regardless of which function name
matched.

#### `createStaticExtractor(readFile, customFns?): MetadataExtractor`

**Updated signature** — accepts aliases at two levels:

- `customFns` (construction-time): baked-in aliases known upfront
- `runtimeFns` (call-time): aliases discovered during Scanner's two-phase scan, merged with `customFns`

This ensures that when `Scanner.scan()` discovers aliases in Phase 1, they flow into the static extractor in Phase 2
even though the extractor was created before scanning began.

#### `MetadataExtractor` type

**Updated signature** — added optional `customFns` parameter:

```typescript
// Before:
type MetadataExtractor = (filePath: string) => Promise<ExportMeta[]>;

// After:
type MetadataExtractor = (filePath: string, customFns?: string[]) => Promise<ExportMeta[]>;
```

Runtime extractors (e.g. `extractWithDeno`) ignore the extra parameter — they resolve exports via type guards, not
regex.

#### `isGlubeanFile` — retained but no longer a gate

`isGlubeanFile(content, customFns?)` is still exported for backward compatibility and external consumers who want a
lightweight check. It is **no longer used as a gate** in Scanner, CLI, or VSCode — file detection is purely by
`*.test.ts` extension.

### Backward compatibility

- Existing callers that don't pass `customFns` get the convention fallback, which is a **superset** of the old behavior
  (old regex matched only `test`; convention matches `test`, `task`, `*Test`, `*Task`).
- The convention fallback produces no false positives in practice — `*Test`/`*Task` suffix is specific enough, and any
  matched export still must have a valid test declaration (string ID or `{ id }` object) to produce an `ExportMeta`.

## Integration Points

### Scanner (`packages/scanner/scanner.ts`)

The `Scanner` class performs two-phase scanning at the directory level:

```typescript
class Scanner {
  private async collectAliases(dir, skipDirs, extensions): Promise<string[] | undefined> {
    // Walk all .ts files, run extractAliasesFromSource on each
  }

  async scan(dir, options): Promise<ScanResult> {
    // Phase 1: discover aliases
    const aliases = await this.collectAliases(dir, skipDirs, extensions);
    // Phase 2: collect ALL *.test.ts files (no import check)
    for await (const filePath of this.fs.walk(dir, { extensions, skipDirs })) {
      if (!filePath.endsWith(".test.ts")) continue;
      testFiles.push(filePath);
    }
    // Phase 3: extract metadata, passing aliases to extractor
    for (const filePath of testFiles) {
      const exports = await this.extractor(filePath, aliases);
      // files with 0 exports are silently skipped
    }
  }
}
```

### metadata.json Generation (`glubean scan` / `glubean sync`)

`metadata.json` is produced by `Scanner.scan()` and consumed by the cloud worker and server.

| Path                                  | How aliases work                                                                          | Coverage                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `createScanner()` (Deno runtime)      | `extractWithDeno` ignores aliases (runtime type guards). All `*.test.ts` files are tried. | Full — runtime resolves all export shapes regardless of function name         |
| `createNodeScanner()` (Node static)   | Phase 1 aliases feed the static extractor via `extractor(filePath, aliases)`.             | Full — static extractor matches `withAuth(...)` etc. via explicit alternation |
| `createStaticScanner()` (Deno static) | Same as Node static path.                                                                 | Full                                                                          |

### CLI (`packages/cli/commands/run.ts`)

The CLI collects test files by `*.test.ts` extension only — no import-based `isGlubeanTestFile` check. `extractWithDeno`
(runtime) handles the actual discovery. Tag and ID filtering are post-filters on discovered tests.

```
resolveTestFiles(target)          — collect *.test.ts by extension
  ↓
discoverTests(filePath)           — extractWithDeno (runtime import)
  ↓
matchesTags / matchesFilter       — post-filter by tag/ID
```

### VSCode Extension (`vscode/src/testController.ts`)

The extension maintains a workspace-level alias registry:

```typescript
const aliasRegistry = new Set<string>();

async function discoverAliases(): Promise<void> {
  const tsFiles = await vscode.workspace.findFiles("**/*.ts", "**/node_modules/**");
  aliasRegistry.clear();
  for (const file of tsFiles) {
    const content = (await vscode.workspace.fs.readFile(file)).toString();
    for (const alias of extractAliasesFromSource(content)) {
      aliasRegistry.add(alias);
    }
  }
  // If aliases changed, re-parse all test files
  if (!setsEqual(prev, aliasRegistry)) {
    await discoverAllTests();
  }
}
```

**Lifecycle:**

- `discoverAliases()` runs once on extension activation (before initial test discovery)
- A file system watcher monitors non-test `.ts` files for changes — when a config file adds/removes an `.extend()` call,
  aliases are refreshed and all test files re-parsed

**Threading aliases to parser:**

```typescript
function parseFile(uri, content) {
  const aliases = getAliases();
  const tests = extractTests(content, aliases); // no isGlubeanFile gate
  if (tests.length === 0) /* clean up ghost nodes */ return;
  // ... populate Test Explorer
}
```

### VSCode Parser (`vscode/src/parser.ts`)

The parser adapter passes `customFns` directly to extraction:

```typescript
export function extractTests(content: string, customFns?: string[]): TestMeta[] {
  const all = extractFromSource(content, customFns).map(toTestMeta);
  // deduplicate by id...
  return filtered;
}
```

No `isGlubeanFile` guard — `extractFromSource` returns `[]` for non-Glubean content, which is the definitive answer.

### Runtime Extraction (Deno)

**No changes needed.** The Deno runtime extractor (`extractWithDeno`) imports test modules and inspects runtime objects
via type guards (`isTest`, `isBuilder`, `isEachBuilder`). It doesn't use regex and already handles extended test
functions correctly — a `browserTest(...)` call returns a `Test` object at runtime regardless of the function name.

## Edge Cases

| Scenario                                     | Behavior                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| No `.extend()` calls in project              | `customFns` is `undefined`, convention fallback used                                         |
| `.extend()` in commented-out code            | Comments stripped before scanning, no false match                                            |
| Chained `.extend()` (`a.extend → b.extend`)  | Both `a` and `b` are captured as aliases                                                     |
| `.extend()` in `node_modules`                | Excluded by default `skipDirs` / VSCode glob exclude                                         |
| Non-SDK `.extend()` (e.g. Playwright)        | Captured as alias, but no valid test declaration → no `ExportMeta` produced                  |
| Alias file deleted                           | File watcher triggers `discoverAliases()`, alias removed from registry, test files re-parsed |
| Custom function with no `Test`/`Task` suffix | Works when alias is explicitly discovered; falls through convention fallback (by design)     |
| Non-Glubean `*.test.ts` file in project      | `extractFromSource` returns `[]`, file silently skipped. Minor cost (< 1ms regex pass).      |

## Test Coverage

55 tests in `extractor-static_test.ts`:

- **Original tests** — backward compatibility for `test(...)` patterns
- **Convention matching** — `browserTest`, `deployTask`, `screenshotTest.each(...)`, `apiTask.pick(...)`
- **False positive prevention** — `latestResult(...)`, `multitask(...)` not matched
- **`extractAliasesFromSource`** — basic, chained, non-convention names, empty source, commented-out code
- **Explicit `customFns`** — `extractFromSource(content, ["withAuth"])` matches `export const x = withAuth(...)`
- **`isGlubeanFile` with `customFns`** — recognizes `import { withAuth } from "./fixtures"`

## Decision Log

| Date       | Decision                                                | Rationale                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-03-02 | `*.test.ts` extension as sole file detection convention | Import-based `isGlubeanFile` gate conflicts with the plugin pattern — test files import from local config files, not `@glubean/sdk` directly. Glubean projects don't mix test frameworks, so `.test.ts` is a sufficient and reliable signal. Removing the gate eliminates the entire alias-threading-for-file-detection complexity. |
| 2026-03-02 | Auto-detect over config-only                            | Config files (.glubeanrc, etc.) add friction for plugin authors and require documentation. Auto-detect works out of the box with zero config — just write `test.extend()` and tooling picks it up.                                                                                                                                  |
| 2026-03-02 | Convention as fallback, not primary                     | Convention (`*Test`/`*Task`) provides reasonable behavior before aliases are discovered (e.g. first parse before full workspace scan completes). But explicit aliases are preferred because they support arbitrary names.                                                                                                           |
| 2026-03-02 | Scan all `.ts` files, not just config dirs              | `.extend()` calls can live anywhere — `config/`, `fixtures/`, `utils/`, inline in test files. Scanning all `.ts` files (excluding `node_modules`) is the only reliable approach. Performance is acceptable: alias extraction is a single regex pass, no AST parsing.                                                                |
| 2026-03-02 | `.extend()` as the detection signal                     | `.extend()` is the only SDK API that creates new test functions. It is specific enough to avoid false positives from unrelated libraries. Even if a false positive occurs (e.g. Playwright's `.extend()`), it is harmless — the alias is captured but no valid test declaration is found in downstream extraction.                  |
| 2026-03-02 | Keep `ExportMeta.type` as `"test"` for all              | Extended functions (`browserTest`, `deployTask`) still produce `Test` objects at runtime. The type discrimination is `"test"` vs `"task"` at the SDK level, not the function name level. If the SDK adds a separate `task()` function in the future, `type` can be updated then.                                                    |
| 2026-03-02 | VSCode file watcher on non-test `.ts` files             | Test files (`*.test.ts`) are already watched for test discovery. Config files that define `.extend()` need a separate watcher so alias changes trigger re-discovery. Using a broad `.ts` watcher with a `!*.test.ts` filter covers all config file locations without knowing their paths in advance.                                |
| 2026-03-02 | Retain `isGlubeanFile` as utility, not gate             | `isGlubeanFile` is still useful as a lightweight heuristic for external consumers (e.g. build tools that want a quick check). But it is no longer used as a gate in Scanner, CLI, or VSCode — the `*.test.ts` extension is the authoritative signal.                                                                                |
