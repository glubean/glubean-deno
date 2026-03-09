/**
 * Harness script - runs INSIDE the Deno sandbox.
 * This is the bridge between the Runner and User Code.
 *
 * Usage:
 *   deno run --allow-net harness.ts --testUrl=<url> --testId=<id> --context=<json>
 */

import { parseArgs } from "@std/cli/parse-args";
import ky from "ky";
import {
  classifyHostnameBlockReason,
  classifyIpBlockReason,
  isAllowedPort,
  isAllowedProtocol,
  isIpLiteral,
  resolveUrlPort,
} from "./network_policy.ts";
import { applyResponseByteBudget } from "./network_budget.ts";
import type {
  ApiTrace,
  AssertionDetails,
  AssertionResultInput,
  GlubeanAction,
  GlubeanEvent,
  HttpClient as _HttpClient,
  HttpSchemaOptions,
  MetricOptions,
  PollUntilOptions,
  SchemaEntry,
  SchemaIssue,
  SchemaLike,
  Test,
  TestContext,
  ValidateOptions,
} from "@glubean/sdk";
import { Expectation } from "@glubean/sdk/expect";

// Global error handlers for async errors that escape try/catch
globalThis.addEventListener("error", (event) => {
  console.log(
    JSON.stringify({
      type: "status",
      status: "failed",
      error: event.error?.message || event.message || "Unknown error",
      stack: event.error?.stack,
    }),
  );
  Deno.exit(1);
});

globalThis.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  console.log(
    JSON.stringify({
      type: "status",
      status: "failed",
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    }),
  );
  Deno.exit(1);
});

// Parse CLI arguments
const args = parseArgs(Deno.args, {
  string: ["testUrl", "testId", "testIds", "exportName"],
  boolean: ["emitFullTrace"],
});

/** When true, auto-trace includes request/response headers and bodies. */
const emitFullTrace = args.emitFullTrace ?? false;

const testUrl = args.testUrl;
const testId = args.testId;
/**
 * Comma-separated list of test IDs for file-level batch mode.
 * When set, all tests run sequentially in a single process, preserving
 * module-level state (e.g. shared `let` variables between tests).
 */
const testIds = args.testIds ? args.testIds.split(",") : undefined;
/** Optional export name for fallback lookup (used by test.pick/test.each). */
const exportName = args.exportName;
/** Optional testId→exportName mapping for batch mode fallback (test.pick). */
const exportNamesMap: Record<string, string> = {};
if (args.exportNames) {
  for (const pair of (args.exportNames as string).split(",")) {
    const sep = pair.indexOf(":");
    if (sep > 0) {
      exportNamesMap[pair.slice(0, sep)] = pair.slice(sep + 1);
    }
  }
}

if (!testUrl || (!testId && !testIds)) {
  console.log(
    JSON.stringify({
      type: "error",
      message: "Missing required arguments: --testUrl and (--testId or --testIds)",
    }),
  );
  Deno.exit(1);
}

/**
 * Read context data from stdin.
 * Context is passed via stdin instead of CLI args to avoid length limits and security issues.
 *
 * @returns The context JSON string from stdin
 */
async function readContextFromStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = Deno.stdin.readable.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Efficiently concatenate chunks
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(combined);
}

// Parse context data from stdin
const contextJson = await readContextFromStdin();
const contextData = contextJson ? JSON.parse(contextJson) : {};
const rawVars = (contextData.vars ?? {}) as Record<string, string>;
const rawSecrets = (contextData.secrets ?? {}) as Record<string, string>;
// Execution-level retry metadata injected by executor/control plane.
// 0 => first execution attempt.
const retryCount = (contextData.retryCount ?? 0) as number;

function normalizeTestTags(
  input: string | string[] | undefined,
): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter((tag): tag is string => typeof tag === "string");
  return [input];
}

function parseRuntimeTestMetadata(
  input: unknown,
): { id: string; tags: string[] } {
  const candidate = input && typeof input === "object" ? (input as { id?: unknown; tags?: unknown }) : undefined;
  const id = typeof candidate?.id === "string" ? candidate.id : (testId ?? "");
  const tags = Array.isArray(candidate?.tags)
    ? candidate.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return { id, tags };
}

const runtimeTest = parseRuntimeTestMetadata(contextData.test);

interface SharedServerlessNetworkPolicy {
  mode: "shared_serverless";
  maxRequests: number;
  maxConcurrentRequests: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  allowedPorts: number[];
}

function parseNetworkPolicy(
  input: unknown,
): SharedServerlessNetworkPolicy | undefined {
  if (!input || typeof input !== "object") return undefined;
  const candidate = input as Record<string, unknown>;
  if (candidate.mode !== "shared_serverless") return undefined;

  const allowedPorts = Array.isArray(candidate.allowedPorts)
    ? candidate.allowedPorts.filter((p): p is number =>
      typeof p === "number" && Number.isFinite(p) && p > 0 && p <= 65535
    ).map((p) => Math.floor(p))
    : [];

  return {
    mode: "shared_serverless",
    maxRequests: Number(candidate.maxRequests) > 0 ? Math.floor(Number(candidate.maxRequests)) : 300,
    maxConcurrentRequests: Number(candidate.maxConcurrentRequests) > 0
      ? Math.floor(Number(candidate.maxConcurrentRequests))
      : 20,
    requestTimeoutMs: Number(candidate.requestTimeoutMs) > 0 ? Math.floor(Number(candidate.requestTimeoutMs)) : 30_000,
    maxResponseBytes: Number(candidate.maxResponseBytes) > 0
      ? Math.floor(Number(candidate.maxResponseBytes))
      : 20 * 1024 * 1024,
    allowedPorts: allowedPorts.length > 0 ? Array.from(new Set(allowedPorts)) : [80, 443, 8080, 8443],
  };
}

const networkPolicy = parseNetworkPolicy(contextData.networkPolicy);

// Memory monitoring state
let peakMemoryBytes = 0;
let memoryCheckInterval: number | undefined;

// Step-level assertion tracking.
// Reset before each step, incremented by ctx.assert on failure.
let stepFailedAssertions = 0;
let stepAssertionTotal = 0;

// Current step index (null when not inside a step).
// Used to tag log/assertion/trace/metric events with their containing step.
let currentStepIndex: number | null = null;

// Test-level assertion and step counters.
// Accumulated across the entire test execution for the summary event.
let totalAssertions = 0;
let totalFailedAssertions = 0;
let totalSteps = 0;
let passedSteps = 0;
let failedSteps = 0;
let skippedSteps = 0;

