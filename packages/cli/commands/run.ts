import {
  type ExecutionEvent,
  normalizePositiveTimeoutMs,
  TestExecutor,
  toSingleExecutionOptions,
} from "@glubean/runner";
import { basename, dirname, isAbsolute, relative, resolve, toFileUrl } from "@std/path";
import { loadConfig, mergeRunOptions, toSharedRunConfig } from "../lib/config.ts";
import { loadEnvFile } from "../lib/env.ts";
import { walk } from "@std/fs/walk";
import { expandGlob } from "@std/fs/expand-glob";
import { extractWithDeno } from "@glubean/scanner";

// ANSI color codes for pretty output
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

/**
 * Cloud runner memory limits by plan (V8 heap in MB).
 * Used to warn users during local development when their tests
 * may exceed cloud runner limits. Self-hosted runners have no limit.
 */
const CLOUD_MEMORY_LIMITS = {
  free: 300, // 512MB pod → ~300MB V8 heap
  pro: 700, // 1GB pod → ~700MB V8 heap
};

/** Threshold ratio to trigger memory warning (67% of free tier limit) */
const MEMORY_WARNING_THRESHOLD_MB = CLOUD_MEMORY_LIMITS.free * 0.67; // ~200MB

interface RunOptions {
  filter?: string;
  /** Select specific test.pick example(s) by key (comma-separated) */
  pick?: string;
  /** Exact-match tags (repeatable, OR logic by default) */
  tags?: string[];
  /** Tag match logic: "or" matches any tag, "and" requires all tags */
  tagMode?: "or" | "and";
  envFile?: string;
  /** Write logs to <testfile>.log */
  logFile?: boolean;
  /** Pretty-print JSON in log file */
  pretty?: boolean;
  /** Show all output (traces, assertions) in console */
  verbose?: boolean;
  /** Stop on first test failure */
  failFast?: boolean;
  /** Stop after N test failures */
  failAfter?: number;
  /** Write structured results — true for default path, string for custom path */
  resultJson?: boolean | string;
  /** Emit full HTTP request/response headers and bodies in trace events */
  emitFullTrace?: boolean;
  /** Config file paths from --config (undefined = auto-read deno.json) */
  configFiles?: string[];
  /** Enable V8 Inspector for debugging (port number or true for default 9229) */
  inspectBrk?: number | boolean;
  /** Output reporter format, optionally with custom path: "junit" or "junit:/path/to/output.xml" */
  reporter?: string;
  /** Custom path for JUnit XML output (parsed from --reporter junit:<path>) */
  reporterPath?: string;
  /** Max trace files to keep per test (default: 20) */
  traceLimit?: number;
  /** Upload results + artifacts to Glubean Cloud */
  upload?: boolean;
  /** Glubean Cloud project ID */
  project?: string;
  /** Auth token for cloud upload */
  token?: string;
  /** Glubean API server URL */
  apiUrl?: string;
}

/** Collected events for a single test, used for result JSON and summary. */
interface CollectedTestRun {
  testId: string;
  testName: string;
  tags?: string[];
  filePath: string;
  events: ExecutionEvent[];
  success: boolean;
  durationMs: number;
  groupId?: string;
}

/** Aggregated run-level summary data from all summary events. */
interface RunSummaryStats {
  httpRequestTotal: number;
  httpErrorTotal: number;
  assertionTotal: number;
  assertionFailed: number;
  warningTotal: number;
  warningTriggered: number;
  stepTotal: number;
  stepPassed: number;
  stepFailed: number;
}

/** Log entry for file output */
interface LogEntry {
  timestamp: string;
  testId: string;
  testName: string;
  type: "log" | "trace" | "assertion" | "metric" | "error" | "result" | "action" | "event";
  message: string;
  data?: unknown;
}

/**
 * Find project config by walking up from startDir looking for deno.json/deno.jsonc.
 * Returns the directory containing the config and the config path.
 */
async function findProjectConfig(
  startDir: string,
): Promise<{ rootDir: string; configPath?: string }> {
  let dir = startDir;
  while (dir !== "/") {
    try {
      const denoJson = resolve(dir, "deno.json");
      await Deno.stat(denoJson);
      return { rootDir: dir, configPath: denoJson };
    } catch {
      // Not found, try deno.jsonc
    }
    try {
      const denoJsonc = resolve(dir, "deno.jsonc");
      await Deno.stat(denoJsonc);
      return { rootDir: dir, configPath: denoJsonc };
    } catch {
      // Not found, go up one level
      dir = resolve(dir, "..");
    }
  }
  // No deno.json found, use the start directory
  return { rootDir: startDir };
}

const DEFAULT_SKIP_DIRS = ["node_modules", ".git", "dist", "build", ".deno"];
const DEFAULT_EXTENSIONS = ["ts"];

/**
 * Check if a path contains glob characters.
 */
