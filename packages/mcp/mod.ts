/**
 * Glubean MCP server (stdio).
 *
 * Purpose:
 * - Let AI agents (Cursor, etc.) run verification-as-code locally
 * - Fetch structured failures (assertions/logs/traces) for automatic fixing
 * - Optionally trigger/tail remote runs via Glubean Open Platform APIs
 *
 * IMPORTANT (stdio transport):
 * - Never write to stdout. Use stderr for logs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { basename, dirname, resolve, toFileUrl } from "@std/path";
import { parse } from "@std/dotenv/parse";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { LOCAL_RUN_DEFAULTS, TestExecutor, toSingleExecutionOptions } from "@glubean/runner";
import type { SharedRunConfig } from "@glubean/runner";
import { createStaticScanner, extractFromSource, scan } from "@glubean/scanner";
import type { BundleMetadata, ExportMeta, FileMeta, ScanResult } from "@glubean/scanner";
import { DEFAULT_GENERATED_BY, MCP_PACKAGE_VERSION } from "./version.ts";

type Vars = Record<string, string>;
const METADATA_SCHEMA_VERSION = "1";

export async function findProjectRoot(startDir: string): Promise<string> {
  let dir = startDir;
  while (true) {
    try {
      await Deno.stat(resolve(dir, "deno.json"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root reached
      dir = parent;
    }
  }
  return startDir;
}

export async function loadEnvFile(envPath: string): Promise<Vars> {
  try {
    const content = await Deno.readTextFile(envPath);
    return parse(content);
  } catch {
    return {};
  }
}

/**
 * Derive the secrets file path from an env file path.
 * Convention: `.env` → `.env.secrets`, `.env.staging` → `.env.staging.secrets`.
 * Mirrors the logic in `packages/cli/commands/run.ts`.
 */
export function deriveSecretsPath(envPath: string): string {
  return resolve(dirname(envPath), `${basename(envPath)}.secrets`);
}

function normalizeFilePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizeFileMap(
  files: Record<string, FileMeta>,
): Record<string, FileMeta> {
  const normalized: Record<string, FileMeta> = {};
  for (const [path, meta] of Object.entries(files)) {
    const normalizedPath = normalizeFilePath(path);
    if (normalized[normalizedPath]) {
      throw new Error(`Duplicate file path after normalization: ${path}`);
    }
    normalized[normalizedPath] = meta;
  }
  return normalized;
}

function deriveMetadataStats(files: Record<string, FileMeta>): {
  testCount: number;
  fileCount: number;
  tags: string[];
} {
  let testCount = 0;
  const allTags = new Set<string>();

  for (const fileMeta of Object.values(files)) {
    for (const exp of fileMeta.exports) {
      if (exp.tags) {
        exp.tags.forEach((tag) => allTags.add(tag));
      }
      testCount += 1;
    }
  }

  return {
    testCount,
    fileCount: Object.keys(files).length,
    tags: Array.from(allTags).sort(),
  };
}

async function computeRootHash(
  files: Record<string, FileMeta>,
): Promise<string> {
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  const payload = entries
    .map(([path, meta]) => `${path}:${meta.hash}`)
    .join("\n");
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return `sha256-${encodeHex(new Uint8Array(hash))}`;
}

async function buildMetadata(
  scanResult: ScanResult,
  options: { generatedBy: string; generatedAt?: string },
): Promise<BundleMetadata> {
  const normalizedFiles = normalizeFileMap(scanResult.files);
  const stats = deriveMetadataStats(normalizedFiles);
  const rootHash = await computeRootHash(normalizedFiles);

  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    specVersion: scanResult.specVersion,
    generatedBy: options.generatedBy,
    generatedAt: options.generatedAt || new Date().toISOString(),
    rootHash,
    files: normalizedFiles,
    testCount: stats.testCount,
    fileCount: stats.fileCount,
    tags: stats.tags,
    warnings: scanResult.warnings,
  };
}

export async function discoverTestsFromFile(filePath: string): Promise<{
  fileUrl: string;
  tests: ExportMeta[];
}> {
  const absolutePath = resolve(filePath);
  const fileUrl = toFileUrl(absolutePath).toString();
  const content = await Deno.readTextFile(absolutePath);
  const tests = extractFromSource(content);
  return { fileUrl, tests };
}

