/**
 * Unified project-level configuration loader for the Glubean CLI.
 *
 * Supports composable config merging with the following priority chain:
 *
 * - No --config: defaults -> deno.json "glubean" field -> CLI flags
 * - With --config: defaults -> file1 -> file2 -> ... -> fileN -> CLI flags
 *
 * When --config is specified, the automatic deno.json read is skipped
 * (unless deno.json is explicitly included in the --config list).
 *
 * Files named "deno.json" or "deno.jsonc" are special-cased: only the
 * "glubean" field is extracted. All other files are treated as plain
 * glubean config JSON.
 */

import { resolve } from "@std/path";
import { DEFAULT_CONFIG } from "@glubean/redaction";
import type { RedactionConfig } from "@glubean/redaction";
import { LOCAL_RUN_DEFAULTS } from "@glubean/runner";
import type { SharedRunConfig } from "@glubean/runner";

// ── Types ────────────────────────────────────────────────────────────────────

/** Run-related configuration (resolved — all fields have values). */
export interface GlubeanRunConfig {
  verbose: boolean;
  pretty: boolean;
  logFile: boolean;
  emitFullTrace: boolean;
  envFile: string;
  failFast: boolean;
  failAfter: number | null;
  /** Directory containing permanent test files (default: "./tests") */
  testDir: string;
  /** Directory containing exploratory test files (default: "./explore") */
  exploreDir: string;
  /** Per-test timeout in ms. Default: 30_000. */
  perTestTimeoutMs: number;
  /**
   * Max parallel test execution. Default: 1.
   * Reserved: CLI execution is currently serial; this field flows to
   * SharedRunConfig for Worker/future use but is not consumed by CLI's run loop.
   */
  concurrency: number;
  /** Deno permission flags for the sandboxed subprocess. */
  permissions: string[];
  /** Network access policy ("*" = unrestricted, "" = none, "host1,host2" = allowlist). */
  allowNet: string;
}

/** Partial run config as read from a file (all fields optional). */
export interface GlubeanRunConfigInput {
  verbose?: boolean;
  pretty?: boolean;
  logFile?: boolean;
  emitFullTrace?: boolean;
  envFile?: string;
  failFast?: boolean;
  failAfter?: number | null;
  testDir?: string;
  exploreDir?: string;
  perTestTimeoutMs?: number;
  concurrency?: number;
  permissions?: string[];
  allowNet?: string;
}

/** Redaction config input from user files (additive fields only). */
export interface GlubeanRedactionConfigInput {
  sensitiveKeys?: {
    additional?: string[];
    excluded?: string[];
  };
  patterns?: {
    custom?: Array<{ name: string; regex: string }>;
  };
  replacementFormat?: "simple" | "labeled" | "partial";
}

/** Cloud connection config (non-secret fields only). */
export interface GlubeanCloudConfigInput {
  projectId?: string;
  apiUrl?: string;
}

/** Fully resolved top-level config. */
export interface GlubeanConfig {
  run: GlubeanRunConfig;
  redaction: RedactionConfig;
  cloud?: GlubeanCloudConfigInput;
}

