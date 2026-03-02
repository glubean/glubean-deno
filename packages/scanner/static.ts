/**
 * Deno-free entry point for static analysis of Glubean test files.
 *
 * This module re-exports the pure regex-based extractor and SDK import
 * detection utilities. It has **no runtime dependencies** — no `Deno.*` APIs,
 * no file system access — making it safe to consume from Node.js environments
 * such as the VSCode extension.
 *
 * @example Node.js / VSCode usage via JSR
 * ```ts
 * import { extractFromSource, isGlubeanFile } from "@glubean/scanner/static";
 *
 * const code = await fs.readFile("tests/api.test.ts", "utf-8");
 * if (isGlubeanFile(code)) {
 *   const tests = extractFromSource(code);
 *   console.log(`Found ${tests.length} tests`);
 * }
 * ```
 *
 * @module static
 */

export {
  createStaticExtractor,
  extractAliasesFromSource,
  extractFromSource,
  isGlubeanFile,
} from "./extractor-static.ts";

export type { ExportMeta } from "./types.ts";
