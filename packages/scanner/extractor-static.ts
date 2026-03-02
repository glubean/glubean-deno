/**
 * Static analysis extractor for Glubean test files.
 *
 * Uses regex patterns to extract test metadata WITHOUT importing files.
 * This is useful for:
 * - Node.js environments (where Deno runtime extraction isn't available)
 * - Build systems that scan code without execution
 * - CI/CD pipelines
 *
 * Note: Static analysis may miss dynamically computed metadata.
 * Runtime extraction (via extractWithDeno) is preferred when possible.
 *
 * **Limitations:**
 * - Template variables (`$id`, `$_pick`) in IDs are preserved as-is, not resolved.
 * - Dynamically computed IDs or tags are not detected.
 * - `test.each()` / `test.pick()` produce one ExportMeta with the template ID,
 *   not one per data row (row count is unknown statically).
 * - Deeply nested or multi-line object literals with complex expressions may
 *   not be fully parsed.
 */

import type { ExportMeta } from "./types.ts";

// ---------------------------------------------------------------------------
// SDK import detection
// ---------------------------------------------------------------------------

/** Base function names that are always recognized. */
const BASE_FNS = ["test", "task"];

/** Direct SDK module import patterns. */
const SDK_MODULE_PATTERNS = [
  // jsr:@glubean/sdk or jsr:@glubean/sdk@0.5.0 (with optional version)
  /import\s+.*from\s+["']jsr:@glubean\/sdk(?:@[^"']*)?["']/,
  // @glubean/sdk (bare specifier via import map)
  /import\s+.*from\s+["']@glubean\/sdk(?:\/[^"']*)?["']/,
];

/** Escape special regex chars in a string. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex alternation from function names: `"test|task|browserTest"`.
 * When no custom names are provided, falls back to a convention pattern
 * that matches `test`, `task`, `*Test`, and `*Task`.
 */
function buildFnAlternation(customFns?: string[]): string {
  if (customFns && customFns.length > 0) {
    const all = [...new Set([...BASE_FNS, ...customFns])];
    return all.map(escapeRegExp).join("|");
  }
  // Convention fallback: test | task | *Test | *Task
  return "\\w*(?:Test|Task)|test|task";
}

/**
 * Check if a file's content looks like a Glubean test/task file.
 *
 * Useful as a fast guard before running the more expensive `extractFromSource`.
 *
 * Detection layers (any match → true):
 * 1. Direct SDK module import (`jsr:@glubean/sdk`, `@glubean/sdk`)
 * 2. Named import of a known function name (auto-detected aliases or convention)
 *
 * @param content - TypeScript source code
 * @param customFns - Additional function names discovered via `extractAliasesFromSource`.
 *                    When provided, these are checked in imports alongside the base names.
 *                    When omitted, falls back to `*Test` / `*Task` convention matching.
 * @returns `true` if the source looks like a Glubean file
 */
export function isGlubeanFile(content: string, customFns?: string[]): boolean {
  // Layer 1: Direct SDK module import
  if (SDK_MODULE_PATTERNS.some((p) => p.test(content))) return true;

  // Layer 2: Named import of a known function name
  const alt = buildFnAlternation(customFns);
  const importPattern = new RegExp(
    `import\\s+.*\\{[^}]*\\b(${alt})\\b[^}]*\\}`,
  );
  return importPattern.test(content);
}

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Remove comments from source while preserving line positions.
 * Block comments are replaced with spaces (newlines kept); line comments are
 * replaced with spaces up to the newline. String literals are skipped so that
 * `//` or `/*` inside strings are not treated as comments.
 */
function stripComments(source: string): string {
  let result = "";
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];

    // String literals — pass through unchanged
    if (ch === '"' || ch === "'") {
      const quote = ch;
      result += source[i++];
      while (i < len && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < len) result += source[i++];
        if (i < len) result += source[i++];
      }
      if (i < len) result += source[i++]; // closing quote
      continue;
    }

    // Template literal — simplified (no nested template tracking)
    if (ch === "`") {
      result += source[i++];
      while (i < len && source[i] !== "`") {
        if (source[i] === "\\" && i + 1 < len) result += source[i++];
        if (i < len) result += source[i++];
      }
      if (i < len) result += source[i++]; // closing backtick
      continue;
    }

    // Block comment — replace with spaces, keep newlines for line numbers
    if (ch === "/" && i + 1 < len && source[i + 1] === "*") {
      i += 2;
      result += "  ";
      while (i < len && !(source[i] === "*" && i + 1 < len && source[i + 1] === "/")) {
        result += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < len) {
        result += "  ";
        i += 2;
      }
      continue;
    }

    // Line comment — replace with spaces until newline
    if (ch === "/" && i + 1 < len && source[i + 1] === "/") {
      i += 2;
      while (i < len && source[i] !== "\n") {
        result += " ";
        i++;
      }
      continue;
    }

    result += source[i++];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Count newlines before `offset` to compute 1-based line number. */