// Warning counters — tracked separately from assertions.
// Warnings never affect test pass/fail status.
let warningTotal = 0;
let warningTriggered = 0;

// Schema validation counters.
let schemaValidationTotal = 0;
let schemaValidationFailed = 0;
let schemaValidationWarnings = 0;

/**
 * Start monitoring memory usage.
 * Samples memory every 100ms and tracks peak usage.
 */
function startMemoryMonitoring(): void {
  if (typeof Deno !== "undefined" && Deno.memoryUsage) {
    // Get initial memory
    const initial = Deno.memoryUsage();
    peakMemoryBytes = initial.heapUsed;

    // Sample every 100ms
    memoryCheckInterval = setInterval(() => {
      try {
        const mem = Deno.memoryUsage();
        peakMemoryBytes = Math.max(peakMemoryBytes, mem.heapUsed);
      } catch {
        // Ignore errors during monitoring
      }
    }, 100);
  }
}

/**
 * Stop memory monitoring and return peak usage.
 */
function stopMemoryMonitoring(): number {
  if (memoryCheckInterval !== undefined) {
    clearInterval(memoryCheckInterval);
    memoryCheckInterval = undefined;
  }
  return peakMemoryBytes;
}

/**
 * Custom error class for test skip.
 * When thrown, the test will be marked as skipped instead of failed.
 */
class SkipError extends Error {
  constructor(public readonly reason?: string) {
    super(reason ? `Test skipped: ${reason}` : "Test skipped");
    this.name = "SkipError";
  }
}

/**
 * Sentinel error thrown by ctx.fail().
 * Immediately aborts test execution, emitting a failed assertion before throwing.
 */
class FailError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "FailError";
  }
}

/**
 * Sentinel error used for step-level timeout failures.
 * Timeouts are treated as terminal for the step and do not retry.
 */