function resolveRootDir(dir?: string): string {
  return dir ? resolve(dir) : Deno.cwd();
}

async function scanProject(
  dir: string,
  mode: "runtime" | "static",
): Promise<ScanResult> {
  if (mode === "static") {
    const scanner = createStaticScanner();
    return await scanner.scan(dir);
  }
  return await scan(dir);
}

export interface LocalRunResult {
  exportName: string;
  id: string;
  name?: string;
  success: boolean;
  durationMs: number;
  assertions: Array<{
    passed: boolean;
    message: string;
    actual?: unknown;
    expected?: unknown;
  }>;
  logs: Array<{ message: string; data?: unknown }>;
  traces: Array<unknown>;
  error?: { message: string; stack?: string };
}

export interface LocalDebugEvent {
  type: "result" | "assertion" | "log" | "trace";
  testId: string;
  exportName: string;
  testName?: string;
  success?: boolean;
  durationMs?: number;
  message?: string;
  passed?: boolean;
  actual?: unknown;
  expected?: unknown;
  data?: unknown;
  error?: { message: string; stack?: string };
}

export interface LocalRunSnapshot {
  createdAt: string;
  fileUrl: string;
  projectRoot: string;
  summary: { total: number; passed: number; failed: number };
  results: LocalRunResult[];
  includeLogs: boolean;
  includeTraces: boolean;
  filter?: string;
}

export interface ConfigDiagnostics {
  projectRoot: string;
  denoJson: { path: string; exists: boolean };
  envFile: { path: string; exists: boolean; varCount: number; hasBaseUrl: boolean };
  secretsFile: { path: string; exists: boolean; secretCount: number };
  testsDir: { path: string; exists: boolean };
  exploreDir: { path: string; exists: boolean };
  recommendations: string[];
}

let lastLocalRunSnapshot: LocalRunSnapshot | undefined;

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export function toLocalDebugEvents(
  snapshot: LocalRunSnapshot,
): LocalDebugEvent[] {
  const events: LocalDebugEvent[] = [];
  for (const result of snapshot.results) {
    events.push({
      type: "result",
      testId: result.id,
      exportName: result.exportName,
      testName: result.name,
      success: result.success,
      durationMs: result.durationMs,
      error: result.error,
    });

    for (const assertion of result.assertions) {
      events.push({
        type: "assertion",
        testId: result.id,
        exportName: result.exportName,
        testName: result.name,
        passed: assertion.passed,
        message: assertion.message,
        actual: assertion.actual,
        expected: assertion.expected,
      });
    }

    for (const log of result.logs) {
      events.push({
        type: "log",
        testId: result.id,
        exportName: result.exportName,
        testName: result.name,
        message: log.message,
        data: log.data,
      });
    }

    for (const trace of result.traces) {
      events.push({
        type: "trace",
        testId: result.id,
        exportName: result.exportName,
        testName: result.name,
        data: trace,
      });
    }
  }
  return events;
}

export function filterLocalDebugEvents(
  events: LocalDebugEvent[],
  options: { type?: LocalDebugEvent["type"]; testId?: string; limit?: number },
): LocalDebugEvent[] {
  let filtered = events;
  if (options.type) {
    filtered = filtered.filter((event) => event.type === options.type);
  }
  if (options.testId) {
    filtered = filtered.filter((event) => event.testId === options.testId);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 200, 2000));
  return filtered.slice(0, limit);
}

export function buildLastRunSummary(
  snapshot: LocalRunSnapshot,
): Record<string, unknown> {
  return {
    createdAt: snapshot.createdAt,
    fileUrl: snapshot.fileUrl,
    projectRoot: snapshot.projectRoot,
    summary: snapshot.summary,
    includeLogs: snapshot.includeLogs,
    includeTraces: snapshot.includeTraces,
    filter: snapshot.filter,
    testIds: snapshot.results.map((r) => r.id),
    eventCounts: {
      result: snapshot.results.length,
      assertion: snapshot.results.reduce((acc, r) => acc + r.assertions.length, 0),
      log: snapshot.results.reduce((acc, r) => acc + r.logs.length, 0),
      trace: snapshot.results.reduce((acc, r) => acc + r.traces.length, 0),
    },
  };
}

