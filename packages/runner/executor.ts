import type { ApiTrace, GlubeanAction, GlubeanEvent } from "@glubean/sdk";
import { resolveAllowNetFlag } from "./config.ts";
import type { SharedRunConfig } from "./config.ts";

// Constants
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds
const SIGTERM_EXIT_CODE = 143;
const SIGKILL_EXIT_CODE = 137;

/**
 * Event types emitted by the test executor.
 */
export type ExecutionEvent =
  | {
    type: "start";
    id: string;
    name: string;
    tags?: string[];
    suiteId?: string;
    suiteName?: string;
    /** Whole-test re-run count (0 for first attempt, omitted when 0). */
    retryCount?: number;
  }
  | { type: "log"; message: string; data?: unknown; stepIndex?: number }
  | {
    type: "assertion";
    passed: boolean;
    message: string;
    actual?: unknown;
    expected?: unknown;
    stepIndex?: number;
  }
  | { type: "trace"; data: ApiTrace; stepIndex?: number }
  | { type: "action"; data: GlubeanAction; stepIndex?: number }
  | { type: "event"; data: GlubeanEvent; stepIndex?: number }
  | {
    type: "warning";
    condition: boolean;
    message: string;
    stepIndex?: number;
  }
  | {
    type: "schema_validation";
    label: string;
    success: boolean;
    severity: "error" | "warn" | "fatal";
    issues?: Array<{ message: string; path?: Array<string | number> }>;
    stepIndex?: number;
  }
  | {
    type: "metric";
    name: string;
    value: number;
    unit?: string;
    tags?: Record<string, string>;
    stepIndex?: number;
  }
  | {
    type: "status";
    status: "completed" | "failed" | "skipped";
    id?: string;
    error?: string;
    stack?: string;
    reason?: string;
    peakMemoryBytes?: number;
    peakMemoryMB?: string;
  }
  | { type: "error"; message: string }
  | {
    type: "step_start";
    index: number;
    name: string;
    total: number;
  }
  | {
    type: "step_end";
    index: number;
    name: string;
    status: "passed" | "failed" | "skipped";
    durationMs: number;
    assertions: number;
    failedAssertions: number;
    error?: string;
    returnState?: unknown;
    /** Number of step attempts performed (first run + retries). */
    attempts?: number;
    /** Number of retries used (attempts - 1). */
    retriesUsed?: number;
  }
  | { type: "timeout_update"; timeout: number }
  | {
    type: "summary";
    data: {
      httpRequestTotal: number;
      httpErrorTotal: number;
      httpErrorRate: number;
      assertionTotal: number;
      assertionFailed: number;
      warningTotal: number;
      warningTriggered: number;
      schemaValidationTotal: number;
      schemaValidationFailed: number;
      schemaValidationWarnings: number;
      stepTotal: number;
      stepPassed: number;
      stepFailed: number;
      stepSkipped: number;
    };
  };

/**
 * Execution context passed to the test.
 */
export interface ExecutionNetworkPolicy {
  /** Shared serverless mode enforces egress guardrails in harness runtime. */
  mode: "shared_serverless";
  /** Hard cap on outbound requests per test execution. */
  maxRequests: number;
  /** Max in-flight outbound requests per test execution. */
  maxConcurrentRequests: number;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Approximate response-byte budget per execution. */
  maxResponseBytes: number;
  /** Allowed destination ports for outbound HTTP(S) traffic. */
  allowedPorts: number[];
}

export interface ExecutionContext {
  vars: Record<string, string>;
  secrets: Record<string, string>;
  /**
   * Metadata for the currently executing test.
   * Passed through to the harness runtime for plugin activation decisions.
   */
  test?: {
    id?: string;
    tags?: string[];
  };
  /** Whole-test re-run count for this execution (0 for first attempt). */
  retryCount?: number;
  /** Optional egress policy applied by the harness runtime. */
  networkPolicy?: ExecutionNetworkPolicy;
}

/**
 * A timestamped event in the execution timeline.
 * When events come from batch execution, `testId` identifies which test the event belongs to.
 */