class StepTimeoutError extends Error {
  constructor(stepName: string, timeoutMs: number) {
    super(`Step "${stepName}" timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
}

/**
 * Helper to run validator and get error message.
 *
 * @param result Validator result (true/false/string/void/null)
 * @param key The variable or secret key being validated
 * @param type Whether this is a "var" or "secret"
 */
function runValidator(
  result: boolean | string | void | null,
  key: string,
  type: "var" | "secret",
): void {
  // true, undefined, null = valid
  if (result === true || result === undefined || result === null) {
    return;
  }
  // string = custom error message
  if (typeof result === "string") {
    throw new Error(`Invalid ${type} "${key}": ${result}`);
  }
  // false = generic error
  throw new Error(`Invalid ${type} "${key}": validation failed`);
}

// ---------------------------------------------------------------------------
// Schema validation helper
// ---------------------------------------------------------------------------

/**
 * Resolve a SchemaEntry to { schema, severity }.
 */
function resolveSchemaEntry<T>(entry: SchemaEntry<T>): {
  schema: SchemaLike<T>;
  severity: "error" | "warn" | "fatal";
} {
  if ("schema" in entry && entry.schema != null) {
    // deno-lint-ignore no-explicit-any
    const obj = entry as { schema: SchemaLike<T>; severity?: any };
    return { schema: obj.schema, severity: obj.severity ?? "error" };
  }
  return { schema: entry as SchemaLike<T>, severity: "error" };
}

/**
 * Core schema validation logic used by both ctx.validate and HTTP hooks.
 *
 * Runs safeParse (preferred) or parse (fallback), emits schema_validation event,
 * updates counters, and routes failures based on severity.
 *
 * Returns { success, data?, issues? }.
 */
function runSchemaValidation<T>(
  data: unknown,
  schema: SchemaLike<T>,
  label: string,
  severity: "error" | "warn" | "fatal",
): { success: true; data: T } | { success: false; issues: SchemaIssue[] } {
  schemaValidationTotal++;

  let success = false;
  let parsed: T | undefined;
  let issues: SchemaIssue[] = [];

  if (typeof schema.safeParse === "function") {
    const result = schema.safeParse(data);
    if (result.success) {
      success = true;
      parsed = result.data;
    } else {
      issues = (result.error?.issues ?? []).map((i) => ({
        message: i.message,
        ...(i.path && { path: i.path }),
      }));
    }
  } else if (typeof schema.parse === "function") {
    try {
      parsed = schema.parse(data);
      success = true;
    } catch (err: unknown) {
      // Try to extract structured issues from the error
      // deno-lint-ignore no-explicit-any
      const errAny = err as any;
      if (errAny?.issues && Array.isArray(errAny.issues)) {
        issues = errAny.issues.map(
          (i: { message?: string; path?: Array<string | number> }) => ({
            message: i.message ?? String(i),
            ...(i.path && { path: i.path }),
          }),
        );
      } else {
        issues = [
          {
            message: err instanceof Error ? err.message : String(err),
          },
        ];
      }
    }
  } else {
    issues = [{ message: "Schema has neither safeParse nor parse method" }];
  }

  // Emit schema_validation event (always, regardless of success/severity)
  console.log(
    JSON.stringify({
      type: "schema_validation",
      label,
      success,
      severity,
      ...(issues.length > 0 && { issues }),
      ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
    }),
  );

  if (!success) {
    const issuesSummary = issues
      .map((i) => {
        const path = i.path ? i.path.join(".") + ": " : "";
        return path + i.message;
      })
      .join("; ");
    const msg = `Schema validation failed: ${label} — ${issuesSummary}`;

    switch (severity) {
      case "error":
        schemaValidationFailed++;
        // Route through assertion pipeline so it counts as a failed assertion
        ctx.assert(false, msg);
        break;
      case "warn":
        schemaValidationWarnings++;
        ctx.warn(false, msg);
        break;
      case "fatal":
        schemaValidationFailed++;
        // Emit failed assertion, then throw to abort
        ctx.assert(false, msg);
        throw new FailError(msg);
    }

    return { success: false, issues };
  }

  return { success: true, data: parsed as T };
}

// Helper: resolve a value from explicit context, falling back to system env.
// Priority: .env/.env.secrets (rawVars/rawSecrets) > system environment variable
function resolveValue(
  explicit: Record<string, string>,
  key: string,
): string | undefined {
  const value = explicit[key];
  if (value !== undefined && value !== null && value !== "") return value;
  // Fallback to system environment (e.g., CI-injected vars)
  return Deno.env.get(key) || undefined;
}

// Construct TestContext with streaming output
// (http field is attached after ky instance creation below)
const ctx = {
  vars: {
    get: (key: string) => resolveValue(rawVars, key),
    require: (
      key: string,
      validate?: (value: string) => boolean | string | void | null,
    ) => {
      const value = resolveValue(rawVars, key);
      if (value === undefined || value === null || value === "") {
        throw new Error(`Missing required var: ${key}`);
      }
      if (validate) {
        runValidator(validate(value), key, "var");
      }
      return value;
    },
    all: () => ({ ...rawVars }),
  },
  secrets: {
    get: (key: string) => resolveValue(rawSecrets, key),
    require: (
      key: string,
      validate?: (value: string) => boolean | string | void | null,
    ) => {
      const value = resolveValue(rawSecrets, key);
      if (value === undefined || value === null || value === "") {
        throw new Error(`Missing required secret: ${key}`);
      }
      if (validate) {
        runValidator(validate(value), key, "secret");
      }
      return value;
    },
  },

  // Logging function
  log: (message: string, data?: unknown) => {
    console.log(
      JSON.stringify({
        type: "log",
        message,
        data,
        ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
      }),
    );
  },

  // Assertion function with overloads
  // Overload 1: assert(condition: boolean, message?: string, details?: AssertionDetails)
  // Overload 2: assert(result: AssertionResultInput, message?: string)
  assert: (
    arg1: boolean | AssertionResultInput,
    arg2?: string | AssertionDetails,
    arg3?: AssertionDetails,
  ) => {
    let passed: boolean;
    let message: string;
    let actual: unknown;
    let expected: unknown;

    if (typeof arg1 === "boolean") {
      // Overload 1: assert(condition, message?, details?)
      passed = arg1;
      message = (typeof arg2 === "string" ? arg2 : undefined) ||
        (passed ? "Assertion passed" : "Assertion failed");
      const details = typeof arg2 === "object" ? arg2 : arg3;
      if (details) {
        actual = details.actual;
        expected = details.expected;
      }
    } else {
      // Overload 2: assert(result, message?)
      passed = arg1.passed;
      actual = arg1.actual;
      expected = arg1.expected;
      message = (typeof arg2 === "string" ? arg2 : undefined) ||
        (passed ? "Assertion passed" : "Assertion failed");
    }

    // Track per-step and test-level assertion stats
    stepAssertionTotal++;
    totalAssertions++;
    if (!passed) {
      stepFailedAssertions++;
      totalFailedAssertions++;
    }

    console.log(
      JSON.stringify({
        type: "assertion",
        passed,
        message,
        actual,
        expected,
        ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
      }),
    );
  },

  // Fluent assertion API (Jest-style, soft-by-default)
  expect: <V>(actual: V): Expectation<V> => {
    return new Expectation(actual, (result) => {
      // Route through the existing assertion pipeline
      ctx.assert(
        {
          passed: result.passed,
          actual: result.actual,
          expected: result.expected,
        },
        result.message,
      );
    });
  },

  // Warning function — soft check, never affects test pass/fail.
  // condition=true means OK; condition=false triggers warning.
  warn: (condition: boolean, message: string) => {
    warningTotal++;
    if (!condition) {
      warningTriggered++;
    }
    console.log(
      JSON.stringify({
        type: "warning",
        condition,
        message,
        ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
      }),
    );
  },

  // Schema validation function
  validate: <T>(
    data: unknown,
    schema: SchemaLike<T>,
    label?: string,
    options?: ValidateOptions,
  ): T | undefined => {
    const result = runSchemaValidation(
      data,
      schema,
      label ?? "data",
      options?.severity ?? "error",
    );
    return result.success ? result.data : undefined;
  },

  // API tracing function
  trace: (request: ApiTrace) => {
    console.log(
      JSON.stringify({
        type: "trace",
        data: request,
        ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
      }),
    );
    // Backward compat: also emit as a typed action for timeline/filtering
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      pathname = request.url;
    }
    ctx.action({
      category: "http:request",
      target: `${request.method} ${pathname}`,
      duration: request.duration,
      status: request.status >= 400 ? "error" : "ok",
      detail: { method: request.method, url: request.url, httpStatus: request.status },
    });
  },

  // Action recording function
  action: (a: GlubeanAction) => {
    console.log(
      JSON.stringify({
        type: "action",
        data: a,
        ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
      }),
    );
  },

  // Structured event emission
  event: (ev: GlubeanEvent) => {
    console.log(
      JSON.stringify({
        type: "event",
        data: ev,
        ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
      }),
    );
  },

  // Metric reporting function
  metric: (name: string, value: number, options?: MetricOptions) => {
    console.log(
      JSON.stringify({
        type: "metric",
        name,
        value,
        unit: options?.unit,
        tags: options?.tags,
        ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
      }),
    );
  },

  /**
   * Skip the current test with an optional reason.
   * Throws a SkipError that will be caught and handled by the harness.
   *
   * @param reason Optional reason for skipping
   */
  skip: (reason?: string): never => {
    throw new SkipError(reason);
  },

  /**
   * Immediately fail and abort the current test.
   * Emits a failed assertion event, then throws to stop execution.
   */
  fail: (message: string): never => {
    // Emit a failed assertion so the failure reason appears in events
    console.log(
      JSON.stringify({
        type: "assertion",
        passed: false,
        message,
      }),
    );
    throw new FailError(message);
  },

  /**
   * Poll a function until it returns truthy or times out.
   */
  pollUntil: async (
    options: PollUntilOptions,
    fn: () => Promise<boolean | unknown>,
  ): Promise<void> => {
    const { timeoutMs, intervalMs = 1000, onTimeout } = options;
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | undefined;

    while (Date.now() < deadline) {
      try {
        const result = await fn();
        if (result) return; // truthy → done
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      // Wait before next attempt, but don't overshoot the deadline
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
    }

    // Timed out
    if (onTimeout) {
      onTimeout(lastError);
      return;
    }

    const suffix = lastError ? `: ${lastError.message}` : "";
    throw new Error(`pollUntil timed out after ${timeoutMs}ms${suffix}`);
  },

  /**
   * Set a custom timeout for the current test.
   * Note: This sends a timeout_update event to the runner.
   * The runner is responsible for enforcing the timeout.
   *
   * @param ms Timeout in milliseconds
   */
  setTimeout: (ms: number) => {
    console.log(
      JSON.stringify({
        type: "timeout_update",
        timeout: ms,
      }),
    );
  },

  /**
   * Current execution retry count (0 for first attempt).
   * This reflects whole-test re-runs, not per-step retries.
   */
  retryCount,

  /**
   * Get current memory usage.
   * Only available in Deno runtime (returns null in other environments).
   * Useful for debugging memory issues locally.
   *
   * @returns Memory usage stats or null if not available
   *
   * @example
   * const mem = ctx.getMemoryUsage();
   * if (mem) {
   *   ctx.log(`Heap used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
   * }
   */
  getMemoryUsage: () => {
    if (typeof Deno !== "undefined" && Deno.memoryUsage) {
      return Deno.memoryUsage();
    }
    return null;
  },
} as TestContext;

// ---------------------------------------------------------------------------
// Auto-tracing HTTP client (ctx.http) — powered by ky
// ---------------------------------------------------------------------------
// Track request start time. We use a simple variable instead of a WeakMap
// because ky may clone/recreate the Request object between beforeRequest and
// afterResponse hooks, breaking reference equality in a WeakMap.
let lastRequestStartTime = 0;
let httpRequestTotal = 0;
let httpErrorTotal = 0;

// Captured in beforeRequest when emitFullTrace is on
// deno-lint-ignore no-explicit-any
let lastRequestBody: any = undefined;

/** Max serialized body size (chars) to include in trace events. */
const TRACE_BODY_MAX_SIZE = 1_048_576; // 1MB

/**
 * Truncate a response body if its JSON representation exceeds the size limit.
 * Preserves structure: arrays are sliced and a count annotation is appended
 * so the trace file stays valid JSON and diffable.
 */
// deno-lint-ignore no-explicit-any
function truncateBody(body: any): any {
  try {
    const json = JSON.stringify(body);
    if (json.length <= TRACE_BODY_MAX_SIZE) return body;

    if (typeof body === "object" && body !== null) {
      // For arrays, keep first few items + count
      if (Array.isArray(body)) {
        const preview = body.slice(0, 3);
        return [...preview, `(${body.length - 3} more items truncated)`];
      }
      // For objects with large array values, truncate those arrays
      const pruned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (Array.isArray(value) && value.length > 3) {
          pruned[key] = [
            ...value.slice(0, 3),
            `(${value.length - 3} more items truncated)`,
          ];
        } else {
          pruned[key] = value;
        }
      }
      const rechecked = JSON.stringify(pruned);
      if (rechecked.length <= TRACE_BODY_MAX_SIZE * 1.5) return pruned;
    }

    return { _truncated: true, _sizeBytes: json.length };
  } catch {
    return "(non-serializable)";
  }
}