export async function diagnoseProjectConfig(args: {
  dir?: string;
  envFile?: string;
}): Promise<ConfigDiagnostics> {
  const rootDir = resolveRootDir(args.dir);
  const projectRoot = await findProjectRoot(rootDir);
  const denoJsonPath = resolve(projectRoot, "deno.json");
  const envPath = args.envFile ? resolve(args.envFile) : resolve(projectRoot, ".env");
  const secretsPath = deriveSecretsPath(envPath);

  const [denoJsonExists, envExists, secretsExists, testsDirExists, exploreDirExists] = await Promise.all([
    pathExists(denoJsonPath),
    pathExists(envPath),
    pathExists(secretsPath),
    pathExists(resolve(projectRoot, "tests")),
    pathExists(resolve(projectRoot, "explore")),
  ]);

  const envVars = envExists ? await loadEnvFile(envPath) : {};
  const secrets = secretsExists ? await loadEnvFile(secretsPath) : {};

  const recommendations: string[] = [];
  if (!denoJsonExists) {
    recommendations.push('Missing "deno.json" at project root.');
  }
  if (!envExists) {
    recommendations.push('Missing ".env" file (expected BASE_URL).');
  } else if (!("BASE_URL" in envVars)) {
    recommendations.push('Add BASE_URL to ".env" for HTTP tests.');
  }
  if (!secretsExists) {
    recommendations.push('Missing ".env.secrets" file. Add it when tests require secrets.');
  }
  if (!testsDirExists && !exploreDirExists) {
    recommendations.push('Create "tests/" or "explore/" to add runnable test files.');
  }

  return {
    projectRoot,
    denoJson: { path: denoJsonPath, exists: denoJsonExists },
    envFile: {
      path: envPath,
      exists: envExists,
      varCount: Object.keys(envVars).length,
      hasBaseUrl: "BASE_URL" in envVars,
    },
    secretsFile: {
      path: secretsPath,
      exists: secretsExists,
      secretCount: Object.keys(secrets).length,
    },
    testsDir: {
      path: resolve(projectRoot, "tests"),
      exists: testsDirExists,
    },
    exploreDir: {
      path: resolve(projectRoot, "explore"),
      exists: exploreDirExists,
    },
    recommendations,
  };
}