/** Partial top-level config as read from a file. */
export interface GlubeanConfigInput {
  run?: GlubeanRunConfigInput;
  redaction?: GlubeanRedactionConfigInput;
  cloud?: GlubeanCloudConfigInput;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const RUN_DEFAULTS: GlubeanRunConfig = {
  verbose: false,
  pretty: true,
  logFile: false,
  emitFullTrace: false,
  envFile: ".env",
  failFast: false,
  failAfter: null,
  testDir: "./tests",
  exploreDir: "./explore",
  perTestTimeoutMs: LOCAL_RUN_DEFAULTS.perTestTimeoutMs,
  concurrency: LOCAL_RUN_DEFAULTS.concurrency,
  permissions: [...LOCAL_RUN_DEFAULTS.permissions],
  allowNet: LOCAL_RUN_DEFAULTS.allowNet,
};

/**
 * Combined built-in defaults. Redaction reuses DEFAULT_CONFIG from
 * @glubean/redaction (mandatory baseline — cannot be weakened).
 */
export const CONFIG_DEFAULTS: GlubeanConfig = {
  run: { ...RUN_DEFAULTS },
  redaction: structuredClone(DEFAULT_CONFIG),
};

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Check if a filename should be treated as a deno config file. */
function isDenoConfig(filePath: string): boolean {
  const name = filePath.split("/").pop() ?? "";
  return name === "deno.json" || name === "deno.jsonc";
}

/**
 * Read a single config source from disk.
 *
 * If the file is a deno.json/deno.jsonc, extract the "glubean" field.
 * Otherwise treat the entire file as a glubean config object.
 */
export async function readSingleConfig(
  filePath: string,
): Promise<GlubeanConfigInput> {
  const content = await Deno.readTextFile(filePath);
  const parsed = JSON.parse(content);

  if (isDenoConfig(filePath)) {
    // Extract the "glubean" field from deno.json; return empty if absent
    return (parsed.glubean as GlubeanConfigInput) ?? {};
  }
  return parsed as GlubeanConfigInput;
}

/**
 * Merge two config inputs. Later (overlay) values take precedence.
 *
 * - Scalar fields: right wins.
 * - Array fields (sensitiveKeys.additional, sensitiveKeys.excluded,
 *   patterns.custom): concatenated (additive by nature).
 */
export function mergeConfigInputs(
  base: GlubeanConfigInput,
  overlay: GlubeanConfigInput,
): GlubeanConfigInput {
  const merged: GlubeanConfigInput = {};

  // ── Run section (shallow merge, scalars override) ──────────────────────
  if (base.run || overlay.run) {
    merged.run = { ...base.run, ...overlay.run };
  }

  // ── Redaction section ──────────────────────────────────────────────────
  if (base.redaction || overlay.redaction) {
    const br = base.redaction ?? {};
    const or = overlay.redaction ?? {};

    merged.redaction = {};

    // Replacement format: scalar, last wins
    if (or.replacementFormat !== undefined) {
      merged.redaction.replacementFormat = or.replacementFormat;
    } else if (br.replacementFormat !== undefined) {
      merged.redaction.replacementFormat = br.replacementFormat;
    }

    // Sensitive keys: arrays concatenate
    if (br.sensitiveKeys || or.sensitiveKeys) {
      merged.redaction.sensitiveKeys = {
        additional: [
          ...(br.sensitiveKeys?.additional ?? []),
          ...(or.sensitiveKeys?.additional ?? []),
        ],
        excluded: [
          ...(br.sensitiveKeys?.excluded ?? []),
          ...(or.sensitiveKeys?.excluded ?? []),
        ],
      };
    }

    // Patterns: custom array concatenates
    if (br.patterns || or.patterns) {
      merged.redaction.patterns = {
        custom: [
          ...(br.patterns?.custom ?? []),
          ...(or.patterns?.custom ?? []),
        ],
      };
    }
  }

  // ── Cloud section (shallow merge, scalars override) ─────────────────────
  if (base.cloud || overlay.cloud) {
    merged.cloud = { ...base.cloud, ...overlay.cloud };
  }

  return merged;
}

/**
 * Apply a GlubeanConfigInput on top of the mandatory DEFAULT_CONFIG baseline
 * to produce a fully resolved RedactionConfig.
 *
 * The baseline (scopes on, built-in patterns on) can never be weakened.
 * User config can only ADD: additional keys, custom patterns, replacement format.
 */
function resolveRedactionConfig(
  input?: GlubeanRedactionConfigInput,
): RedactionConfig {
  const merged: RedactionConfig = structuredClone(DEFAULT_CONFIG);

  if (!input) return merged;

  // Add user's additional sensitive keys
  if (input.sensitiveKeys?.additional) {
    for (const key of input.sensitiveKeys.additional) {
      if (
        typeof key === "string" &&
        !merged.sensitiveKeys.additional.includes(key)
      ) {
        merged.sensitiveKeys.additional.push(key);
      }
    }
  }

  // Note: excluded keys are tracked but don't weaken the baseline in cloud upload context.
  // They can be used for local-only scenarios in the future.

  // Add user's custom patterns
  if (input.patterns?.custom && Array.isArray(input.patterns.custom)) {
    for (const pattern of input.patterns.custom) {
      if (
        pattern &&
        typeof pattern.name === "string" &&
        typeof pattern.regex === "string"
      ) {
        merged.patterns.custom.push({
          name: pattern.name,
          regex: pattern.regex,
        });
      }
    }
  }

  // Allow user to change replacement format
  if (
    input.replacementFormat === "labeled" ||
    input.replacementFormat === "partial"
  ) {
    merged.replacementFormat = input.replacementFormat;
  }

  return merged;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load the resolved GlubeanConfig.
 *
 * - If `configPaths` is undefined or empty: auto-read deno.json in `rootDir`.
 * - If `configPaths` has entries: merge left-to-right, skip deno.json auto-read.
 *
 * All paths in `configPaths` are resolved relative to `rootDir`.
 * The final result is merged with CONFIG_DEFAULTS.
 *
 * @param rootDir - Project root directory (where deno.json lives).
 * @param configPaths - Optional list of config file paths from --config.
 */
export async function loadConfig(
  rootDir: string,
  configPaths?: string[],
): Promise<GlubeanConfig> {
  let accumulated: GlubeanConfigInput = {};

  if (configPaths && configPaths.length > 0) {
    // Explicit --config: merge left-to-right, skip auto deno.json read
    for (const configPath of configPaths) {
      const absPath = resolve(rootDir, configPath);
      try {
        const single = await readSingleConfig(absPath);
        accumulated = mergeConfigInputs(accumulated, single);
      } catch {
        // Warn but continue — missing config files are not fatal
        console.error(`Warning: Could not read config file: ${absPath}`);
      }
    }
  } else {
    // No --config: auto-read deno.json in rootDir
    for (const filename of ["deno.json", "deno.jsonc"]) {
      const denoPath = resolve(rootDir, filename);
      try {
        const single = await readSingleConfig(denoPath);
        accumulated = mergeConfigInputs(accumulated, single);
        break; // Use the first one found
      } catch {
        // Not found, try next
      }
    }
  }

  // Resolve run config: defaults + file values
  const resolvedRun: GlubeanRunConfig = {
    ...RUN_DEFAULTS,
    ...accumulated.run,
  };

  // Resolve redaction config: mandatory baseline + user overlay
  const resolvedRedaction = resolveRedactionConfig(accumulated.redaction);

  return {
    run: resolvedRun,
    redaction: resolvedRedaction,
    cloud: accumulated.cloud,
  };
}

/**
 * Merge resolved run config with CLI flags.
 *
 * Only flags that were explicitly passed by the user (not undefined)
 * override config values. This preserves config file settings for
 * any flag the user didn't specify on the command line.
 */
export function mergeRunOptions(
  config: GlubeanRunConfig,
  cliFlags: Record<string, unknown>,
): GlubeanRunConfig {
  const result = { ...config };

  if (cliFlags.verbose !== undefined) result.verbose = !!cliFlags.verbose;
  if (cliFlags.pretty !== undefined) result.pretty = !!cliFlags.pretty;
  if (cliFlags.logFile !== undefined) result.logFile = !!cliFlags.logFile;
  if (cliFlags.emitFullTrace !== undefined) {
    result.emitFullTrace = !!cliFlags.emitFullTrace;
  }
  if (cliFlags.envFile !== undefined) result.envFile = String(cliFlags.envFile);
  if (cliFlags.failFast !== undefined) result.failFast = !!cliFlags.failFast;
  if (cliFlags.failAfter !== undefined) {
    result.failAfter = cliFlags.failAfter === null ? null : Number(cliFlags.failAfter);
  }
  if (cliFlags.testDir !== undefined) result.testDir = String(cliFlags.testDir);
  if (cliFlags.exploreDir !== undefined) {
    result.exploreDir = String(cliFlags.exploreDir);
  }
  if (cliFlags.timeout !== undefined) {
    result.perTestTimeoutMs = Number(cliFlags.timeout);
  }
  // concurrency: reserved for future parallel execution in CLI.
  // Currently flows into SharedRunConfig but CLI's run loop is serial.

  return result;
}

/**
 * Convert a resolved GlubeanRunConfig to a SharedRunConfig
 * suitable for TestExecutor.fromSharedConfig().
 */
export function toSharedRunConfig(config: GlubeanRunConfig): SharedRunConfig {
  return {
    failFast: config.failFast,
    failAfter: config.failAfter ?? undefined,
    perTestTimeoutMs: config.perTestTimeoutMs,
    concurrency: config.concurrency,
    permissions: config.permissions,
    allowNet: config.allowNet,
    emitFullTrace: config.emitFullTrace,
  };
}