let summaryEmitted = false;

/**
 * Emit summary event with HTTP, assertion, and step totals.
 * Called once before the final status event. Idempotent.
 */
/**
 * Reset per-test counters for file-level batch mode.
 * Called before each test when running multiple tests in a single process.
 */
function resetTestCounters() {
  stepFailedAssertions = 0;
  stepAssertionTotal = 0;
  currentStepIndex = null;
  totalAssertions = 0;
  totalFailedAssertions = 0;
  totalSteps = 0;
  passedSteps = 0;
  failedSteps = 0;
  skippedSteps = 0;
  warningTotal = 0;
  warningTriggered = 0;
  schemaValidationTotal = 0;
  schemaValidationFailed = 0;
  schemaValidationWarnings = 0;
  httpRequestTotal = 0;
  httpErrorTotal = 0;
  summaryEmitted = false;
  peakMemoryBytes = 0;
}

function emitSummary() {
  if (summaryEmitted) return;
  summaryEmitted = true;
  console.log(
    JSON.stringify({
      type: "summary",
      data: {
        // HTTP stats (always present, 0 when no HTTP calls)
        httpRequestTotal,
        httpErrorTotal,
        httpErrorRate: httpRequestTotal > 0 ? Math.round((httpErrorTotal / httpRequestTotal) * 10000) / 10000 : 0,
        // Assertion stats
        assertionTotal: totalAssertions,
        assertionFailed: totalFailedAssertions,
        // Warning stats
        warningTotal,
        warningTriggered,
        // Schema validation stats
        schemaValidationTotal,
        schemaValidationFailed,
        schemaValidationWarnings,
        // Step stats (0 for simple tests without builder steps)
        stepTotal: totalSteps,
        stepPassed: passedSteps,
        stepFailed: failedSteps,
        stepSkipped: skippedSteps,
      },
    }),
  );
}

const MAX_NETWORK_WARNINGS_PER_CODE = 3;
const networkWarningCounts = new Map<string, number>();
let networkRequestCount = 0;
let networkInFlightCount = 0;
let networkResponseBytes = 0;

function emitNetworkWarning(code: string, message: string): void {
  const nextCount = (networkWarningCounts.get(code) ?? 0) + 1;
  networkWarningCounts.set(code, nextCount);
  if (nextCount <= MAX_NETWORK_WARNINGS_PER_CODE) {
    ctx.warn(false, `[network_guard:${code}] ${message}`);
  } else if (nextCount === MAX_NETWORK_WARNINGS_PER_CODE + 1) {
    ctx.warn(false, `[network_guard:${code}] further warnings suppressed`);
  }
}

async function resolveHostIps(hostname: string): Promise<string[]> {
  const ips = new Set<string>();
  try {
    const aRecords = await Deno.resolveDns(hostname, "A");
    for (const ip of aRecords) ips.add(ip);
  } catch {
    // Ignore; try AAAA next.
  }
  try {
    const aaaaRecords = await Deno.resolveDns(hostname, "AAAA");
    for (const ip of aaaaRecords) ips.add(ip);
  } catch {
    // Ignore; caller decides behavior when no records are resolved.
  }
  return Array.from(ips);
}

function toRequestUrl(input: Request | URL | string): URL {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input);
}