function isGlob(target: string): boolean {
  return /[*?{[]/.test(target);
}

/**
 * Resolve a target (file, directory, or glob) into an array of test file paths.
 *
 * - Single file: returns [file] as-is.
 * - Directory: walks recursively, collects all *.test.ts files.
 * - Glob: expands pattern, collects all *.test.ts files.
 *
 * The *.test.ts extension is the convention — no import-based detection needed.
 */
async function resolveTestFiles(target: string): Promise<string[]> {
  const abs = resolve(target);

  // 1. Check if it's an existing file
  try {
    const stat = await Deno.stat(abs);
    if (stat.isFile) {
      return [abs];
    }

    // 2. Directory: walk and collect all *.test.ts files
    if (stat.isDirectory) {
      const skipPatterns = DEFAULT_SKIP_DIRS.map(
        (d) => new RegExp(`(^|/)${d}(/|$)`),
      );
      const files: string[] = [];
      for await (
        const entry of walk(abs, {
          exts: DEFAULT_EXTENSIONS,
          skip: skipPatterns,
        })
      ) {
        if (!entry.path.endsWith(".test.ts")) continue;
        if (entry.isFile) {
          files.push(entry.path);
        }
      }
      files.sort();
      return files;
    }
  } catch {
    // stat failed — might be a glob pattern
  }

  // 3. Glob pattern (only *.test.ts files)
  if (isGlob(target)) {
    const files: string[] = [];
    for await (
      const entry of expandGlob(target, {
        root: Deno.cwd(),
        extended: true,
        globstar: true,
      })
    ) {
      if (!entry.path.endsWith(".test.ts")) continue;
      if (entry.isFile) {
        files.push(entry.path);
      }
    }
    files.sort();
    return files;
  }

  // Fallback: treat as a file path (will error at discovery time)
  return [abs];
}

interface DiscoveredTestMeta {
  id: string;
  name?: string;
  tags?: string[];
  timeout?: number;
  skip?: boolean;
  only?: boolean;
  groupId?: string;
}

interface DiscoveredTest {
  exportName: string;
  meta: DiscoveredTestMeta;
}

/**
 * Discover tests from a file by delegating to scanner's extractWithDeno.
 * Returns one entry per test (including per-row entries for test.each).
 */
async function discoverTests(filePath: string): Promise<DiscoveredTest[]> {
  const metas = await extractWithDeno(filePath);
  return metas.map((m) => ({
    exportName: m.exportName,
    meta: {
      id: m.id,
      name: m.name,
      tags: m.tags,
      timeout: m.timeout,
      skip: m.skip,
      only: m.only,
      groupId: m.groupId,
    },
  }));
}

/**
 * Check if a test matches the --filter pattern (substring on name/id).
 */
function matchesFilter(testItem: DiscoveredTest, filter: string): boolean {
  const lowerFilter = filter.toLowerCase();
  // Match by ID (substring)
  if (testItem.meta.id.toLowerCase().includes(lowerFilter)) return true;
  // Match by name (substring)
  if (testItem.meta.name?.toLowerCase().includes(lowerFilter)) return true;
  return false;
}

/**
 * Check if a test matches the --tag values (exact, case-insensitive).
 * In "or" mode (default), matches if the test has ANY of the given tags.
 * In "and" mode, matches only if the test has ALL of the given tags.
 */
function matchesTags(
  testItem: DiscoveredTest,
  tags: string[],
  mode: "or" | "and" = "or",
): boolean {
  if (!testItem.meta.tags?.length) return false;
  const lowerTestTags = testItem.meta.tags.map((t) => t.toLowerCase());
  const match = (t: string) => lowerTestTags.includes(t.toLowerCase());
  return mode === "and" ? tags.every(match) : tags.some(match);
}

/**
 * Generate log file path from test file path.
 * auth.test.ts -> auth.test.log
 */
function getLogFilePath(testFilePath: string): string {
  // Replace extension with .log
  const lastDot = testFilePath.lastIndexOf(".");
  if (lastDot === -1) return testFilePath + ".log";
  return testFilePath.slice(0, lastDot) + ".log";
}

/** A discovered test with its source file path attached. */
interface FileTest {
  filePath: string;
  exportName: string;
  test: DiscoveredTest;
}

/**
 * Resolve a user-supplied output path safely.
 *
 * - Absolute paths are returned as-is (the caller explicitly chose the location).
 * - Relative paths are resolved from `cwd` and then validated to ensure they do
 *   not escape the project directory via `..` traversal sequences.
 *
 * Throws if a relative path would resolve outside `cwd`.
 */
function resolveOutputPath(userPath: string, cwd: string): string {
  if (isAbsolute(userPath)) {
    return resolve(userPath);
  }
  const resolved = resolve(cwd, userPath);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..")) {
    throw new Error(
      `Output path "${userPath}" escapes the project directory. ` +
        `Use an absolute path to write outside the project (e.g. /tmp/output.json).`,
    );
  }
  return resolved;
}

async function writeEmptyResult(target: string, runAt: string): Promise<void> {
  const payload = {
    target,
    files: [],
    runAt,
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, stats: {} },
    tests: [],
  };
  try {
    const glubeanDir = resolve(Deno.cwd(), ".glubean");
    await Deno.mkdir(glubeanDir, { recursive: true });
    await Deno.writeTextFile(
      resolve(glubeanDir, "last-run.result.json"),
      JSON.stringify(payload, null, 2),
    );
  } catch {
    // Non-critical
  }
}

/**
 * Run tests from a file, directory, or glob pattern with pretty output.
 */