export type TimelineEvent =
  | {
    type: "log";
    ts: number;
    testId?: string;
    /** Index of the containing step (if event was emitted within a builder step). */
    stepIndex?: number;
    message: string;
    data?: unknown;
  }
  | {
    type: "assertion";
    ts: number;
    testId?: string;
    stepIndex?: number;
    passed: boolean;
    message: string;
    actual?: unknown;
    expected?: unknown;
  }
  | {
    type: "warning";
    ts: number;
    testId?: string;
    stepIndex?: number;
    condition: boolean;
    message: string;
  }
  | {
    type: "schema_validation";
    ts: number;
    testId?: string;
    stepIndex?: number;
    label: string;
    success: boolean;
    severity: "error" | "warn" | "fatal";
    issues?: Array<{ message: string; path?: Array<string | number> }>;
  }
  | {
    type: "trace";
    ts: number;
    testId?: string;
    stepIndex?: number;
    data: ApiTrace;
  }
  | {
    type: "action";
    ts: number;
    testId?: string;
    stepIndex?: number;
    data: GlubeanAction;
  }
  | {
    type: "event";
    ts: number;
    testId?: string;
    stepIndex?: number;
    data: GlubeanEvent;
  }
  | {
    type: "metric";
    ts: number;
    testId?: string;
    stepIndex?: number;
    name: string;
    value: number;
    unit?: string;
    tags?: Record<string, string>;
  }
  | {
    /** Emitted when a builder step begins execution. */
    type: "step_start";
    ts: number;
    testId?: string;
    index: number;
    name: string;
    total: number;
  }
  | {
    /** Emitted when a builder step completes, fails, or is skipped. */
    type: "step_end";
    ts: number;
    testId?: string;
    index: number;
    name: string;
    status: "passed" | "failed" | "skipped";
    durationMs: number;
    assertions: number;
    failedAssertions: number;
    error?: string;
    /** The return value from the step function, if any (truncated at 4 KB). */
    returnState?: unknown;
    /** Number of step attempts performed (first run + retries). */
    attempts?: number;
    /** Number of retries used (attempts - 1). */
    retriesUsed?: number;
  }
  | {
    type: "summary";
    ts: number;
    testId?: string;
    data: {
      httpRequestTotal: number;
      httpErrorTotal: number;
      httpErrorRate: number;
      assertionTotal: number;
      assertionFailed: number;
      warningTotal: number;
      warningTriggered: number;
      schemaValidationTotal: number;
      schemaValidationFailed: number;
      schemaValidationWarnings: number;
      stepTotal: number;
      stepPassed: number;
      stepFailed: number;
      stepSkipped: number;
    };
  };

/**
 * Callback for streaming events during execution.
 * Can be sync or async. If async, execution waits for the callback to complete.
 *
 * @example
 * const handler: EventHandler = async (event) => {
 *   await fetch("/api/events", { method: "POST", body: JSON.stringify(event) });
 * };
 */
export type EventHandler = (event: TimelineEvent) => void | Promise<void>;

/**
 * Options for single test execution.
 */
export interface SingleExecutionOptions {
  /**
   * Optional callback invoked for each event (log, assertion, trace).
   * Use this to stream events to a remote server in real-time.
   *
   * @example
   * await executor.execute(url, id, ctx, {
   *   onEvent: (event) => buffer.push(event),
   * });
   */
  onEvent?: EventHandler;
  /**
   * Optional testId to include in events.
   * Automatically set when called from executeMany() for batch execution.
   * Useful for distinguishing events from different tests in parallel execution.
   */
  includeTestId?: boolean;
  /**
   * Test execution timeout in milliseconds.
   * Default: 30000 (30 seconds)
   *
   * @example
   * await executor.execute(url, id, ctx, { timeout: 60000 }); // 60 seconds
   */
  timeout?: number;
}

/**
 * Final result after test execution completes.
 */
export interface ExecutionResult {
  success: boolean;
  testId: string;
  testName?: string;
  suiteId?: string;
  suiteName?: string;
  /** All events in chronological order (logs, assertions, traces, steps) */
  events: TimelineEvent[];
  error?: string;
  stack?: string;
  duration: number;
  /** Whole-test re-run count (0 for first attempt, undefined when 0). */
  retryCount?: number;
  /** Total number of assertions executed */
  assertionCount: number;
  /** Number of failed assertions */
  failedAssertionCount: number;
  /** Peak memory usage in bytes (if available) */
  peakMemoryBytes?: number;
  /** Peak memory usage in MB (formatted string, if available) */
  peakMemoryMB?: string;
}