async function enforceNetworkPolicy(url: URL): Promise<void> {
  if (!networkPolicy) return;

  if (!isAllowedProtocol(url.protocol)) {
    emitNetworkWarning(
      "protocol_blocked",
      `Blocked protocol ${url.protocol} for ${url.href}`,
    );
    throw new Error(
      `Network policy blocked protocol ${url.protocol}. Only http/https are allowed.`,
    );
  }

  const port = resolveUrlPort(url);
  if (!isAllowedPort(port, networkPolicy.allowedPorts)) {
    emitNetworkWarning(
      "port_blocked",
      `Blocked port ${port} for ${url.href}`,
    );
    throw new Error(
      `Network policy blocked destination port ${port}.`,
    );
  }

  const hostname = url.hostname.toLowerCase();
  const hostnameReason = classifyHostnameBlockReason(hostname);
  if (hostnameReason) {
    emitNetworkWarning(
      hostnameReason,
      `Blocked hostname ${hostname} for ${url.href}`,
    );
    throw new Error(
      `Network policy blocked sensitive hostname ${hostname}.`,
    );
  }

  if (isIpLiteral(hostname)) {
    const ipReason = classifyIpBlockReason(hostname);
    if (ipReason) {
      emitNetworkWarning(
        ipReason,
        `Blocked destination IP ${hostname} for ${url.href}`,
      );
      throw new Error(`Network policy blocked destination IP ${hostname}.`);
    }
    return;
  }

  const resolvedIps = await resolveHostIps(hostname);
  if (resolvedIps.length === 0) {
    emitNetworkWarning(
      "dns_resolution_failed",
      `Could not resolve ${hostname} for ${url.href}`,
    );
    throw new Error(
      `Network policy could not resolve host ${hostname}. Request denied.`,
    );
  }

  for (const ip of resolvedIps) {
    const ipReason = classifyIpBlockReason(ip);
    if (ipReason) {
      emitNetworkWarning(
        ipReason,
        `Blocked resolved IP ${ip} (${hostname}) for ${url.href}`,
      );
      throw new Error(
        `Network policy blocked resolved destination ${ip} for host ${hostname}.`,
      );
    }
  }
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  if (!networkPolicy) {
    return originalFetch(input, init);
  }

  const requestUrl = toRequestUrl(input);

  if (networkRequestCount >= networkPolicy.maxRequests) {
    emitNetworkWarning(
      "request_limit_exceeded",
      `Request limit exceeded (${networkPolicy.maxRequests})`,
    );
    throw new Error(
      `Network policy exceeded max outbound requests (${networkPolicy.maxRequests}).`,
    );
  }
  if (networkInFlightCount >= networkPolicy.maxConcurrentRequests) {
    emitNetworkWarning(
      "concurrency_limit_exceeded",
      `In-flight request limit exceeded (${networkPolicy.maxConcurrentRequests})`,
    );
    throw new Error(
      `Network policy exceeded max concurrent outbound requests (${networkPolicy.maxConcurrentRequests}).`,
    );
  }

  // Reserve counters before await to avoid TOCTOU races when user code issues
  // concurrent requests in a single Promise.all frame.
  networkRequestCount++;
  networkInFlightCount++;

  const timeoutController = new AbortController();
  let timedOutByPolicy = false;
  const parentSignal = (() => {
    if (!init || typeof init !== "object" || !("signal" in init)) {
      return undefined;
    }
    const candidate = (init as { signal?: unknown }).signal;
    return candidate instanceof AbortSignal ? candidate : undefined;
  })();
  const onParentAbort = () => timeoutController.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) {
      timeoutController.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    timedOutByPolicy = true;
    timeoutController.abort(
      new Error(
        `Network request timed out after ${networkPolicy.requestTimeoutMs}ms`,
      ),
    );
  }, networkPolicy.requestTimeoutMs);

  try {
    await enforceNetworkPolicy(requestUrl);

    const response = await originalFetch(input, {
      ...init,
      signal: timeoutController.signal,
    });
    return applyResponseByteBudget(response, {
      requestUrl,
      maxResponseBytes: networkPolicy.maxResponseBytes,
      getUsedResponseBytes: () => networkResponseBytes,
      addUsedResponseBytes: (delta) => {
        networkResponseBytes += delta;
      },
      emitWarning: emitNetworkWarning,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (timedOutByPolicy) {
        throw new Error(
          `Network request timed out after ${networkPolicy.requestTimeoutMs}ms`,
        );
      }
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (parentSignal) {
      parentSignal.removeEventListener("abort", onParentAbort);
    }
    networkInFlightCount = Math.max(0, networkInFlightCount - 1);
  }
};

const kyInstance = ky.create({
  throwHttpErrors: false,
  hooks: {
    beforeRequest: [
      // deno-lint-ignore no-explicit-any
      (_request: Request, options: any) => {
        lastRequestStartTime = performance.now();
        if (emitFullTrace) {
          // Capture request body from ky options before the request is sent
          lastRequestBody = options.json ?? options.body ?? undefined;
        }
      },
    ],
    afterResponse: [
      // deno-lint-ignore no-explicit-any
      async (request: Request, _options: any, response: Response) => {
        const duration = Math.round(performance.now() - lastRequestStartTime);

        // Increment HTTP counters for summary
        httpRequestTotal++;
        if (response.status >= 400) {
          httpErrorTotal++;
        }

        // Build trace data — enriched when emitFullTrace is on
        // deno-lint-ignore no-explicit-any
        const traceData: Record<string, any> = {
          method: request.method,
          url: request.url,
          status: response.status,
          duration,
        };

        // Pick up operation name from GraphQL client (X-Glubean-Op header)
        const glubeanOp = request.headers.get("x-glubean-op");
        if (glubeanOp) {
          traceData.name = glubeanOp;
        }

        if (emitFullTrace) {
          traceData.requestHeaders = Object.fromEntries(
            request.headers.entries(),
          );
          if (lastRequestBody !== undefined) {
            traceData.requestBody = truncateBody(lastRequestBody);
          }
          traceData.responseHeaders = Object.fromEntries(
            response.headers.entries(),
          );

          // Clone the response to read the body without consuming the original stream
          try {
            const cloned = response.clone();
            const contentType = response.headers.get("content-type") || "";
            if (contentType.includes("json")) {
              traceData.responseBody = truncateBody(await cloned.json());
            } else if (
              contentType.includes("text") ||
              contentType.includes("xml")
            ) {
              const text = await cloned.text();
              traceData.responseBody = truncateBody(text);
            }
            // Binary content types are intentionally skipped
          } catch {
            // Ignore clone/parse errors — trace still emits without body
          }
          lastRequestBody = undefined;
        }

        ctx.trace(traceData as ApiTrace);

        // Auto-metric for response time
        try {
          const pathname = new URL(request.url).pathname;
          ctx.metric("http_duration_ms", duration, {
            unit: "ms",
            tags: { method: request.method, path: pathname },
          });
        } catch {
          ctx.metric("http_duration_ms", duration, {
            unit: "ms",
            tags: { method: request.method },
          });
        }

        return response;
      },
    ],
  },
});

/**
 * Normalize URL input for ky compatibility:
 * - Strip leading '/' from path when it's not a full URL
 *   (ky requires relative paths without leading slash when using prefixUrl)
 */
function normalizeUrl(input: string | URL | Request): string | URL | Request {
  if (
    typeof input === "string" &&
    input.startsWith("/") &&
    !input.startsWith("//")
  ) {
    return input.slice(1);
  }
  return input;
}

/**
 * Normalize options to fix ky quirks:
 * - Remove empty searchParams to prevent ky from appending bare '?'
 */
// deno-lint-ignore no-explicit-any
function normalizeOptions(options?: any): any {
  if (!options) return options;
  const normalized = { ...options };
  // Remove empty searchParams so ky doesn't append a bare '?'
  if (normalized.searchParams != null) {
    if (normalized.searchParams instanceof URLSearchParams) {
      if (normalized.searchParams.toString() === "") {
        delete normalized.searchParams;
      }
    } else if (
      typeof normalized.searchParams === "object" &&
      Object.keys(normalized.searchParams).length === 0
    ) {
      delete normalized.searchParams;
    } else if (
      typeof normalized.searchParams === "string" &&
      normalized.searchParams === ""
    ) {
      delete normalized.searchParams;
    }
  }
  return normalized;
}

/**
 * Run pre-request schema validations (query params, request body).
 * Extracts schema option from the options object.
 */
// deno-lint-ignore no-explicit-any
function runPreRequestSchemaValidation(options?: any): void {
  const schemaOpts = options?.schema as HttpSchemaOptions | undefined;
  if (!schemaOpts) return;

  // Validate query/searchParams
  if (schemaOpts.query && options?.searchParams != null) {
    const { schema, severity } = resolveSchemaEntry(schemaOpts.query);
    runSchemaValidation(options.searchParams, schema, "query params", severity);
  }

  // Validate request body (json)
  if (schemaOpts.request && options?.json !== undefined) {
    const { schema, severity } = resolveSchemaEntry(schemaOpts.request);
    runSchemaValidation(options.json, schema, "request body", severity);
  }
}

/**
 * Wrap a ky response promise to run post-response schema validation.
 * Attaches to the .json() method so we validate the parsed body.
 */
function wrapResponseWithSchema(
  // deno-lint-ignore no-explicit-any
  responsePromise: any,
  schemaOpts?: HttpSchemaOptions,
  // deno-lint-ignore no-explicit-any
): any {
  if (!schemaOpts?.response) return responsePromise;

  const { schema, severity } = resolveSchemaEntry(schemaOpts.response);

  // Wrap the .json() method to validate after parsing
  const originalJson = responsePromise.json.bind(responsePromise);
  responsePromise.json = async () => {
    const body = await originalJson();
    runSchemaValidation(body, schema, "response body", severity);
    return body;
  };

  return responsePromise;
}

/**
 * Wrap a ky instance so that:
 * 1. Leading '/' in URL paths is stripped (ky + prefixUrl compatibility)
 * 2. Empty searchParams are removed (no bare '?' in URL)
 * 3. extend() returns a wrapped instance (preserves normalization)
 * 4. Schema validation runs on request/response when `schema` option is provided
 */
// deno-lint-ignore no-explicit-any
function wrapKy(instance: any): any {
  const methods = ["get", "post", "put", "patch", "delete", "head"] as const;

  function callWithSchema(
    // deno-lint-ignore no-explicit-any
    kyFn: (...args: any[]) => any,
    // deno-lint-ignore no-explicit-any
    input: any,
    // deno-lint-ignore no-explicit-any
    options?: any,
  ) {
    const normalized = normalizeOptions(options);
    // Run pre-request validations (query, request body)
    runPreRequestSchemaValidation(normalized);
    // Strip schema option before passing to ky (ky doesn't know about it)
    // deno-lint-ignore no-explicit-any
    let kyOptions: any;
    if (normalized?.schema) {
      const { schema: _schema, ...rest } = normalized;
      kyOptions = rest;
    } else {
      kyOptions = normalized;
    }
    const responsePromise = kyFn(normalizeUrl(input), kyOptions);
    return wrapResponseWithSchema(responsePromise, normalized?.schema);
  }

  // The callable + methods wrapper
  // deno-lint-ignore no-explicit-any
  const wrapped: Record<string, any> = function (input: any, options?: any) {
    return callWithSchema(instance, input, options);
  };

  for (const method of methods) {
    // deno-lint-ignore no-explicit-any
    wrapped[method] = (input: any, options?: any) => callWithSchema(instance[method].bind(instance), input, options);
  }

  // deno-lint-ignore no-explicit-any
  wrapped.extend = (options?: any) => wrapKy(instance.extend(normalizeOptions(options)));

  return wrapped;
}

// Attach wrapped http client to ctx
// deno-lint-ignore no-explicit-any
(ctx as any).http = wrapKy(kyInstance);

// Set global runtime slot for configure() API.
// configure() returns lazy getters that read from this slot at test execution time.
// This must be set BEFORE importing user code so the slot is available during execution.
//
// Wrap vars and secrets with a Proxy so that configure()'s requireVar/requireSecret
// also fall back to system env (same behavior as ctx.vars/ctx.secrets above).
function withEnvFallback(
  explicit: Record<string, string>,
): Record<string, string> {
  return new Proxy(explicit, {
    get(target, prop: string) {
      const value = target[prop];
      if (value !== undefined && value !== null && value !== "") return value;
      return Deno.env.get(prop) || undefined;
    },
    has(target, prop: string) {
      return prop in target || Deno.env.get(prop) !== undefined;
    },
  });
}

// deno-lint-ignore no-explicit-any
(globalThis as any).__glubeanRuntime = {
  vars: withEnvFallback(rawVars),
  secrets: withEnvFallback(rawSecrets),
  // deno-lint-ignore no-explicit-any
  http: (ctx as any).http,
  test: runtimeTest,
  action: ctx.action,
  event: ctx.event,
  log: ctx.log,
};

try {
  // Dynamic import - LOAD phase
  console.log(
    JSON.stringify({
      type: "log",
      message: `Loading test module: ${testUrl}`,
    }),
  );

  const userModule = await import(testUrl);

  if (testIds) {
    // ── File-level batch mode ──
    // Run multiple tests sequentially in a single process.
    // Module-level state (let variables) is preserved between tests.
    let hasFailure = false;
    for (const id of testIds) {
      resetTestCounters();
      let testObj = findTestById(userModule, id);
      // Fallback for non-deterministic tests (test.pick): the testId from
      // discovery may differ from this run's random selection. Use the stable
      // exportName to locate the test.
      if (!testObj && exportNamesMap[id]) {
        testObj = findTestByExport(userModule, exportNamesMap[id]);
      }
      if (!testObj) {
        console.log(
          JSON.stringify({
            type: "start",
            id,
            name: id,
          }),
        );
        console.log(
          JSON.stringify({
            type: "status",
            status: "failed",
            id,
            error: `Test "${id}" not found in module`,
          }),
        );
        hasFailure = true;
        continue;
      }
      try {
        await executeNewTest(testObj);
      } catch (error) {
        emitSummary();
        if (error instanceof SkipError) {
          console.log(
            JSON.stringify({
              type: "status",
              status: "skipped",
              id,
              reason: error.reason,
            }),
          );
        } else {
          hasFailure = true;
          console.log(
            JSON.stringify({
              type: "status",
              status: "failed",
              id,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            }),
          );
        }
      }
    }
    Deno.exit(hasFailure ? 1 : 0);
  }

  // ── Single test mode (default) ──
  let testObj = findTestById(userModule, testId!);
  if (!testObj && exportName) {
    // Fallback: for non-deterministic tests (test.pick), the testId from
    // discovery may not match this run's random selection. Use the stable
    // exportName to locate the export and pick the first resolved test.
    testObj = findTestByExport(userModule, exportName);
  }
  if (testObj) {
    await executeNewTest(testObj);
  } else {
    throw new Error(
      `Test "${testId}" not found. Available exports: ${
        Object.keys(
          userModule,
        ).join(", ")
      }`,
    );
  }
} catch (error) {
  // Emit HTTP summary before final status
  emitSummary();

  // Check if this is a skip error
  if (error instanceof SkipError) {
    console.log(
      JSON.stringify({
        type: "status",
        status: "skipped",
        reason: error.reason,
      }),
    );
    Deno.exit(0); // Exit cleanly for skipped tests
  }

  // Regular error - report as failure
  console.log(
    JSON.stringify({
      type: "status",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
  Deno.exit(1);
}

// Resolution utilities shared with MCP and other consumers.
// Extracted to resolve.ts for reuse outside the sandbox.
import { findTestByExport, findTestById } from "./resolve.ts";

/**
 * Resolve test.extend() fixtures and run the test body with an augmented context.
 *
 * Simple fixtures (1-param) are resolved first; their return values are merged
 * into the context via prototype-linked copy. Lifecycle fixtures (2-param with
 * `use` callback) wrap the test execution so cleanup runs after the test completes.
 *
 * Fixture type is determined by `fn.length`:
 * - 1 → simple factory: `(ctx) => instance`
 * - 2 → lifecycle factory: `(ctx, use) => { setup; await use(instance); cleanup }`
 */
async function withFixtures(
  // deno-lint-ignore no-explicit-any
  fixtures: Record<string, (...args: any[]) => any>,
  baseCtx: TestContext,
  runTest: (ctx: TestContext) => Promise<void>,
): Promise<void> {
  // Prototype-linked copy: core ctx fields (vars, secrets, http, ...) remain accessible
  const augmented = Object.create(baseCtx) as TestContext;

  // deno-lint-ignore no-explicit-any
  const simple: [string, (...args: any[]) => any][] = [];
  // deno-lint-ignore no-explicit-any
  const lifecycle: [string, (...args: any[]) => any][] = [];

  for (const [key, fn] of Object.entries(fixtures)) {
    if (fn.length >= 2) {
      lifecycle.push([key, fn]);
    } else {
      simple.push([key, fn]);
    }
  }

  // Resolve simple fixtures first
  for (const [key, fn] of simple) {
    (augmented as unknown as Record<string, unknown>)[key] = await fn(augmented);
  }

  // No lifecycle fixtures — run the test directly
  if (lifecycle.length === 0) {
    await runTest(augmented);
    return;
  }

  // Build a nested chain for lifecycle fixtures.
  // Each lifecycle wraps the next; the innermost call is the actual test.
  let innerFn: () => Promise<void> = () => runTest(augmented);

  for (let i = lifecycle.length - 1; i >= 0; i--) {
    const [key, factory] = lifecycle[i];
    const next = innerFn;
    innerFn = () => {
      let called = false;
      // Capture the promise created inside use() so we can ensure the test
      // body completes even if the fixture forgets to `await use(...)`.
      let usePromise: Promise<void> | null = null;

      return factory(augmented, (instance: unknown): Promise<void> => {
        if (called) {
          throw new Error(
            `Lifecycle fixture "${key}" called use() more than once. ` +
              `Each fixture must call use() exactly once.`,
          );
        }
        called = true;
        (augmented as unknown as Record<string, unknown>)[key] = instance;
        usePromise = next();
        return usePromise;
      }).then(async () => {
        if (!called) {
          throw new Error(
            `Lifecycle fixture "${key}" completed without calling use(). ` +
              `Lifecycle fixtures must call use(instance) exactly once ` +
              `to run the test body.`,
          );
        }
        // If fixture didn't await use(), wait for the test body to finish
        // before proceeding. When properly awaited this is a no-op.
        if (usePromise) {
          await usePromise;
        }
      });
    };
  }

  await innerFn();
}

/**
 * Execute a test created with the builder API.
 * Handles both simple tests and multi-step tests with setup/teardown.
 * When the test carries `fixtures` (from `test.extend()`), they are resolved
 * and injected into the context before the test body runs.
 *
 * @param test The Test object to execute
 */
async function executeNewTest(test: Test<unknown>): Promise<void> {
  const testTags = normalizeTestTags(test.meta.tags);
  // Keep runtime metadata aligned with the actual resolved test before user code runs.
  // deno-lint-ignore no-explicit-any
  (globalThis as any).__glubeanRuntime.test = {
    id: test.meta.id,
    tags: testTags,
  };
  console.log(
    JSON.stringify({
      type: "start",
      id: test.meta.id,
      name: test.meta.name || test.meta.id,
      tags: testTags,
      ...(retryCount > 0 && { retryCount }),
    }),
  );

  // Start memory monitoring
  startMemoryMonitoring();

  try {
    // Core test body — receives the effective ctx (base or fixture-augmented)
    const runTestBody = async (effectiveCtx: TestContext) => {
      if (test.type === "simple") {
        if (!test.fn) {
          throw new Error(`Invalid test "${test.meta.id}": missing fn`);
        }
        await test.fn(effectiveCtx);
      } else {
        let state: unknown = undefined;
        let stepFailed = false;
        try {
          if (test.setup) {
            console.log(
              JSON.stringify({
                type: "log",
                message: "Running setup...",
              }),
            );
            state = await test.setup(effectiveCtx);
          }
          if (test.steps) {
            totalSteps = test.steps.length;
            for (let i = 0; i < test.steps.length; i++) {
              const step = test.steps[i];

              // If a previous step failed, skip remaining steps
              if (stepFailed) {
                skippedSteps++;
                console.log(
                  JSON.stringify({
                    type: "step_end",
                    index: i,
                    name: step.meta.name,
                    status: "skipped",
                    durationMs: 0,
                    assertions: 0,
                    failedAssertions: 0,
                  }),
                );
                continue;
              }

              // Reset per-step assertion counters and set step scope
              stepFailedAssertions = 0;
              stepAssertionTotal = 0;
              currentStepIndex = i;
              const stepStart = performance.now();

              console.log(
                JSON.stringify({
                  type: "step_start",
                  index: i,
                  name: step.meta.name,
                  total: test.steps.length,
                }),
              );

              let stepError: string | undefined;
              let stepReturnState: unknown = undefined;
              const retries = step.meta.retries;
              const configuredRetries = typeof retries === "number" && Number.isFinite(retries)
                ? Math.max(0, Math.floor(retries))
                : 0;
              const stepTimeout = step.meta.timeout;
              const configuredStepTimeout = typeof stepTimeout === "number" && Number.isFinite(stepTimeout)
                ? Math.floor(stepTimeout)
                : 0;
              const stepTimeoutMs = configuredStepTimeout > 0 ? configuredStepTimeout : undefined;
              const maxAttempts = configuredRetries + 1;
              let attemptsUsed = 0;
              let lastFailedAssertions = 0;
              let lastAssertions = 0;
              let timeoutFailure = false;

              for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                attemptsUsed = attempt;
                stepError = undefined;
                stepReturnState = undefined;
                stepFailedAssertions = 0;
                stepAssertionTotal = 0;
                timeoutFailure = false;
                let stepTimeoutId: number | undefined;

                try {
                  const stepResult = step.fn(effectiveCtx, state);
                  // Note: timed-out step bodies cannot be force-cancelled in JS.
                  // We treat timeout as terminal (no further retries) to avoid
                  // overlapping attempts mutating shared step context.
                  const result = stepTimeoutMs === undefined ? await stepResult : await Promise.race([
                    stepResult,
                    new Promise<never>((_, reject) => {
                      stepTimeoutId = setTimeout(() => {
                        reject(
                          new StepTimeoutError(step.meta.name, stepTimeoutMs),
                        );
                      }, stepTimeoutMs);
                    }),
                  ]);
                  if (result !== undefined) {
                    state = result;
                    stepReturnState = result;
                  }
                } catch (err) {
                  stepError = err instanceof Error ? err.message : String(err);
                  timeoutFailure = err instanceof StepTimeoutError;
                } finally {
                  if (stepTimeoutId !== undefined) {
                    clearTimeout(stepTimeoutId);
                  }
                }

                lastFailedAssertions = stepFailedAssertions;
                lastAssertions = stepAssertionTotal;

                const attemptFailed = !!stepError || stepFailedAssertions > 0;
                if (!attemptFailed) {
                  break;
                }

                // Timeouts are terminal to avoid overlapping attempts from
                // dangling async operations in the timed-out step body.
                if (timeoutFailure) {
                  break;
                }

                if (attempt < maxAttempts) {
                  const reason = stepError ? stepError : `${stepFailedAssertions} failed assertion(s)`;
                  console.log(
                    JSON.stringify({
                      type: "log",
                      stepIndex: i,
                      message: `Retrying step "${step.meta.name}" (${
                        attempt + 1
                      }/${maxAttempts}) after failure: ${reason}`,
                    }),
                  );
                }
              }

              const durationMs = Math.round(performance.now() - stepStart);
              const failed = !!stepError || lastFailedAssertions > 0;

              // Serialize return state with size guard (max 4 KB)
              let returnStatePayload: unknown = undefined;
              if (stepReturnState !== undefined) {
                try {
                  const serialized = JSON.stringify(stepReturnState);
                  if (serialized.length <= 4096) {
                    returnStatePayload = stepReturnState;
                  } else {
                    returnStatePayload = `[truncated: ${serialized.length} bytes]`;
                  }
                } catch {
                  returnStatePayload = "[non-serializable]";
                }
              }

              console.log(
                JSON.stringify({
                  type: "step_end",
                  index: i,
                  name: step.meta.name,
                  status: failed ? "failed" : "passed",
                  durationMs,
                  assertions: lastAssertions,
                  failedAssertions: lastFailedAssertions,
                  attempts: attemptsUsed,
                  retriesUsed: Math.max(0, attemptsUsed - 1),
                  ...(stepError && { error: stepError }),
                  ...(returnStatePayload !== undefined && {
                    returnState: returnStatePayload,
                  }),
                }),
              );

              currentStepIndex = null;

              if (failed) {
                failedSteps++;
                stepFailed = true;
                // Don't throw here — let the loop continue to emit skip events
              } else {
                passedSteps++;
              }
            }
          }
        } finally {
          if (test.teardown) {
            try {
              console.log(
                JSON.stringify({
                  type: "log",
                  message: "Running teardown...",
                }),
              );
              await test.teardown(effectiveCtx, state);
            } catch (teardownError) {
              console.log(
                JSON.stringify({
                  type: "log",
                  message: `Teardown error: ${
                    teardownError instanceof Error ? teardownError.message : String(teardownError)
                  }`,
                }),
              );
            }
          }
        }

        // If any step failed (assertion or throw), mark overall test as failed
        if (stepFailed) {
          // Emit summary before throwing so that step/assertion counts are reported
          emitSummary();
          throw new Error("One or more steps failed");
        }
      }
    };

    // Resolve test.extend() fixtures (if any) and run the test body
    if (test.fixtures && Object.keys(test.fixtures).length > 0) {
      await withFixtures(test.fixtures, ctx, runTestBody);
    } else {
      await runTestBody(ctx);
    }

    // Stop monitoring and get peak memory
    const peakBytes = stopMemoryMonitoring();

    // Emit summary before final status
    emitSummary();

    console.log(
      JSON.stringify({
        type: "status",
        status: "completed",
        id: test.meta.id,
        peakMemoryBytes: peakBytes,
        peakMemoryMB: (peakBytes / 1024 / 1024).toFixed(2),
      }),
    );
  } catch (error) {
    stopMemoryMonitoring();
    throw error;
  }
}