function getLineNumber(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/**
 * Find the index of the matching closing bracket starting from `startIndex`
 * (which must point to the opening bracket). Respects string boundaries.
 * Returns -1 if no match is found.
 */
function findMatching(source: string, startIndex: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  let stringChar = "";

  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (ch === "\\" && i + 1 < source.length) {
        i++; // skip escaped char
        continue;
      }
      if (ch === stringChar) inString = false;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/** Shorthand: find closing `)` for an opening `(`. */
function findCloseParen(source: string, openIndex: number): number {
  return findMatching(source, openIndex, "(", ")");
}

/** Shorthand: find closing `}` for an opening `{`. */
function findCloseBrace(source: string, openIndex: number): number {
  return findMatching(source, openIndex, "{", "}");
}

// ---------------------------------------------------------------------------
// Metadata extraction from object literals
// ---------------------------------------------------------------------------

/**
 * Parse `id`, `name`, `tags`, and `timeout` from a TestMeta-like object literal string.
 * Handles both `tags: ["a", "b"]` and `tags: "a"` forms, with single or double quotes.
 */
function parseMetaObject(
  source: string,
): { id?: string; name?: string; tags?: string[]; timeout?: number } {
  const result: { id?: string; name?: string; tags?: string[]; timeout?: number } = {};

  const idMatch = source.match(/id:\s*(['"])([^'"]+)\1/);
  if (idMatch) result.id = idMatch[2];

  const nameMatch = source.match(/name:\s*(['"])([^'"]+)\1/);
  if (nameMatch) result.name = nameMatch[2];

  // Tags as array: tags: ["smoke", "auth"] or tags: ['smoke', 'auth']
  const tagsArrayMatch = source.match(/tags:\s*\[([^\]]*)\]/);
  if (tagsArrayMatch) {
    result.tags = [...tagsArrayMatch[1].matchAll(/(['"])([^'"]+)\1/g)].map((m) => m[2]);
  } else {
    // Tags as single string: tags: "smoke" or tags: 'smoke'
    const tagsStringMatch = source.match(/tags:\s*(['"])([^'"]+)\1/);
    if (tagsStringMatch) result.tags = [tagsStringMatch[2]];
  }

  const timeoutMatch = source.match(/timeout:\s*(\d+)/);
  if (timeoutMatch) result.timeout = Number(timeoutMatch[1]);

  return result;
}

/**
 * Extract `name` and `tags` from a `.meta({...})` builder call within `scope`.
 */
function extractBuilderMeta(
  scope: string,
): { name?: string; tags?: string[]; timeout?: number } {
  const match = scope.match(/\.meta\(\s*\{/);
  if (!match || match.index === undefined) return {};
  const braceStart = scope.indexOf("{", match.index);
  const braceEnd = findCloseBrace(scope, braceStart);
  if (braceEnd === -1) return {};
  const obj = scope.substring(braceStart, braceEnd + 1);
  return parseMetaObject(obj);
}

/**
 * Extract step names from `.step("name", ...)` or `.step('name', ...)` chains within `scope`.
 */
function extractSteps(scope: string): { name: string }[] {
  const steps: { name: string }[] = [];
  const stepPattern = /\.step\(\s*(['"])([^'"]+)\1/g;
  let m;
  while ((m = stepPattern.exec(scope)) !== null) {
    steps.push({ name: m[2] });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Declaration parser
// ---------------------------------------------------------------------------

/**
 * Parse a single test declaration from the text that follows `test` in
 * `export const NAME = test<scope>`. Returns null if the pattern is not
 * recognized.
 */
function parseTestDeclaration(
  scope: string,
  exportName: string,
  line: number,
): ExportMeta | null {
  let rest = scope;
  let variant: "each" | "pick" | undefined;

  // Check for .each() or .pick() — may appear on same line or next line
  const dataMatch = rest.match(/^\s*\.\s*(each|pick)\s*\(/);
  if (dataMatch) {
    variant = dataMatch[1] as "each" | "pick";
    const openIndex = rest.indexOf("(", dataMatch.index!);
    const closeIndex = findCloseParen(rest, openIndex);
    if (closeIndex === -1) return null;
    rest = rest.substring(closeIndex + 1);
  }

  // Expect opening paren of the test call: test( or test.each(...)( or <generic>test<T>(
  const callMatch = rest.match(/^\s*(?:<[^>]*>)?\s*\(/);
  if (!callMatch) return null;
  const callOpenIndex = rest.indexOf("(", callMatch.index!);

  const afterOpen = rest.substring(callOpenIndex + 1).trimStart();

  let id: string | undefined;
  let name: string | undefined;
  let tags: string[] | undefined;
  let timeout: number | undefined;

  if (afterOpen.startsWith('"') || afterOpen.startsWith("'")) {
    // String ID
    const quote = afterOpen[0];
    const endQuote = afterOpen.indexOf(quote, 1);
    if (endQuote === -1) return null;
    id = afterOpen.substring(1, endQuote);
  } else if (afterOpen.startsWith("{")) {
    // TestMeta object
    const braceEnd = findCloseBrace(afterOpen, 0);
    if (braceEnd === -1) return null;
    const objStr = afterOpen.substring(0, braceEnd + 1);
    const parsed = parseMetaObject(objStr);
    id = parsed.id;
    name = parsed.name;
    tags = parsed.tags;
    timeout = parsed.timeout;
  }

  if (!id) return null;

  // Extract builder .meta({...}) from the full scope
  const builderMeta = extractBuilderMeta(scope);
  if (!name && builderMeta.name) name = builderMeta.name;
  if (!tags && builderMeta.tags) tags = builderMeta.tags;
  if (timeout === undefined && builderMeta.timeout !== undefined) {
    timeout = builderMeta.timeout;
  }

  // Extract .step("name", ...) chains from the full scope
  const steps = extractSteps(scope);

  const result: ExportMeta = {
    type: "test",
    id,
    exportName,
    location: { line, col: 1 },
  };

  if (name) result.name = name;
  if (tags && tags.length > 0) result.tags = tags;
  if (timeout !== undefined) result.timeout = timeout;
  if (variant) result.variant = variant;
  if (steps.length > 0) result.steps = steps;

  return result;
}

// ---------------------------------------------------------------------------
// Alias discovery (auto-detect test.extend / task.extend)
// ---------------------------------------------------------------------------

/**
 * Extract custom function names created by `.extend()` calls.
 *
 * Scans source for patterns like:
 * - `const browserTest = test.extend({...})`
 * - `export const screenshotTest = browserTest.extend({...})`
 *
 * Returns the variable names (e.g. `["browserTest", "screenshotTest"]`).
 * These can then be passed to `extractFromSource()` and `isGlubeanFile()`
 * so they recognize `export const x = browserTest(...)` in other files.
 *
 * @param content - TypeScript source code
 * @returns Array of discovered alias names
 */
export function extractAliasesFromSource(content: string): string[] {
  const stripped = stripComments(content);
  // Match: [export] const NAME = SOMETHING.extend(
  const pattern = /(?:export\s+)?const\s+(\w+)\s*=\s*\w+\.extend\s*\(/g;
  const aliases: string[] = [];
  let m;
  while ((m = pattern.exec(stripped)) !== null) {
    aliases.push(m[1]);
  }
  return aliases;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract test metadata from TypeScript source using static analysis (regex).
 *
 * Recognizes the following patterns:
 * - `export const x = test("id", fn)` — simple test with string ID
 * - `export const x = test({ id, name, tags }, fn)` — simple test with meta
 * - `export const x = test("id").step(...)` — builder with steps
 * - `export const x = test.each(data)("id-$key", fn)` — data-driven
 * - `export const x = test.pick(examples)("id-$_pick", fn)` — example selection
 *
 * This is a pure function — no file system or runtime access needed.
 *
 * @param content - TypeScript source code
 * @param customFns - Additional function names discovered via `extractAliasesFromSource`.
 *                    When provided, these names are matched alongside `test` and `task`.
 *                    When omitted, falls back to `*Test` / `*Task` convention matching.
 * @returns Array of extracted export metadata
 */
export function extractFromSource(content: string, customFns?: string[]): ExportMeta[] {
  const results: ExportMeta[] = [];
  const stripped = stripComments(content);

  // Build the function-name alternation — either explicit aliases or convention fallback
  const alt = buildFnAlternation(customFns);
  const exportPattern = new RegExp(
    `export\\s+const\\s+(\\w+)\\s*=\\s*(${alt})\\b`,
    "g",
  );

  const matches: { exportName: string; offset: number; afterTest: number }[] = [];

  let m;
  while ((m = exportPattern.exec(stripped)) !== null) {
    matches.push({
      exportName: m[1],
      offset: m.index,
      afterTest: m.index + m[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const { exportName, offset, afterTest } = matches[i];
    // Scope from right after the function name to the start of the next export (or EOF)
    const endOffset = i + 1 < matches.length ? matches[i + 1].offset : stripped.length;
    const scope = stripped.substring(afterTest, endOffset);
    const line = getLineNumber(stripped, offset);

    const meta = parseTestDeclaration(scope, exportName, line);
    if (meta) results.push(meta);
  }

  return results;
}

/**
 * Create a static metadata extractor that uses file system to read content.
 *
 * Aliases can be supplied at two levels:
 * - `customFns` (construction-time): baked-in aliases known upfront.
 * - `runtimeFns` (call-time): aliases discovered during a Scanner two-phase
 *   scan. These are merged with `customFns` so the extractor benefits from
 *   aliases discovered after construction.
 *
 * @param readFile - Function to read file content as string
 * @param customFns - Additional function names (from alias discovery)
 * @returns MetadataExtractor function
 */
export function createStaticExtractor(
  readFile: (path: string) => Promise<string>,
  customFns?: string[],
): (filePath: string, runtimeFns?: string[]) => Promise<ExportMeta[]> {
  return async (filePath: string, runtimeFns?: string[]): Promise<ExportMeta[]> => {
    const content = await readFile(filePath);
    // Merge construction-time and call-time aliases
    const merged = customFns || runtimeFns ? [...new Set([...(customFns ?? []), ...(runtimeFns ?? [])])] : undefined;
    return extractFromSource(content, merged);
  };
}