/**
 * Options for running multiple tests.
 */
export interface ExecutionOptions {
  /** Max number of tests to run in parallel. Default: 1. */
  concurrency?: number;
  /** Stop scheduling remaining tests after first failure. Default: false. */
  stopOnFailure?: boolean;
  /**
   * Stop scheduling remaining tests after N failures. Default: undefined (no limit).
   * Takes precedence over `stopOnFailure` when set.
   * Equivalent to `stopOnFailure: true` when set to 1.
   */
  failAfter?: number;
  /**
   * Optional callback invoked for each event across all tests.
   * Events include a testId field to identify which test they belong to.
   */
  onEvent?: EventHandler;
}

/**
 * Result for a multi-test execution.
 */
export interface ExecutionBatchResult {
  results: ExecutionResult[];
  success: boolean;
  failedCount: number;
  /** Number of tests skipped due to fail-fast / failAfter. */
  skippedCount: number;
  duration: number;
}

/**
 * Options for configuring the TestExecutor.
 */
export interface ExecutorOptions {
  /**
   * V8 max heap size in MB for the subprocess.
   * When exceeded, V8 throws an OOM error instead of being killed by the OS.
   * Recommended: Set this ~50MB below container memory limit.
   *
   * @example
   * new TestExecutor({ maxHeapSizeMb: 400 }); // 400MB heap limit
   */
  maxHeapSizeMb?: number;

  /**
   * Additional V8 flags to pass to the subprocess.
   * @example ["--expose-gc", "--trace-gc"]
   */
  v8Flags?: string[];

  /**
   * Additional Deno permission flags.
   * Default: ["--allow-net", "--allow-read"]
   */
  permissions?: string[];

  /**
   * Optional path to deno.json or deno.jsonc for import map resolution.
   * This is passed to the sandboxed subprocess via `--config`.
   */
  configPath?: string;

  /**
   * Working directory for the subprocess.
   * Should be the project root (where deno.json lives).
   * This ensures relative paths in data loaders (fromCsv, fromDir, etc.)
   * resolve correctly regardless of where the runner is invoked from.
   */
  cwd?: string;

  /**
   * When true, HTTP auto-trace events include full request/response headers
   * and bodies (with a 10KB size guard). Defaults to false for minimal traces.
   */
  emitFullTrace?: boolean;

  /**
   * Enable V8 Inspector for debugging.
   * When set to a port number, the harness subprocess starts with
   * `--inspect-brk=127.0.0.1:{port}`, pausing on the first statement
   * until a debugger attaches.
   * When set to `true`, uses `--inspect-brk` (default port 9229).
   * When unset or false, debugging is disabled (normal execution).
   *
   * @example
   * // Debug on a specific port
   * new TestExecutor({ inspectBrk: 9230 });
   *
   * // Debug on default port (9229)
   * new TestExecutor({ inspectBrk: true });
   */
  inspectBrk?: number | boolean;

  /**
   * Env var prefixes to mask in the subprocess environment.
   * Matching vars are overwritten with "***" (not removed).
   *
   * Why overwrite instead of remove? Deno.Command's `env` option
   * merges with (not replaces) the parent environment. Using
   * `clearEnv: true` would also wipe system vars (PATH, HOME, etc.).
   * Overwriting to "***" is safe and simple.
   *
   * @example
   * new TestExecutor({ maskEnvPrefixes: ["GLUBEAN_WORKER_TOKEN"] });
   */
  maskEnvPrefixes?: string[];
}

/**
 * TestExecutor manages the lifecycle of sandboxed test execution.
 */
export class TestExecutor {
  private harnessPath: string;
  private options: ExecutorOptions;

  constructor(options: ExecutorOptions = {}) {
    // Use full URL for JSR compatibility (pathname doesn't work with jsr: URLs)
    this.harnessPath = new URL("./harness.ts", import.meta.url).href;
    this.options = options;
  }