export async function runCommand(
  target: string,
  options: RunOptions = {},
): Promise<void> {
  const logEntries: LogEntry[] = [];
  const runStartDate = new Date();
  const runStartTime = runStartDate.toISOString();
  const runStartLocal = localTimeString(runStartDate);

  // Collect traces for .glubean/traces.json (used by `glubean coverage`)
  const traceCollector: Array<{
    testId: string;
    method: string;
    url: string;
    status: number;
  }> = [];

  console.log(
    `\n${colors.bold}${colors.blue}🧪 Glubean Test Runner${colors.reset}\n`,
  );

  // ── Resolve target into test files ──────────────────────────────────────
  const testFiles = await resolveTestFiles(target);
  const isMultiFile = testFiles.length > 1;

  if (testFiles.length === 0) {
    console.error(
      `\n${colors.red}❌ No test files found for target: ${target}${colors.reset}`,
    );
    console.error(
      `${colors.dim}Check that your test directory contains *.test.ts files.${colors.reset}\n`,
    );
    await writeEmptyResult(target, runStartLocal);
    Deno.exit(1);
  }

  if (isMultiFile) {
    console.log(`${colors.dim}Target: ${resolve(target)}${colors.reset}`);
    console.log(
      `${colors.dim}Files:  ${testFiles.length} test file(s)${colors.reset}\n`,
    );
  } else {
    console.log(`${colors.dim}File: ${testFiles[0]}${colors.reset}\n`);
  }

  // Load .env file (from project root - directory containing deno.json)
  // Use the first test file's directory to find the project root
  const startDir = testFiles[0].substring(0, testFiles[0].lastIndexOf("/"));
  const { rootDir, configPath } = await findProjectConfig(startDir);

  // ── Load unified config and merge with CLI flags ──────────────────────
  const glubeanConfig = await loadConfig(rootDir, options.configFiles);
  const effectiveRun = mergeRunOptions(glubeanConfig.run, {
    verbose: options.verbose,
    pretty: options.pretty,
    logFile: options.logFile,
    emitFullTrace: options.emitFullTrace,
    envFile: options.envFile,
    failFast: options.failFast,
    failAfter: options.failAfter,
  });

  if (effectiveRun.logFile && !isMultiFile) {
    const logPath = getLogFilePath(testFiles[0]);
    console.log(`${colors.dim}Log file: ${logPath}${colors.reset}`);
  }

  const envFileName = effectiveRun.envFile || ".env";
  const envPath = resolve(rootDir, envFileName);
  const userSpecifiedEnvFile = !!options.envFile;

  // If user explicitly specified --env-file, the file MUST exist
  if (userSpecifiedEnvFile) {
    try {
      await Deno.stat(envPath);
    } catch {
      console.error(
        `${colors.red}Error: env file '${envFileName}' not found in ${rootDir}${colors.reset}`,
      );
      Deno.exit(1);
    }
  }

  const envVars = await loadEnvFile(envPath);

  // Secrets file follows the env file: .env → .env.secrets, .env.staging → .env.staging.secrets
  const secretsPath = resolve(rootDir, `${envFileName}.secrets`);
  let secretsExist = true;
  try {
    await Deno.stat(secretsPath);
  } catch {
    secretsExist = false;
  }
  const secrets = secretsExist ? await loadEnvFile(secretsPath) : {};

  if (!secretsExist && Object.keys(envVars).length > 0) {
    console.warn(
      `${colors.yellow}Warning: secrets file '${envFileName}.secrets' not found in ${rootDir}${colors.reset}`,
    );
  }

  if (Object.keys(envVars).length > 0) {
    console.log(
      `${colors.dim}Loaded ${Object.keys(envVars).length} vars from ${envFileName}${colors.reset}`,
    );
  }

  // ── Preflight: verify auth before running tests when --upload is set ────
  if (options.upload) {
    const { resolveToken, resolveProjectId, resolveApiUrl } = await import(
      "../lib/auth.ts"
    );
    const authOpts = {
      token: options.token,
      project: options.project,
      apiUrl: options.apiUrl,
    };
    const sources = {
      envFileVars: { ...envVars, ...secrets },
      cloudConfig: glubeanConfig.cloud,
    };
    const preToken = await resolveToken(authOpts, sources);
    const preProject = await resolveProjectId(authOpts, sources);
    const preApiUrl = await resolveApiUrl(authOpts, sources);
    if (!preToken) {
      console.error(
        `${colors.red}Error: --upload requires authentication but no token found.${colors.reset}`,
      );
      console.error(
        `${colors.dim}Run 'glubean login', set GLUBEAN_TOKEN, or add token to .env.secrets or deno.json glubean.cloud.${colors.reset}`,
      );
      Deno.exit(1);
    }
    if (!preProject) {
      console.error(
        `${colors.red}Error: --upload requires a project ID but none found.${colors.reset}`,
      );
      console.error(
        `${colors.dim}Use --project, set projectId in deno.json glubean.cloud, or run 'glubean init'.${colors.reset}`,
      );
      Deno.exit(1);
    }
    // Verify token is valid by calling whoami endpoint
    try {
      const resp = await fetch(`${preApiUrl}/open/v1/whoami`, {
        headers: { Authorization: `Bearer ${preToken}` },
      });
      if (!resp.ok) {
        console.error(
          `${colors.red}Error: authentication failed (${resp.status}).${colors.reset}`,
        );
        if (resp.status === 401) {
          console.error(
            `${colors.dim}Token is invalid or expired. Run 'glubean login' to re-authenticate.${colors.reset}`,
          );
        }
        Deno.exit(1);
      }
      const identity = await resp.json();
      console.log(
        `${colors.dim}Authenticated as ${
          identity.kind === "project_token" ? `project token (${identity.projectName})` : "user"
        } · upload to ${preApiUrl}${colors.reset}`,
      );
    } catch (err) {
      console.error(
        `${colors.red}Error: cannot reach server at ${preApiUrl}${colors.reset}`,
      );
      console.error(
        `${colors.dim}${(err as Error).message}${colors.reset}`,
      );
      Deno.exit(1);
    }
  }

  // ── Discover tests across all files ─────────────────────────────────────
  console.log(`${colors.dim}Discovering tests...${colors.reset}`);
  const allFileTests: FileTest[] = [];
  let totalDiscovered = 0;

  for (const filePath of testFiles) {
    try {
      const tests = await discoverTests(filePath);
      for (const test of tests) {
        allFileTests.push({ filePath, exportName: test.exportName, test });
      }
      totalDiscovered += tests.length;
    } catch (error) {
      if (isMultiFile) {
        const relPath = relative(Deno.cwd(), filePath);
        console.error(
          `  ${colors.red}✗${colors.reset} ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        console.error(
          `\n${colors.red}❌ Failed to load test file${colors.reset}`,
        );
        console.error(
          `${colors.dim}${error instanceof Error ? error.message : String(error)}${colors.reset}`,
        );
        Deno.exit(1);
      }
    }
  }

  if (allFileTests.length === 0) {
    console.error(
      `\n${colors.red}❌ No test cases found${
        isMultiFile ? ` in ${testFiles.length} file(s)` : " in file"
      }${colors.reset}`,
    );
    console.error(
      `${colors.dim}Make sure to export tests using test()${colors.reset}\n`,
    );
    Deno.exit(1);
  }

  if (isMultiFile) {
    // Show per-file discovery counts
    const fileCounts = new Map<string, number>();
    for (const ft of allFileTests) {
      fileCounts.set(ft.filePath, (fileCounts.get(ft.filePath) || 0) + 1);
    }
    for (const [fp, count] of fileCounts) {
      const relPath = relative(Deno.cwd(), fp);
      console.log(
        `  ${colors.dim}${relPath} (${count} test${count === 1 ? "" : "s"})${colors.reset}`,
      );
    }
  }

  // Check for .only flag
  const hasOnly = allFileTests.some((ft) => ft.test.meta.only);
  if (hasOnly) {
    console.log(
      `${colors.yellow}ℹ️  Running only tests marked with .only${colors.reset}`,
    );
  }

  // Apply filter and flags
  const hasTags = options.tags && options.tags.length > 0;
  const testsToRun = allFileTests.filter((ft) => {
    const tc = ft.test;
    // 1. Skip flag
    if (tc.meta.skip) return false;

    // 2. Only flag
    if (hasOnly && !tc.meta.only) return false;

    // 3. CLI --filter (substring on name/id)
    if (options.filter && !matchesFilter(tc, options.filter)) return false;

    // 4. CLI --tag (exact match, OR or AND mode)
    if (hasTags && !matchesTags(tc, options.tags!, options.tagMode)) {
      return false;
    }

    return true;
  });

  if (testsToRun.length === 0) {
    if (options.filter || hasTags) {
      const parts: string[] = [];
      if (options.filter) parts.push(`filter: "${options.filter}"`);
      if (hasTags) {
        const joiner = options.tagMode === "and" ? " AND " : " OR ";
        parts.push(`tag: ${options.tags!.join(joiner)}`);
      }
      console.error(
        `\n${colors.red}❌ No tests match ${parts.join(" + ")}${colors.reset}\n`,
      );
    } else {
      console.error(
        `\n${colors.red}❌ All tests skipped${colors.reset}\n`,
      );
    }
    Deno.exit(1);
  }

  if (options.filter || hasTags) {
    const parts: string[] = [];
    if (options.filter) parts.push(`filter: "${options.filter}"`);
    if (hasTags) {
      const joiner = options.tagMode === "and" ? " AND " : " OR ";
      parts.push(`tag: ${options.tags!.join(joiner)}`);
    }
    console.log(
      `${colors.dim}${parts.join(" + ")} (${testsToRun.length}/${totalDiscovered} tests)${colors.reset}`,
    );
  }

  console.log(
    `\n${colors.bold}Running ${testsToRun.length} test(s)...${colors.reset}\n`,
  );

  // Set GLUBEAN_PICK env var so test.pick() in the SDK selects specific examples.
  // The harness subprocess inherits parent env, so this flows through automatically.
  if (options.pick) {
    Deno.env.set("GLUBEAN_PICK", options.pick);
    console.log(`${colors.dim}  pick: ${options.pick}${colors.reset}`);
  } else {
    // Ensure previous runs don't leak
    try {
      Deno.env.delete("GLUBEAN_PICK");
    } catch {
      // env var may not exist
    }
  }

  // Execute tests
  const shared = toSharedRunConfig(effectiveRun);
  const executor = TestExecutor.fromSharedConfig(shared, {
    configPath,
    cwd: rootDir,
    ...(options.inspectBrk && { inspectBrk: options.inspectBrk }),
  });
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let overallPeakMemoryMB = 0;
  const totalStartTime = Date.now();

  // Collect all events per test (for result JSON and rich summary)
  const collectedRuns: CollectedTestRun[] = [];

  // Aggregate summary stats across all tests
  const runStats: RunSummaryStats = {
    httpRequestTotal: 0,
    httpErrorTotal: 0,
    assertionTotal: 0,
    assertionFailed: 0,
    warningTotal: 0,
    warningTriggered: 0,
    stepTotal: 0,
    stepPassed: 0,
    stepFailed: 0,
  };

  // Determine fail-fast threshold
  const failureLimit = effectiveRun.failAfter ??
    (effectiveRun.failFast ? 1 : undefined);

  // ── Group tests by file for batch execution ──
  // Running all tests from the same file in a single subprocess preserves
  // module-level state (let variables) between tests — critical for
  // integration test chains that share setup across tests.
  const fileGroups = new Map<string, typeof testsToRun>();
  for (const entry of testsToRun) {
    const group = fileGroups.get(entry.filePath) || [];
    group.push(entry);
    fileGroups.set(entry.filePath, group);
  }

  /**
   * Format a URL for compact display:
   * - strip protocol + host, show only pathname
   */
  const compactUrl = (url: string): string => {
    try {
      const u = new URL(url);
      return u.pathname + (u.search || "");
    } catch {
      return url;
    }
  };

  /** Color a status code: 2xx green, 4xx yellow, 5xx red */
  const colorStatus = (status: number): string => {
    if (status >= 500) return `${colors.red}${status}${colors.reset}`;
    if (status >= 400) return `${colors.yellow}${status}${colors.reset}`;
    return `${colors.green}${status}${colors.reset}`;
  };

  for (const [groupFilePath, fileTests] of fileGroups) {
    // Print per-file grouping header in multi-file mode
    if (isMultiFile) {
      const relPath = relative(Deno.cwd(), groupFilePath);
      console.log(`${colors.bold}📁 ${relPath}${colors.reset}`);
    }

    // Check if we should skip entire file due to fail-fast
    if (failureLimit !== undefined && failed >= failureLimit) {
      for (const { test } of fileTests) {
        skipped++;
        const name = test.meta.name || test.meta.id;
        console.log(
          `  ${colors.yellow}○${colors.reset} ${name} ${colors.dim}(skipped — fail-fast)${colors.reset}`,
        );
      }
      continue;
    }

    // Build batch: all test IDs from this file
    const testIds = fileTests.map((ft) => ft.test.meta.id);
    const exportNames: Record<string, string> = {};
    for (const ft of fileTests) {
      exportNames[ft.test.meta.id] = ft.exportName;
    }
    const testMap = new Map(
      fileTests.map((ft) => [ft.test.meta.id, ft]),
    );
    const testFileUrl = toFileUrl(groupFilePath).toString();

    // Batch timeout: sum of per-test timeouts
    const batchTimeout = fileTests.reduce((sum, ft) => {
      return sum +
        (normalizePositiveTimeoutMs(ft.test.meta.timeout) ??
          shared.perTestTimeoutMs ?? 30_000);
    }, 0);

    // Per-test state (reset on each "start" event)
    let testId = "";
    let testName = "";
    let testItem: (typeof fileTests)[0]["test"] | null = null;
    let startTime = Date.now();
    let testEvents: ExecutionEvent[] = [];
    let assertions: Array<{
      passed: boolean;
      message: string;
      actual?: unknown;
      expected?: unknown;
    }> = [];
    let success = false;
    let errorMsg: string | undefined;
    let peakMemoryMB: string | undefined;
    let stepAssertionCount = 0;
    let stepTraceLines: string[] = [];
    let testStarted = false;

    // Helper to add log entry for file output
    const addLogEntry = (
      type: LogEntry["type"],
      message: string,
      data?: unknown,
    ) => {
      if (effectiveRun.logFile) {
        logEntries.push({
          timestamp: new Date().toISOString(),
          testId,
          testName,
          type,
          message,
          data,
        });
      }
    };

    /** Finalize the current test: collect results, print status */
    const finalizeTest = () => {
      if (!testStarted) return;
      testStarted = false;
      const duration = Date.now() - startTime;
      const allAssertionsPassed = assertions.every((a) => a.passed);
      const finalSuccess = success && allAssertionsPassed;

      // Collect for result JSON output
      collectedRuns.push({
        testId,
        testName,
        tags: testItem?.meta.tags,
        filePath: groupFilePath,
        events: testEvents,
        success: finalSuccess,
        durationMs: duration,
        groupId: testItem?.meta.groupId,
      });

      addLogEntry("result", finalSuccess ? "PASSED" : "FAILED", {
        duration,
        success: finalSuccess,
        peakMemoryMB,
      });

      // Track overall peak memory
      const peakMB = peakMemoryMB ? parseFloat(peakMemoryMB) : 0;
      if (peakMB > overallPeakMemoryMB) {
        overallPeakMemoryMB = peakMB;
      }

      // Build per-test mini-stats
      const testHttpCalls = testEvents.filter((e) => e.type === "trace")
        .length;
      const testSteps = testEvents.filter((e) => e.type === "step_end")
        .length;
      const miniStats: string[] = [];
      miniStats.push(`${duration}ms`);
      if (testHttpCalls > 0) miniStats.push(`${testHttpCalls} calls`);
      if (assertions.length > 0) {
        miniStats.push(`${assertions.length} checks`);
      }
      if (testSteps > 0) miniStats.push(`${testSteps} steps`);

      if (finalSuccess) {
        console.log(
          `    ${colors.green}✓ PASSED${colors.reset} ${colors.dim}(${miniStats.join(", ")})${colors.reset}`,
        );
        passed++;
      } else {
        console.log(
          `    ${colors.red}✗ FAILED${colors.reset} ${colors.dim}(${miniStats.join(", ")})${colors.reset}`,
        );
        failed++;
      }

      // Warn if memory usage is approaching cloud runner limits
      if (peakMB > MEMORY_WARNING_THRESHOLD_MB) {
        if (peakMB > CLOUD_MEMORY_LIMITS.free) {
          console.log(
            `      ${colors.yellow}⚠ Memory (${peakMemoryMB} MB) exceeds Free cloud runner limit (${CLOUD_MEMORY_LIMITS.free} MB).${colors.reset}`,
          );
          console.log(
            `      ${colors.dim}  This test will OOM on Free runners. Use Pro runners or self-hosted workers.${colors.reset}`,
          );
        } else {
          console.log(
            `      ${colors.yellow}⚠ Memory (${peakMemoryMB} MB) is approaching Free cloud runner limit (${CLOUD_MEMORY_LIMITS.free} MB).${colors.reset}`,
          );
          console.log(
            `      ${colors.dim}  Consider optimizing or using self-hosted workers for headroom.${colors.reset}`,
          );
        }
      }

      // Show failed assertions
      for (const assertion of assertions) {
        if (!assertion.passed) {
          console.log(
            `      ${colors.red}✗ ${assertion.message}${colors.reset}`,
          );
          if (
            assertion.expected !== undefined ||
            assertion.actual !== undefined
          ) {
            if (assertion.expected !== undefined) {
              console.log(
                `        ${colors.dim}Expected: ${JSON.stringify(assertion.expected)}${colors.reset}`,
              );
            }
            if (assertion.actual !== undefined) {
              console.log(
                `        ${colors.dim}Actual:   ${JSON.stringify(assertion.actual)}${colors.reset}`,
              );
            }
          }
        }
      }

      // Show error if any
      if (errorMsg) {
        console.log(`      ${colors.red}Error: ${errorMsg}${colors.reset}`);
      }
    };

    // Stream events — batch all tests from this file in a single subprocess
    for await (
      const event of executor.run(
        testFileUrl,
        "",
        {
          vars: envVars,
          secrets,
        },
        {
          ...toSingleExecutionOptions(shared),
          timeout: batchTimeout,
          testIds,
          exportNames,
        },
      )
    ) {
      switch (event.type) {
        case "start": {
          // ── New test boundary ──
          const entry = testMap.get(event.id);
          testId = event.id;
          testName = entry?.test.meta.name || event.name || event.id;
          testItem = entry?.test || null;
          startTime = Date.now();
          testEvents = [];
          assertions = [];
          success = false;
          errorMsg = undefined;
          peakMemoryMB = undefined;
          stepAssertionCount = 0;
          stepTraceLines = [];
          testStarted = true;

          // Print test header
          const tags = testItem?.meta.tags?.length
            ? ` ${colors.dim}[${testItem.meta.tags.join(", ")}]${colors.reset}`
            : "";
          console.log(
            `  ${colors.cyan}●${colors.reset} ${testName}${tags}`,
          );
          break;
        }

        case "status":
          success = event.status === "completed";
          if (event.error) {
            errorMsg = event.error;
            addLogEntry("error", event.error);
          }
          if (event.peakMemoryMB) peakMemoryMB = event.peakMemoryMB;
          // Finalize this test
          finalizeTest();
          break;

        case "error":
          success = false;
          if (!errorMsg) {
            errorMsg = event.message;
          }
          addLogEntry("error", event.message);
          break;

        case "log":
          addLogEntry("log", event.message);
          if (event.message.startsWith("Loading test module:")) break;
          console.log(`      ${colors.dim}${event.message}${colors.reset}`);
          break;

        case "assertion":
          assertions.push({
            passed: event.passed,
            message: event.message,
            actual: event.actual,
            expected: event.expected,
          });
          stepAssertionCount++;
          addLogEntry("assertion", event.message, {
            passed: event.passed,
            actual: event.actual,
            expected: event.expected,
          });
          if (effectiveRun.verbose) {
            const icon = event.passed ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
            console.log(
              `        ${icon} ${colors.dim}${event.message}${colors.reset}`,
            );
          }
          break;

        case "trace": {
          const traceMsg = `${event.data.method} ${event.data.url} → ${event.data.status} (${event.data.duration}ms)`;
          addLogEntry("trace", traceMsg, event.data);
          traceCollector.push({
            testId,
            method: event.data.method,
            url: event.data.url,
            status: event.data.status,
          });
          const compactTrace = `${colors.dim}${event.data.method}${colors.reset} ${
            compactUrl(event.data.url)
          } ${colors.dim}→${colors.reset} ${
            colorStatus(event.data.status)
          } ${colors.dim}${event.data.duration}ms${colors.reset}`;
          stepTraceLines.push(compactTrace);
          console.log(
            `      ${colors.dim}↳${colors.reset} ${compactTrace}`,
          );
          if (effectiveRun.verbose && event.data.requestBody) {
            console.log(
              `        ${colors.dim}req: ${JSON.stringify(event.data.requestBody).slice(0, 120)}${colors.reset}`,
            );
          }
          if (effectiveRun.verbose && event.data.responseBody) {
            const body = JSON.stringify(event.data.responseBody);
            console.log(
              `        ${colors.dim}res: ${body.slice(0, 120)}${body.length > 120 ? "…" : ""}${colors.reset}`,
            );
          }
          break;
        }

        case "action": {
          const a = event.data;
          if (a.category === "http:request") break;
          const statusColor = a.status === "ok" ? colors.green : a.status === "error" ? colors.red : colors.yellow;
          const statusIcon = a.status === "ok" ? "✓" : a.status === "error" ? "✗" : "⏱";
          addLogEntry(
            "action",
            `[${a.category}] ${a.target} ${a.duration}ms ${a.status}`,
            a,
          );
          console.log(
            `      ${colors.dim}↳${colors.reset} ${colors.cyan}${a.category}${colors.reset} ${a.target} ${colors.dim}${a.duration}ms${colors.reset} ${statusColor}${statusIcon}${colors.reset}`,
          );
          break;
        }

        case "event": {
          const ev = event.data;
          addLogEntry("event", `[${ev.type}]`, ev);
          if (effectiveRun.verbose) {
            const summary = JSON.stringify(ev.data).slice(0, 80);
            console.log(
              `      ${colors.dim}[${ev.type}] ${summary}${colors.reset}`,
            );
          }
          break;
        }

        case "metric": {
          const unit = event.unit ? ` ${event.unit}` : "";
          const tagStr = event.tags
            ? ` ${colors.dim}{${
              Object.entries(event.tags)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")
            }}${colors.reset}`
            : "";
          const metricMsg = `${event.name} = ${event.value}${unit}`;
          addLogEntry("metric", metricMsg, {
            name: event.name,
            value: event.value,
            unit: event.unit,
            tags: event.tags,
          });
          if (effectiveRun.verbose) {
            console.log(
              `      ${colors.blue}📊 ${metricMsg}${colors.reset}${tagStr}`,
            );
          }
          break;
        }

        case "step_start":
          stepAssertionCount = 0;
          stepTraceLines = [];
          console.log(
            `    ${colors.cyan}┌${colors.reset} ${colors.dim}step ${
              event.index + 1
            }/${event.total}${colors.reset} ${colors.bold}${event.name}${colors.reset}`,
          );
          break;

        case "step_end": {
          const stepIcon = event.status === "passed"
            ? `${colors.green}✓${colors.reset}`
            : event.status === "failed"
            ? `${colors.red}✗${colors.reset}`
            : `${colors.yellow}○${colors.reset}`;
          const stepParts: string[] = [];
          if (event.durationMs !== undefined) {
            stepParts.push(`${event.durationMs}ms`);
          }
          if (event.assertions > 0) {
            stepParts.push(`${event.assertions} assertions`);
          }
          const httpInStep = stepTraceLines.length;
          if (httpInStep > 0) {
            stepParts.push(
              `${httpInStep} API call${httpInStep > 1 ? "s" : ""}`,
            );
          }
          console.log(
            `    ${colors.cyan}└${colors.reset} ${stepIcon} ${colors.dim}${stepParts.join(" · ")}${colors.reset}`,
          );
          break;
        }

        case "summary":
          runStats.httpRequestTotal += event.data.httpRequestTotal;
          runStats.httpErrorTotal += event.data.httpErrorTotal;
          runStats.assertionTotal += event.data.assertionTotal;
          runStats.assertionFailed += event.data.assertionFailed;
          runStats.warningTotal += event.data.warningTotal;
          runStats.warningTriggered += event.data.warningTriggered;
          runStats.stepTotal += event.data.stepTotal;
          runStats.stepPassed += event.data.stepPassed;
          runStats.stepFailed += event.data.stepFailed;
          break;

        case "warning": {
          const warnIcon = event.condition ? `${colors.green}✓${colors.reset}` : `${colors.yellow}⚠${colors.reset}`;
          console.log(
            `      ${warnIcon} ${colors.yellow}${event.message}${colors.reset}`,
          );
          break;
        }

        case "schema_validation":
          if (effectiveRun.verbose) {
            const icon = event.success ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
            console.log(
              `      ${icon} ${colors.dim}schema: ${event.label}${colors.reset}`,
            );
          }
          break;
      }

      // Collect every event for result JSON and summary
      if (testStarted) testEvents.push(event);
    }

    // Handle process crash mid-test (no "status" event received)
    if (testStarted) {
      if (!errorMsg) errorMsg = "Process exited before test completed";
      finalizeTest();
    }
  }

  const totalDurationMs = Date.now() - totalStartTime;

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(
    `\n${colors.bold}─────────────────────────────────────${colors.reset}`,
  );
  const summaryParts = [];
  if (passed > 0) {
    summaryParts.push(`${colors.green}${passed} passed${colors.reset}`);
  }
  if (failed > 0) {
    summaryParts.push(`${colors.red}${failed} failed${colors.reset}`);
  }
  if (skipped > 0) {
    summaryParts.push(`${colors.yellow}${skipped} skipped${colors.reset}`);
  }
  console.log(
    `${colors.bold}Tests:${colors.reset}  ${summaryParts.join(", ")}`,
  );
  console.log(
    `${colors.bold}Total:${colors.reset}  ${passed + failed + skipped}`,
  );
  if (overallPeakMemoryMB > 0) {
    const memColor = overallPeakMemoryMB > MEMORY_WARNING_THRESHOLD_MB ? colors.yellow : colors.dim;
    console.log(
      `${colors.bold}Memory:${colors.reset} ${memColor}${
        overallPeakMemoryMB.toFixed(2)
      } MB peak${colors.reset} ${colors.dim}(cloud: ${CLOUD_MEMORY_LIMITS.free} MB Free / ${CLOUD_MEMORY_LIMITS.pro} MB Pro / unlimited self-hosted)${colors.reset}`,
    );
  }

  // Rich summary from collected events
  const hasStats = runStats.httpRequestTotal > 0 ||
    runStats.assertionTotal > 0 ||
    runStats.stepTotal > 0;
  if (hasStats) {
    const parts: string[] = [];
    if (runStats.httpRequestTotal > 0) {
      const errPart = runStats.httpErrorTotal > 0
        ? ` ${colors.red}(${runStats.httpErrorTotal} errors)${colors.reset}`
        : "";
      parts.push(`${runStats.httpRequestTotal} API calls${errPart}`);
    }
    if (runStats.assertionTotal > 0) {
      const failPart = runStats.assertionFailed > 0
        ? ` ${colors.red}(${runStats.assertionFailed} failed)${colors.reset}`
        : "";
      parts.push(`${runStats.assertionTotal} assertions${failPart}`);
    }
    if (runStats.stepTotal > 0) {
      parts.push(`${runStats.stepTotal} steps`);
    }
    if (runStats.warningTriggered > 0) {
      parts.push(
        `${colors.yellow}${runStats.warningTriggered} warnings${colors.reset}`,
      );
    }
    console.log(
      `${colors.bold}Stats:${colors.reset}  ${colors.dim}${
        parts.join(
          "  ·  ",
        )
      }${colors.reset}`,
    );
  }

  console.log();

  // Write log file if enabled (single-file: <file>.log, multi-file: glubean-run.log in cwd)
  if (effectiveRun.logFile && logEntries.length > 0) {
    const logPath = isMultiFile ? resolve(Deno.cwd(), "glubean-run.log") : getLogFilePath(testFiles[0]);

    // Helper for JSON stringify with optional pretty-print
    const stringify = (value: unknown): string => {
      if (effectiveRun.pretty) {
        // Pretty-print with 2-space indent, then indent each line for log format
        const pretty = JSON.stringify(value, null, 2);
        return pretty.split("\n").join("\n    ");
      }
      return JSON.stringify(value);
    };

    const logContent = [
      `# Glubean Test Log`,
      `# Target: ${isMultiFile ? resolve(target) : testFiles[0]}`,
      `# Run at: ${runStartTime}`,
      `# Tests: ${passed} passed, ${failed} failed`,
      ``,
      ...logEntries.map((entry) => {
        const prefix = `[${entry.timestamp}] [${entry.testId}]`;
        if (entry.type === "result") {
          return `${prefix} ${entry.message} (${(entry.data as { duration: number }).duration}ms)`;
        }
        if (entry.type === "assertion") {
          const data = entry.data as {
            passed: boolean;
            actual?: unknown;
            expected?: unknown;
          };
          const status = data.passed ? "✓" : "✗";
          let line = `${prefix} [ASSERT ${status}] ${entry.message}`;
          // Always show expected/actual if available
          if (data.expected !== undefined || data.actual !== undefined) {
            if (data.expected !== undefined) {
              line += `\n    Expected: ${stringify(data.expected)}`;
            }
            if (data.actual !== undefined) {
              line += `\n    Actual:   ${stringify(data.actual)}`;
            }
          }
          return line;
        }
        if (entry.type === "trace") {
          const data = entry.data as {
            method?: string;
            url?: string;
            status?: number;
            duration?: number;
            requestBody?: unknown;
            responseBody?: unknown;
          };
          let line = `${prefix} [TRACE] ${entry.message}`;
          if (data.requestBody !== undefined) {
            line += `\n    Request Body: ${stringify(data.requestBody)}`;
          }
          if (data.responseBody !== undefined) {
            line += `\n    Response Body: ${stringify(data.responseBody)}`;
          }
          return line;
        }
        if (entry.type === "metric") {
          const data = entry.data as {
            name?: string;
            value?: number;
            unit?: string;
            tags?: Record<string, string>;
          };
          let line = `${prefix} [METRIC] ${entry.message}`;
          if (data.tags && Object.keys(data.tags).length > 0) {
            line += `\n    Tags: ${stringify(data.tags)}`;
          }
          return line;
        }
        if (entry.type === "error") {
          return `${prefix} [ERROR] ${entry.message}`;
        }
        return `${prefix} [LOG] ${entry.message}`;
      }),
      ``,
    ].join("\n");

    await Deno.writeTextFile(logPath, logContent);
    console.log(`${colors.dim}Log written to: ${logPath}${colors.reset}\n`);
  }

  // Write .glubean/traces.json for `glubean coverage`
  if (traceCollector.length > 0) {
    try {
      const glubeanDir = resolve(rootDir, ".glubean");
      await Deno.mkdir(glubeanDir, { recursive: true });
      const tracesPath = resolve(glubeanDir, "traces.json");
      const traceSummary = {
        runAt: runStartTime,
        target,
        files: testFiles.map((f) => relative(Deno.cwd(), f)),
        traces: traceCollector,
      };
      await Deno.writeTextFile(
        tracesPath,
        JSON.stringify(traceSummary, null, 2),
      );
    } catch {
      // Non-critical: silently skip if trace file cannot be written
    }
  }

  // ── Result JSON output ───────────────────────────────────────────────────
  // Always write .glubean/last-run.result.json for tooling (VS Code, viewer).
  // When --result-json is set, also write to the explicit/default path.
  const resultPayload = {
    target,
    files: testFiles.map((f) => relative(Deno.cwd(), f)),
    runAt: runStartLocal,
    summary: {
      total: passed + failed + skipped,
      passed,
      failed,
      skipped,
      durationMs: totalDurationMs,
      stats: runStats,
    },
    tests: collectedRuns.map((r) => ({
      testId: r.testId,
      testName: r.testName,
      tags: r.tags,
      success: r.success,
      durationMs: r.durationMs,
      events: r.events,
    })),
  };
  const resultJson = JSON.stringify(resultPayload, null, 2);

  try {
    const glubeanDir = resolve(rootDir, ".glubean");
    await Deno.mkdir(glubeanDir, { recursive: true });
    await Deno.writeTextFile(resolve(glubeanDir, "last-run.result.json"), resultJson);
  } catch {
    // Non-critical
  }

  if (options.resultJson) {
    const resultPath = typeof options.resultJson === "string"
      ? resolveOutputPath(options.resultJson, Deno.cwd())
      : isMultiFile
      ? resolve(Deno.cwd(), "glubean-run.result.json")
      : getLogFilePath(testFiles[0]).replace(/\.log$/, ".result.json");
    await Deno.mkdir(dirname(resultPath), { recursive: true });
    await Deno.writeTextFile(resultPath, resultJson);
    console.log(`${colors.dim}Result written to: ${resultPath}${colors.reset}`);
    console.log(
      `${colors.dim}Open ${colors.reset}${colors.cyan}https://glubean.com/viewer${colors.reset}${colors.dim} to visualize it${colors.reset}\n`,
    );
  }

  // ── JUnit XML output ───────────────────────────────────────────────────
  if (options.reporter === "junit") {
    const junitPath = options.reporterPath
      ? resolveOutputPath(options.reporterPath, Deno.cwd())
      : isMultiFile
      ? resolve(Deno.cwd(), "glubean-run.junit.xml")
      : getLogFilePath(testFiles[0]).replace(/\.log$/, ".junit.xml");
    const summaryData = {
      total: passed + failed + skipped,
      passed,
      failed,
      skipped,
      durationMs: totalDurationMs,
    };
    const xml = toJunitXml(collectedRuns, target, summaryData);
    await Deno.mkdir(dirname(junitPath), { recursive: true });
    await Deno.writeTextFile(junitPath, xml);
    console.log(
      `${colors.dim}JUnit XML written to: ${junitPath}${colors.reset}\n`,
    );
  }

  // ── Write .trace.jsonc files (human-readable HTTP request/response pairs) ──
  if (effectiveRun.emitFullTrace) {
    try {
      await writeTraceFiles(
        collectedRuns,
        rootDir,
        effectiveRun.envFile,
        options.traceLimit,
      );
    } catch {
      // Non-critical: silently skip if trace files cannot be written
    }
  }

  // ── Screenshot paths ──────────────────────────────────────────────────
  {
    const screenshotPaths: string[] = [];
    for (const run of collectedRuns) {
      for (const event of run.events) {
        if (event.type !== "event") continue;
        const ev = event.data as { type?: string; data?: Record<string, unknown> };
        if (ev.type === "browser:screenshot" && typeof ev.data?.path === "string") {
          screenshotPaths.push(resolve(rootDir, ev.data.path));
        }
      }
    }
    if (screenshotPaths.length > 0) {
      for (const p of screenshotPaths) {
        console.log(`${colors.dim}Screenshot: ${colors.reset}${p}`);
      }
      console.log();
    }
  }

  // ── Cloud upload ────────────────────────────────────────────────────────
  if (options.upload) {
    const { resolveToken, resolveProjectId, resolveApiUrl } = await import(
      "../lib/auth.ts"
    );
    const { uploadToCloud } = await import("../lib/upload.ts");

    const authOpts = {
      token: options.token,
      project: options.project,
      apiUrl: options.apiUrl,
    };
    const sources = {
      envFileVars: { ...envVars, ...secrets },
      cloudConfig: glubeanConfig.cloud,
    };
    const token = await resolveToken(authOpts, sources);
    const projectId = await resolveProjectId(authOpts, sources);
    const apiUrl = await resolveApiUrl(authOpts, sources);

    if (!token) {
      console.error(
        `${colors.red}Upload failed: no auth token found.${colors.reset}`,
      );
      console.error(
        `${colors.dim}Run 'glubean login', set GLUBEAN_TOKEN, or add token to .env.secrets or deno.json glubean.cloud.${colors.reset}`,
      );
      Deno.exit(1);
    } else if (!projectId) {
      console.error(
        `${colors.red}Upload failed: no project ID.${colors.reset}`,
      );
      console.error(
        `${colors.dim}Use --project, set projectId in deno.json glubean.cloud, or run 'glubean login'.${colors.reset}`,
      );
      Deno.exit(1);
    } else {
      // Apply redaction before uploading to Cloud
      const { RedactionEngine, createBuiltinPlugins, redactEvent } = await import("@glubean/redaction");
      const engine = new RedactionEngine({
        config: glubeanConfig.redaction,
        plugins: createBuiltinPlugins(glubeanConfig.redaction),
      });
      const redactedPayload = {
        ...resultPayload,
        tests: resultPayload.tests.map((t) => ({
          ...t,
          events: t.events.map((e) => redactEvent(engine, e)),
        })),
      };

      await uploadToCloud(redactedPayload, {
        apiUrl,
        token,
        projectId,
        envFile: effectiveRun.envFile,
        rootDir,
      });
    }
  }

  if (failed > 0) {
    Deno.exit(1);
  }
}

// ---------------------------------------------------------------------------
// JUnit XML generation
// ---------------------------------------------------------------------------

/** Escape special XML characters in text content and attributes. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Convert collected test runs into JUnit XML format.
 *
 * Produces a single `<testsuite>` element compatible with GitHub Actions,
 * GitLab CI, Jenkins, and other CI systems that consume JUnit XML.
 */
function toJunitXml(
  collectedRuns: CollectedTestRun[],
  target: string,
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
  },
): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${
      escapeXml(target)
    }" tests="${summary.total}" failures="${summary.failed}" skipped="${summary.skipped}" time="${
      (summary.durationMs / 1000).toFixed(3)
    }">`,
  ];

  for (const run of collectedRuns) {
    const classname = run.filePath ? escapeXml(relative(Deno.cwd(), run.filePath).replace(/\\/g, "/")) : "glubean";
    const name = escapeXml(run.testName);
    const time = (run.durationMs / 1000).toFixed(3);

    if (run.success) {
      lines.push(
        `  <testcase classname="${classname}" name="${name}" time="${time}" />`,
      );
    } else {
      // Extract error message from status event
      const statusEvent = run.events.find(
        (e) => e.type === "status" && "error" in e,
      ) as { type: "status"; error?: string } | undefined;

      // Collect failed assertions for detail
      const failedAssertions = run.events
        .filter(
          (e) =>
            e.type === "assertion" &&
            !("passed" in e && (e as { passed: boolean }).passed),
        )
        .map((e) => ("message" in e ? (e as { message: string }).message : ""))
        .filter(Boolean);

      const message = statusEvent?.error || failedAssertions[0] ||
        "Test failed";
      const detail = failedAssertions.length > 0 ? failedAssertions.join("\n") : message;

      lines.push(
        `  <testcase classname="${classname}" name="${name}" time="${time}">`,
      );
      lines.push(
        `    <failure message="${escapeXml(message)}">${escapeXml(detail)}</failure>`,
      );
      lines.push(`  </testcase>`);
    }
  }

  lines.push("</testsuite>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Trace file generation
// ---------------------------------------------------------------------------

/** Maximum number of trace files to keep per source file subdirectory. */
const TRACE_HISTORY_LIMIT = 20;

/** Zero-pad a number to 2 digits. */
function p2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Replace path-unsafe characters in test IDs used as file/directory names. */
function sanitizeForPath(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, "_");
}