export async function runLocalTestsFromFile(args: {
  filePath: string;
  filter?: string;
  envFile?: string;
  includeLogs?: boolean;
  includeTraces?: boolean;
  stopOnFailure?: boolean;
  concurrency?: number;
}): Promise<{
  fileUrl: string;
  projectRoot: string;
  vars: Vars;
  secrets: Vars;
  results: LocalRunResult[];
  summary: { total: number; passed: number; failed: number };
  error?: string;
}> {
  const absolutePath = resolve(args.filePath);
  const testDir = dirname(absolutePath);
  const projectRoot = await findProjectRoot(testDir);

  const envPath = args.envFile ? resolve(args.envFile) : resolve(projectRoot, ".env");
  const secretsPath = deriveSecretsPath(envPath);

  const [vars, secrets] = await Promise.all([
    loadEnvFile(envPath),
    loadEnvFile(secretsPath),
  ]);

  const { fileUrl, tests } = await discoverTestsFromFile(absolutePath);

  const hasOnly = tests.some((t) => t.only);
  const normalizedFilter = args.filter?.toLowerCase().trim();

  const selected = tests.filter((t) => {
    if (t.skip) return false;
    if (hasOnly && !t.only) return false;
    if (!normalizedFilter) return true;
    const haystack = [t.id, t.name ?? "", ...(t.tags ?? [])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedFilter);
  });

  if (selected.length === 0) {
    return {
      fileUrl,
      projectRoot,
      vars,
      secrets,
      results: [],
      summary: { total: 0, passed: 0, failed: 0 },
      error: tests.length === 0
        ? "No tests discovered in file. Check that exports use test() from @glubean/sdk."
        : `No tests matched filter "${args.filter}". Available: ${tests.map((t) => t.id).join(", ")}`,
    };
  }

  const shared: SharedRunConfig = {
    ...LOCAL_RUN_DEFAULTS,
    failFast: Boolean(args.stopOnFailure),
    concurrency: Math.max(1, args.concurrency ?? 1),
  };
  const denoJsonPath = resolve(projectRoot, "deno.json");
  const executor = TestExecutor.fromSharedConfig(shared, {
    configPath: denoJsonPath,
    cwd: projectRoot,
  });

  const concurrency = shared.concurrency;
  const stopOnFailure = shared.failFast;
  const includeLogs = args.includeLogs ?? true;
  const includeTraces = args.includeTraces ?? false;

  const results: LocalRunResult[] = [];
  let nextIndex = 0;
  let stop = false;

  const runNext = async (): Promise<void> => {
    while (!stop) {
      const index = nextIndex++;
      if (index >= selected.length) return;

      const test = selected[index];
      const start = Date.now();

      const logs: LocalRunResult["logs"] = [];
      const assertions: LocalRunResult["assertions"] = [];
      const traces: LocalRunResult["traces"] = [];

      let statusSuccess = false;
      let errorMessage: string | undefined;
      let errorStack: string | undefined;

      for await (
        const event of executor.run(fileUrl, test.id, {
          vars,
          secrets,
        }, { ...toSingleExecutionOptions(shared), exportName: test.exportName })
      ) {
        switch (event.type) {
          case "log":
            if (includeLogs) {
              logs.push({ message: event.message, data: event.data });
            }
            break;
          case "assertion":
            assertions.push({
              passed: event.passed,
              message: event.message,
              actual: event.actual,
              expected: event.expected,
            });
            break;
          case "trace":
            if (includeTraces) traces.push(event.data);
            break;
          case "status":
            statusSuccess = event.status === "completed";
            if (event.error) errorMessage = event.error;
            if (event.stack) errorStack = event.stack;
            break;
          case "error":
            errorMessage = event.message;
            break;
        }
      }

      const allAssertionsPassed = assertions.every((a) => a.passed);
      const success = statusSuccess && allAssertionsPassed && !errorMessage;

      const result: LocalRunResult = {
        exportName: test.exportName,
        id: test.id,
        name: test.name,
        success,
        durationMs: Date.now() - start,
        assertions,
        logs,
        traces,
        error: errorMessage ? { message: errorMessage, stack: errorStack } : undefined,
      };
      results.push(result);

      if (!success && stopOnFailure) {
        stop = true;
        return;
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, selected.length || 1) },
    () => runNext(),
  );
  await Promise.all(workers);

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    fileUrl,
    projectRoot,
    vars,
    secrets,
    results,
    summary: { total: results.length, passed, failed },
  };
}