  /**
   * Create a TestExecutor pre-configured from SharedRunConfig.
   * Consumers only need to add context-specific overrides.
   *
   * @example
   * const executor = TestExecutor.fromSharedConfig(LOCAL_RUN_DEFAULTS, {
   *   configPath, cwd: rootDir,
   * });
   */
  static fromSharedConfig(
    shared: SharedRunConfig,
    overrides?: Partial<ExecutorOptions>,
  ): TestExecutor {
    // Sanitize: strip any --allow-net that leaked into permissions
    // (allowNet field is the single source for network policy).
    // --allow-env is NOT stripped — it's a legitimate permission
    // that CLI/MCP presets include. Credential safety is handled
    // by maskEnvPrefixes, not by removing --allow-env.
    const sanitized = shared.permissions.filter(
      (p) => !p.startsWith("--allow-net"),
    );

    const netFlag = resolveAllowNetFlag(shared.allowNet);
    const permissions = netFlag ? [netFlag, ...sanitized] : [...sanitized];

    return new TestExecutor({
      permissions,
      emitFullTrace: shared.emitFullTrace,
      ...overrides,
    });
  }

  /**
   * Build an env overlay that masks sensitive vars with "***".
   * Returns undefined when no masking is needed (parent env inherited as-is).
   */
  private buildEnvOverlay(): Record<string, string> | undefined {
    const prefixes = this.options.maskEnvPrefixes;
    if (!prefixes?.length) return undefined;
    const overlay: Record<string, string> = {};
    for (const key of Object.keys(Deno.env.toObject())) {
      if (prefixes.some((p) => key.startsWith(p))) {
        overlay[key] = "***";
      }
    }
    return Object.keys(overlay).length > 0 ? overlay : undefined;
  }