/** Format a Date as a human-readable local time string. */
function localTimeString(d: Date): string {
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
}

/**
 * Write `.trace.jsonc` files — human-readable {request, response} pairs.
 *
 * Each test gets its own subdirectory under the file-level folder:
 * `.glubean/traces/{fileName}/{testId}/{timestamp}.trace.jsonc`
 *
 * This keeps per-test history clean for diffing and browsing.
 * Automatically cleans up old files beyond TRACE_HISTORY_LIMIT.
 */
async function writeTraceFiles(
  collectedRuns: CollectedTestRun[],
  rootDir: string,
  envFile?: string,
  traceLimit?: number,
): Promise<void> {
  const limit = traceLimit ?? TRACE_HISTORY_LIMIT;
  // Timestamp in local time (compact, second precision, sortable)
  const now = new Date();
  const ts = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
    `T${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const envLabel = envFile || ".env";

  for (const run of collectedRuns) {
    // Extract trace events and reshape into {request, response} pairs
    const pairs: Array<{
      request: {
        method: string;
        url: string;
        headers?: Record<string, string>;
        body?: unknown;
      };
      response: {
        status: number;
        statusText?: string;
        durationMs: number;
        headers?: Record<string, string>;
        body?: unknown;
      };
    }> = [];

    for (const event of run.events) {
      if (event.type !== "trace") continue;
      const d = event.data;
      pairs.push({
        request: {
          method: d.method,
          url: d.url,
          ...(d.requestHeaders && Object.keys(d.requestHeaders).length > 0 ? { headers: d.requestHeaders } : {}),
          ...(d.requestBody !== undefined ? { body: d.requestBody } : {}),
        },
        response: {
          status: d.status,
          durationMs: d.duration,
          ...(d.responseHeaders && Object.keys(d.responseHeaders).length > 0 ? { headers: d.responseHeaders } : {}),
          ...(d.responseBody !== undefined ? { body: d.responseBody } : {}),
        },
      });
    }

    if (pairs.length === 0) continue;

    // .glubean/traces/{fileName}/{dirId}/{filename}.trace.jsonc
    // For pick tests, dirId = groupId (template) and filename includes testId.
    // For other tests, dirId = testId and filename is just the timestamp.
    const fileName = basename(run.filePath).replace(/\.ts$/, "");
    const dirId = sanitizeForPath(run.groupId ?? run.testId);
    const tracesDir = resolve(
      rootDir,
      ".glubean",
      "traces",
      fileName,
      dirId,
    );
    await Deno.mkdir(tracesDir, { recursive: true });

    const traceName = (run.groupId && run.groupId !== run.testId) ? `${ts}--${sanitizeForPath(run.testId)}` : ts;
    const traceFilePath = resolve(tracesDir, `${traceName}.trace.jsonc`);

    // Build JSONC content with comment header
    const relFile = relative(rootDir, run.filePath);
    const header = [
      `// ${relFile} → ${run.testId} — ${pairs.length} HTTP call${pairs.length > 1 ? "s" : ""}`,
      `// Run at: ${localTimeString(now)}`,
      `// Environment: ${envLabel}`,
      "",
    ].join("\n");

    const content = header + JSON.stringify(pairs, null, 2) + "\n";
    await Deno.writeTextFile(traceFilePath, content);

    console.log(`${colors.dim}Trace: ${colors.reset}${traceFilePath}`);

    // Auto-cleanup: keep only the most recent N files
    await cleanupTraceDir(tracesDir, limit);
  }
}

/**
 * Remove old trace files from a directory, keeping only the most recent `limit`.
 */
async function cleanupTraceDir(dir: string, limit: number): Promise<void> {
  try {
    const entries: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".trace.jsonc")) {
        entries.push(entry.name);
      }
    }
    // Sort descending (newest first — filenames are timestamps)
    entries.sort().reverse();
    // Delete anything beyond the limit
    for (const name of entries.slice(limit)) {
      await Deno.remove(resolve(dir, name));
    }
  } catch {
    // Cleanup is best-effort
  }
}