function bearerHeaders(token?: string): HeadersInit {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 2000)}`,
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const server = new McpServer({
  name: "glubean",
  version: MCP_PACKAGE_VERSION,
});

export const MCP_TOOL_NAMES = {
  discoverTests: "glubean_discover_tests",
  runLocalFile: "glubean_run_local_file",
  getLastRunSummary: "glubean_get_last_run_summary",
  getLocalEvents: "glubean_get_local_events",
  listTestFiles: "glubean_list_test_files",
  diagnoseConfig: "glubean_diagnose_config",
  getMetadata: "glubean_get_metadata",
  openTriggerRun: "glubean_open_trigger_run",
  openGetRun: "glubean_open_get_run",
  openGetRunEvents: "glubean_open_get_run_events",
} as const;

server.registerTool(
  MCP_TOOL_NAMES.discoverTests,
  {
    description: "Discover Glubean test exports from a file path and return their metadata.",
    inputSchema: {
      filePath: z
        .string()
        .describe("Path to a test module file (e.g. tests/api.test.ts)"),
    },
  },
  async (input: { filePath: string }) => {
    const { filePath } = input;
    const { tests } = await discoverTestsFromFile(filePath);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ tests }, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.runLocalFile,
  {
    description: "Run Glubean test exports from a file locally and return structured results for AI debugging/fixing.",
    inputSchema: {
      filePath: z.string().describe("Path to a test module file"),
      filter: z
        .string()
        .optional()
        .describe("Filter by id/name/tag (substring match)"),
      envFile: z
        .string()
        .optional()
        .describe("Path to .env file (default: <projectRoot>/.env)"),
      includeLogs: z
        .boolean()
        .optional()
        .describe("Include ctx.log events (default: true)"),
      includeTraces: z
        .boolean()
        .optional()
        .describe("Include ctx.trace events (default: false)"),
      stopOnFailure: z
        .boolean()
        .optional()
        .describe("Stop after first failed test (default: false)"),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(16)
        .optional()
        .describe("Parallelism (default: 1)"),
    },
  },
  async (input: {
    filePath: string;
    filter?: string;
    envFile?: string;
    includeLogs?: boolean;
    includeTraces?: boolean;
    stopOnFailure?: boolean;
    concurrency?: number;
  }) => {
    const result = await runLocalTestsFromFile({
      filePath: input.filePath,
      filter: input.filter,
      envFile: input.envFile,
      includeLogs: input.includeLogs,
      includeTraces: input.includeTraces,
      stopOnFailure: input.stopOnFailure,
      concurrency: input.concurrency,
    });

    // Never return secrets. Return only counts so the agent can reason about config presence.
    const safe: Record<string, unknown> = {
      projectRoot: result.projectRoot,
      fileUrl: result.fileUrl,
      varsCount: Object.keys(result.vars).length,
      secretsCount: Object.keys(result.secrets).length,
      summary: result.summary,
      results: result.results,
    };
    if (result.error) {
      safe.error = result.error;
    }

    lastLocalRunSnapshot = {
      createdAt: new Date().toISOString(),
      fileUrl: result.fileUrl,
      projectRoot: result.projectRoot,
      summary: result.summary,
      results: result.results,
      includeLogs: input.includeLogs ?? true,
      includeTraces: input.includeTraces ?? false,
      filter: input.filter,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(safe, null, 2) }],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.getLastRunSummary,
  {
    description: "Return summary of the most recent glubean_run_local_file execution.",
    inputSchema: {},
  },
  () => {
    if (!lastLocalRunSnapshot) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            {
              error: "No local run snapshot available. Run glubean_run_local_file first.",
            },
            null,
            2,
          ),
        }],
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify(buildLastRunSummary(lastLocalRunSnapshot), null, 2),
      }],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.getLocalEvents,
  {
    description: "Return filtered local events from the most recent glubean_run_local_file execution.",
    inputSchema: {
      type: z
        .enum(["result", "assertion", "log", "trace"])
        .optional()
        .describe("Filter by local event type"),
      testId: z
        .string()
        .optional()
        .describe("Filter by discovered test id"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Maximum events returned (default: 200)"),
    },
  },
  (input: {
    type?: LocalDebugEvent["type"];
    testId?: string;
    limit?: number;
  }) => {
    if (!lastLocalRunSnapshot) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            {
              error: "No local run snapshot available. Run glubean_run_local_file first.",
            },
            null,
            2,
          ),
        }],
      };
    }

    const events = toLocalDebugEvents(lastLocalRunSnapshot);
    const filtered = filterLocalDebugEvents(events, {
      type: input.type,
      testId: input.testId,
      limit: input.limit,
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            availableTotal: events.length,
            returned: filtered.length,
            filters: {
              type: input.type,
              testId: input.testId,
              limit: input.limit ?? 200,
            },
            events: filtered,
          },
          null,
          2,
        ),
      }],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.listTestFiles,
  {
    description: "List Glubean test files in a directory (lightweight index, no file writes).",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe(
          "Project root directory (default: current working directory)",
        ),
      mode: z
        .enum(["static", "runtime"])
        .optional()
        .describe(
          'Scan mode: "static" (no runtime imports, default) or "runtime" (most accurate)',
        ),
    },
  },
  async (input: { dir?: string; mode?: "static" | "runtime" }) => {
    const rootDir = resolveRootDir(input.dir);
    const mode = input.mode ?? "static";
    const result = await scanProject(rootDir, mode);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              rootDir,
              mode,
              fileCount: result.fileCount,
              files: Object.keys(result.files).sort(),
              warnings: result.warnings,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.diagnoseConfig,
  {
    description: "Diagnose local project config (.env, .env.secrets, deno.json, tests/explore dirs).",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe("Project root directory (default: current working directory)"),
      envFile: z
        .string()
        .optional()
        .describe("Path to .env file (default: <projectRoot>/.env)"),
    },
  },
  async (input: { dir?: string; envFile?: string }) => {
    const diagnostics = await diagnoseProjectConfig(input);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(diagnostics, null, 2),
      }],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.getMetadata,
  {
    description: "Generate metadata (equivalent to metadata.json) in-memory for AI use, without writing to disk.",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe(
          "Project root directory (default: current working directory)",
        ),
      mode: z
        .enum(["runtime", "static"])
        .optional()
        .describe(
          'Scan mode: "runtime" (most accurate, default) or "static" (no runtime imports)',
        ),
      generatedBy: z
        .string()
        .optional()
        .describe(
          `Override generatedBy field (default: "${DEFAULT_GENERATED_BY}")`,
        ),
    },
  },
  async (input: {
    dir?: string;
    mode?: "runtime" | "static";
    generatedBy?: string;
  }) => {
    const rootDir = resolveRootDir(input.dir);
    const mode = input.mode ?? "runtime";
    const result = await scanProject(rootDir, mode);
    const metadata = await buildMetadata(result, {
      generatedBy: input.generatedBy ?? DEFAULT_GENERATED_BY,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              rootDir,
              mode,
              metadata,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.openTriggerRun,
  {
    description: "Trigger a remote run via Glubean Open Platform API (POST /open/v1/runs).",
    inputSchema: {
      apiUrl: z.string().describe("Base API URL, e.g. https://api.glubean.com"),
      token: z.string().describe("Project token with runs:write scope"),
      projectId: z.string().describe("Project ID (short id)"),
      bundleId: z.string().describe("Bundle ID (short id)"),
      jobId: z.string().optional().describe("Optional job ID"),
    },
  },
  async (input: {
    apiUrl: string;
    token: string;
    projectId: string;
    bundleId: string;
    jobId?: string;
  }) => {
    const { apiUrl, token, projectId, bundleId, jobId } = input;
    const url = `${apiUrl.replace(/\/$/, "")}/open/v1/runs`;
    const body = { projectId, bundleId, jobId };
    const json = await fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearerHeaders(token) },
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.openGetRun,
  {
    description: "Get run status via Glubean Open Platform API (GET /open/v1/runs/:runId).",
    inputSchema: {
      apiUrl: z.string().describe("Base API URL, e.g. https://api.glubean.com"),
      token: z.string().describe("Project token with runs:read scope"),
      runId: z.string().describe("Run ID"),
    },
  },
  async (input: { apiUrl: string; token: string; runId: string }) => {
    const { apiUrl, token, runId } = input;
    const url = `${apiUrl.replace(/\/$/, "")}/open/v1/runs/${
      encodeURIComponent(
        runId,
      )
    }`;
    const json = await fetchJson(url, {
      method: "GET",
      headers: bearerHeaders(token),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.openGetRunEvents,
  {
    description: "Fetch a page of run events via Glubean Open Platform API (GET /open/v1/runs/:runId/events).",
    inputSchema: {
      apiUrl: z.string().describe("Base API URL, e.g. https://api.glubean.com"),
      token: z.string().describe("Project token with runs:read scope"),
      runId: z.string().describe("Run ID"),
      afterSeq: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Cursor: return events after this seq"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Max events (default server: 100)"),
      type: z
        .string()
        .optional()
        .describe("Filter by event type (log/assert/trace/result)"),
    },
  },
  async (input: {
    apiUrl: string;
    token: string;
    runId: string;
    afterSeq?: number;
    limit?: number;
    type?: string;
  }) => {
    const { apiUrl, token, runId, afterSeq, limit, type } = input;
    const base = `${
      apiUrl.replace(
        /\/$/,
        "",
      )
    }/open/v1/runs/${encodeURIComponent(runId)}/events`;
    const params = new URLSearchParams();
    if (afterSeq !== undefined) params.set("afterSeq", String(afterSeq));
    if (limit !== undefined) params.set("limit", String(limit));
    if (type) params.set("type", type);
    const url = params.size ? `${base}?${params.toString()}` : base;

    const json = await fetchJson(url, {
      method: "GET",
      headers: bearerHeaders(token),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("glubean MCP server running (stdio)");
}

if (import.meta.main) {
  await main();
}