  /**
   * Execute a test and stream events as they occur.
   *
   * @param testUrl URL or file path to the test module
   * @param testId The export name or test case ID
   * @param context Variables and secrets to inject
   * @param options Optional execution options (timeout)
   * @yields ExecutionEvent objects as they stream from the sandbox
   */
  async *run(
    testUrl: string,
    testId: string,
    context: ExecutionContext,
    options?: { timeout?: number; exportName?: string; testIds?: string[]; exportNames?: Record<string, string> },
  ): AsyncGenerator<ExecutionEvent> {
    // Build V8 flags
    const v8Flags: string[] = [];
    if (this.options.maxHeapSizeMb) {
      v8Flags.push(`--max-heap-size=${this.options.maxHeapSizeMb}`);
    }
    if (this.options.v8Flags) {
      v8Flags.push(...this.options.v8Flags);
    }

    // Build permission flags
    // Default permissions are always included; user permissions are appended.
    // Special case: -A or --allow-all grants everything, skip defaults.
    const userPerms = this.options.permissions ?? [];
    const hasAllowAll = userPerms.some(
      (p) => p === "-A" || p === "--allow-all",
    );
    const permissions = hasAllowAll ? ["-A"] : [
      "--allow-net", // Allow network for API testing
      "--allow-read", // Allow reading test files
      "--allow-env", // Allow env access (e.g. GLUBEAN_PICK for test.pick)
      ...userPerms.filter(
        (p) => p !== "--allow-net" && p !== "--allow-read" && p !== "--allow-env",
      ),
    ];

    // Build args array
    const args: string[] = ["run"];

    // --inspect-brk: enable V8 Inspector and pause on the first statement.
    // The VSCode extension polls http://127.0.0.1:{port}/json to detect when
    // the inspector is ready, then attaches the debugger with continueOnAttach.
    // Also check the GLUBEAN_INSPECT_BRK env var (set by VSCode extension).
    const inspectBrk = this.options.inspectBrk ||
      (() => {
        const envVal = Deno.env.get("GLUBEAN_INSPECT_BRK");
        if (!envVal) return false;
        const port = parseInt(envVal, 10);
        return isNaN(port) ? true : port;
      })();

    if (inspectBrk) {
      if (typeof inspectBrk === "number") {
        args.push(`--inspect-brk=127.0.0.1:${inspectBrk}`);
      } else {
        args.push("--inspect-brk");
      }
    }

    // GLUBEAN_DEV_CONFIG overrides the config path for local development,
    // so the harness subprocess can resolve runner dependencies (e.g. ky)
    // from the local workspace instead of the test project's deno.json.
    const devConfig = Deno.env.get("GLUBEAN_DEV_CONFIG");
    const effectiveConfig = devConfig || this.options.configPath;
    if (effectiveConfig) {
      args.push(`--config=${effectiveConfig}`);
    }
    if (v8Flags.length > 0) {
      args.push(`--v8-flags=${v8Flags.join(",")}`);
    }
    args.push(...permissions);
    args.push("--no-check"); // Faster startup (skip type checking)
    args.push(this.harnessPath);
    args.push(`--testUrl=${testUrl}`);
    if (options?.testIds) {
      // File-level batch mode: run all tests in a single process
      args.push(`--testIds=${options.testIds.join(",")}`);
    } else {
      args.push(`--testId=${testId}`);
    }
    if (options?.exportName) {
      args.push(`--exportName=${options.exportName}`);
    }
    if (options?.exportNames && Object.keys(options.exportNames).length > 0) {
      // Pass testId→exportName mapping for batch mode fallback (test.pick)
      const pairs = Object.entries(options.exportNames)
        .map(([id, name]) => `${id}:${name}`)
        .join(",");
      args.push(`--exportNames=${pairs}`);
    }
    if (this.options.emitFullTrace) {
      args.push("--emitFullTrace");
    }
    // Context is passed via stdin instead of CLI args to avoid length limits and security issues

    // When debugging, inherit stderr so V8 Inspector messages ("Debugger listening on ...")
    // flow directly to the parent process's stderr. The VSCode extension reads this to
    // know when to attach the debugger. In normal mode, stderr is piped for error reporting.
    const command = new Deno.Command(Deno.execPath(), {
      args,
      cwd: this.options.cwd,
      env: this.buildEnvOverlay(),
      stdin: "piped",
      stdout: "piped",
      stderr: inspectBrk ? "inherit" : "piped",
    });

    const process = command.spawn();
    const decoder = new TextDecoder();

    // Write context to stdin
    try {
      const normalizedContext: ExecutionContext = {
        ...context,
        test: {
          id: context.test?.id ?? testId,
          tags: context.test?.tags ?? [],
        },
      };
      const encoder = new TextEncoder();
      const writer = process.stdin.getWriter();
      await writer.write(encoder.encode(JSON.stringify(normalizedContext)));
      await writer.close();
    } catch (error) {
      // If stdin write fails, kill the process and propagate error
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may already be dead
      }
      throw new Error(
        `Failed to write context to subprocess: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Setup timeout if specified (disabled when debugging — breakpoints would trigger it)
    let timeout = inspectBrk ? 0 : options?.timeout ?? DEFAULT_TIMEOUT_MS;
    let timeoutId: number | undefined;
    let timedOut = false;

    const armTimeout = (nextTimeout: number) => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      timeout = nextTimeout;
      if (timeout <= 0) {
        timeoutId = undefined;
        return;
      }
      timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          process.kill("SIGTERM");
        } catch {
          // Process may already be dead
        }
      }, timeout);
    };
    const handleTimeoutUpdateEvent = (event: ExecutionEvent): void => {
      if (
        inspectBrk ||
        event.type !== "timeout_update" ||
        !Number.isFinite(event.timeout) ||
        event.timeout <= 0
      ) {
        return;
      }
      // Relative semantics: timeout_update re-arms from "now".
      armTimeout(Math.floor(event.timeout));
    };

    if (timeout > 0) {
      armTimeout(timeout);
    }

    try {
      // Read stderr in parallel to avoid blocking.
      // When debugging (inspectBrk), stderr is inherited (not piped), so we skip reading it.
      const stderrPromise = inspectBrk ? Promise.resolve("") : this.readStreamAsText(process.stderr, decoder);

      // Read stdout as a stream so timeout updates can be applied immediately.
      const stdoutReader = process.stdout.getReader();
      let stdoutBuffer = "";
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;

          stdoutBuffer += decoder.decode(value, { stream: true });
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() || "";

          for (const line of lines) {
            const event = this.parseExecutionLine(line);
            if (!event) continue;
            handleTimeoutUpdateEvent(event);
            yield event;
          }
        }

        if (stdoutBuffer.trim()) {
          const event = this.parseExecutionLine(stdoutBuffer);
          if (event) {
            handleTimeoutUpdateEvent(event);
            yield event;
          }
        }
      } finally {
        stdoutReader.releaseLock();
      }

      const stderr = await stderrPromise;

      // Clear timeout if set
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      // Wait for process to complete
      const status = await process.status;

      // Check for specific exit conditions
      if (status.code !== 0) {
        if (timedOut) {
          yield {
            type: "error",
            message: `Test execution timed out after ${timeout}ms`,
          };
        } else if (
          status.signal === "SIGKILL" ||
          status.code === SIGKILL_EXIT_CODE
        ) {
          // Detect OOM kill (SIGKILL = 9, exit code = 128 + 9 = 137)
          const heapInfo = this.options.maxHeapSizeMb ? ` (limit: ${this.options.maxHeapSizeMb} MB)` : "";
          const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
          yield {
            type: "error",
            message: `Out of memory — process killed${heapInfo}.${detail}\n` +
              `To fix: process data in smaller batches, use streaming reads, or reduce concurrency.\n` +
              `Run locally with \`glubean run\` to see per-test memory usage.`,
          };
        } else if (
          status.signal === "SIGTERM" ||
          status.code === SIGTERM_EXIT_CODE
        ) {
          yield {
            type: "error",
            message: stderr.trim()
              ? `Process terminated: ${stderr.trim()}`
              : "Process terminated (SIGTERM). Execution may have been cancelled or timed out.",
          };
        } else if (stderr.trim()) {
          // Regular error with stderr output
          yield {
            type: "error",
            message: stderr.trim(),
          };
        } else {
          // No stderr, just report exit code
          yield {
            type: "error",
            message: `Process exited with code ${status.code}${status.signal ? ` (signal: ${status.signal})` : ""}`,
          };
        }
      }
    } finally {
      // Cleanup: ensure process is terminated
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may already be dead
      }
    }
  }

  /**
   * Parse one stdout line into an execution event.
   * Falls back to a raw log event when the line is not valid JSON.
   */
  private parseExecutionLine(line: string): ExecutionEvent | undefined {
    if (!line.trim()) return undefined;
    try {
      return JSON.parse(line) as ExecutionEvent;
    } catch {
      return {
        type: "log",
        message: line,
      };
    }
  }

  /**
   * Read a stream as plain text (for stderr).
   *
   * @param stream The readable stream
   * @param decoder Text decoder instance
   * @returns The complete text content
   */
  private async readStreamAsText(
    stream: ReadableStream<Uint8Array>,
    decoder: TextDecoder,
  ): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    // Efficiently concatenate Uint8Arrays
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    return decoder.decode(combined);
  }

  /**
   * Execute a test and collect all results (non-streaming).
   *
   * @param testUrl URL or file path to the test module
   * @param testId The export name or test case ID
   * @param context Variables and secrets to inject
   * @param options Optional execution options (e.g., onEvent callback, timeout)
   * @returns ExecutionResult with all events and final status
   *
   * @example
   * // Basic usage
   * const result = await executor.execute(url, "myTest", { vars: {}, secrets: {} });
   *
   * @example
   * // With event streaming and timeout
   * const result = await executor.execute(url, "myTest", ctx, {
   *   onEvent: async (event) => {
   *     await reportToServer(event);
   *   },
   *   timeout: 60000, // 60 seconds
   * });
   */
  async execute(
    testUrl: string,
    testId: string,
    context: ExecutionContext,
    options?: SingleExecutionOptions,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const events: TimelineEvent[] = [];
    const onEvent = options?.onEvent;
    const includeTestId = options?.includeTestId ?? false;
    let success = false;
    let testName: string | undefined;
    let suiteId: string | undefined;
    let suiteName: string | undefined;
    let error: string | undefined;
    let stack: string | undefined;
    let peakMemoryBytes: number | undefined;
    let peakMemoryMB: string | undefined;
    // Captured from the `start` event emitted by harness.
    // Omitted when attempt is first run (`0`).
    let retryCount: number | undefined;
    let assertionCount = 0;
    let failedAssertionCount = 0;

    for await (
      const event of this.run(testUrl, testId, context, {
        timeout: options?.timeout,
      })
    ) {
      const ts = Date.now() - startTime;
      let timelineEvent: TimelineEvent | undefined;

      switch (event.type) {
        case "start":
          testName = event.name;
          suiteId = event.suiteId;
          suiteName = event.suiteName;
          retryCount = event.retryCount;
          break;
        case "log":
          timelineEvent = {
            type: "log",
            ts,
            ...(includeTestId && { testId }),
            ...(event.stepIndex !== undefined && {
              stepIndex: event.stepIndex,
            }),
            message: event.message,
            data: event.data,
          };
          break;
        case "assertion":
          assertionCount++;
          if (!event.passed) failedAssertionCount++;
          timelineEvent = {
            type: "assertion",
            ts,
            ...(includeTestId && { testId }),
            ...(event.stepIndex !== undefined && {
              stepIndex: event.stepIndex,
            }),
            passed: event.passed,
            message: event.message,
            actual: event.actual,
            expected: event.expected,
          };
          break;
        case "warning":
          timelineEvent = {
            type: "warning",
            ts,
            ...(includeTestId && { testId }),
            ...(event.stepIndex !== undefined && {
              stepIndex: event.stepIndex,
            }),
            condition: event.condition,
            message: event.message,
          };
          break;
        case "schema_validation":
          timelineEvent = {
            type: "schema_validation",
            ts,
            ...(includeTestId && { testId }),
            ...(event.stepIndex !== undefined && {
              stepIndex: event.stepIndex,
            }),
            label: event.label,
            success: event.success,
            severity: event.severity,
            ...(event.issues && { issues: event.issues }),
          };
          break;
        case "trace":
          timelineEvent = {
            type: "trace",
            ts,
            ...(includeTestId && { testId }),
            ...(event.stepIndex !== undefined && {
              stepIndex: event.stepIndex,
            }),
            data: event.data,
          };
          break;
        case "action":
          timelineEvent = {
            type: "action",
            ts,
            ...(includeTestId && { testId }),
            ...(event.stepIndex !== undefined && {
              stepIndex: event.stepIndex,
            }),
            data: event.data,
          };
          break;
        case "event":
          timelineEvent = {
            type: "event",
            ts,
            ...(includeTestId && { testId }),
            ...(event.stepIndex !== undefined && {
              stepIndex: event.stepIndex,
            }),
            data: event.data,
          };
          break;
        case "metric":
          timelineEvent = {
            type: "metric",
            ts,
            ...(includeTestId && { testId }),
            ...(event.stepIndex !== undefined && {
              stepIndex: event.stepIndex,
            }),
            name: event.name,
            value: event.value,
            unit: event.unit,
            tags: event.tags,
          };
          break;
        case "summary":
          timelineEvent = {
            type: "summary",
            ts,
            ...(includeTestId && { testId }),
            data: event.data,
          };
          break;
        case "status":
          success = event.status === "completed" || event.status === "skipped";
          if (event.error) error = event.error;
          if (event.stack) stack = event.stack;
          if (event.peakMemoryBytes !== undefined) {
            peakMemoryBytes = event.peakMemoryBytes;
          }
          if (event.peakMemoryMB !== undefined) {
            peakMemoryMB = event.peakMemoryMB;
          }
          break;
        case "error":
          success = false;
          // Only set error if not already set (don't overwrite status error with generic exit code message)
          if (!error) {
            error = event.message;
          }
          break;
        case "step_start":
          timelineEvent = {
            type: "step_start",
            ts,
            ...(includeTestId && { testId }),
            index: event.index,
            name: event.name,
            total: event.total,
          };
          break;
        case "step_end":
          timelineEvent = {
            type: "step_end",
            ts,
            ...(includeTestId && { testId }),
            index: event.index,
            name: event.name,
            status: event.status,
            durationMs: event.durationMs,
            assertions: event.assertions,
            failedAssertions: event.failedAssertions,
            error: event.error,
            attempts: event.attempts,
            retriesUsed: event.retriesUsed,
            ...(event.returnState !== undefined && {
              returnState: event.returnState,
            }),
          };
          break;
        case "timeout_update":
          break;
      }

      // Collect event and optionally notify callback
      if (timelineEvent) {
        events.push(timelineEvent);
        if (onEvent) {
          await onEvent(timelineEvent);
        }
      }
    }

    return {
      success,
      testId,
      testName,
      suiteId,
      suiteName,
      events,
      error,
      stack,
      duration: Date.now() - startTime,
      retryCount,
      assertionCount,
      failedAssertionCount,
      peakMemoryBytes,
      peakMemoryMB,
    };
  }

  /**
   * Execute multiple tests with optional parallelism.
   *
   * @param testUrl URL or file path to the test module
   * @param testIds List of test case IDs to execute
   * @param context Variables and secrets to inject
   * @param options Execution options (concurrency, stopOnFailure, onEvent)
   * @returns Aggregated batch result
   *
   * @example
   * // With event streaming for all tests
   * const result = await executor.executeMany(url, ["t1", "t2"], ctx, {
   *   concurrency: 2,
   *   onEvent: (event) => console.log(event),
   * });
   */
  async executeMany(
    testUrl: string,
    testIds: string[],
    context: ExecutionContext,
    options: ExecutionOptions = {},
  ): Promise<ExecutionBatchResult> {
    const startTime = Date.now();
    const concurrency = Math.max(
      DEFAULT_CONCURRENCY,
      Math.min(
        options.concurrency ?? DEFAULT_CONCURRENCY,
        testIds.length || DEFAULT_CONCURRENCY,
      ),
    );
    const results: ExecutionResult[] = new Array(testIds.length);
    const onEvent = options.onEvent;
    let failedCount = 0;
    let nextIndex = 0;
    let stop = false;

    const runNext = async (): Promise<void> => {
      while (!stop) {
        const index = nextIndex++;
        if (index >= testIds.length) return;

        const testId = testIds[index];
        // Include testId in events when streaming from batch execution
        const result = await this.execute(testUrl, testId, context, {
          onEvent,
          includeTestId: !!onEvent,
        });
        results[index] = result;

        if (!result.success) {
          failedCount += 1;
          // Determine the failure threshold
          const failureLimit = options.failAfter ??
            (options.stopOnFailure ? 1 : undefined);
          if (failureLimit !== undefined && failedCount >= failureLimit) {
            stop = true;
            return;
          }
        }
      }
    };

    const workers = Array.from({ length: concurrency }, () => runNext());
    await Promise.all(workers);

    const completedResults = results.filter(Boolean);
    const skippedCount = testIds.length - completedResults.length;

    return {
      results: completedResults,
      success: failedCount === 0,
      failedCount,
      skippedCount,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Legacy function for backward compatibility.
 *
 * @deprecated Use `TestExecutor.execute()` instead for better type safety and more options.
 *
 * @example Migration
 * ```ts
 * // Old way
 * const result = await executeTest(url, id, { vars: {}, secrets: {} });
 *
 * // New way
 * const executor = new TestExecutor();
 * const result = await executor.execute(url, id, { vars: {}, secrets: {} });
 * ```
 */
export async function executeTest(
  testUrl: string,
  testId: string,
  context: Record<string, unknown>,
): Promise<{ success: boolean; logs: string[]; error?: string }> {
  const executor = new TestExecutor();
  const result = await executor.execute(testUrl, testId, {
    vars: (context.vars as Record<string, string>) || {},
    secrets: (context.secrets as Record<string, string>) || {},
  });

  const logs = result.events
    .filter(
      (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
    )
    .map((l) => l.message);

  return {
    success: result.success,
    logs,
    error: result.error,
  };
}

/**
 * Convenience function to execute multiple tests.
 *
 * @deprecated Use `TestExecutor.executeMany()` instead for better control and options.
 *
 * @example Migration
 * ```ts
 * // Old way
 * const result = await executeTests(url, ["t1", "t2"], { vars: {}, secrets: {} }, { concurrency: 2 });
 *
 * // New way
 * const executor = new TestExecutor();
 * const result = await executor.executeMany(url, ["t1", "t2"], { vars: {}, secrets: {} }, { concurrency: 2 });
 * ```
 */
export function executeTests(
  testUrl: string,
  testIds: string[],
  context: Record<string, unknown>,
  options: ExecutionOptions = {},
): Promise<ExecutionBatchResult> {
  const executor = new TestExecutor();
  return executor.executeMany(
    testUrl,
    testIds,
    {
      vars: (context.vars as Record<string, string>) || {},
      secrets: (context.secrets as Record<string, string>) || {},
    },
    options,
  );
}
