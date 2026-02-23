/**
 * Test executor for the worker.
 *
 * Handles bundle downloading, extraction, and test execution.
 * Uses @glubean/runner directly (no subprocess needed).
 */

import { dirname, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { UntarStream } from "@std/tar/untar-stream";
import { normalizePositiveTimeoutMs, TestExecutor, type TimelineEvent } from "@glubean/runner";
import type { RunEvent, RuntimeContext } from "./types.ts";
import type { WorkerConfig } from "./config.ts";
import { ENV_VARS } from "./config.ts";
import type { Logger } from "./logger.ts";

/**
 * Result from test execution.
 */
export interface ExecutorResult {
  /** Whether all tests passed. */
  success: boolean;
  /** Number of events generated. */
  eventCount: number;
  /** Error message if execution failed. */
  error?: string;
  /** Whether execution was aborted. */
  aborted?: boolean;
  /** Whether execution timed out. */
  timedOut?: boolean;
}

/**
 * Callback for run events.
 */
export type OnEvent = (event: RunEvent) => void | Promise<void>;

/**
 * Bundle metadata.
 */
interface BundleMetadataLegacy {
  version?: string;
  projectId?: string;
  files: Record<string, FileMeta>;
}

interface BundleMetadataV1 {
  schemaVersion: "1";
  specVersion: string;
  generatedBy: string;
  generatedAt: string;
  rootHash: string;
  files: Record<string, FileMeta>;
  testCount: number;
  fileCount: number;
  tags: string[];
  warnings?: string[];
  version?: string;
  projectId?: string;
}

type BundleMetadata = BundleMetadataLegacy | BundleMetadataV1;

interface FileMeta {
  hash: string;
  exports: ExportMeta[];
}

interface ExportMeta {
  type: "test";
  id: string;
  name?: string;
  tags?: string[];
  timeout?: number;
  exportName: string;
}

/**
 * Selected test to run.
 */
interface SelectedTest {
  filePath: string;
  testId: string;
  exportName: string;
  tags: string[];
  timeout?: number;
}

interface RunnerNetworkPolicy {
  mode: "shared_serverless";
  maxRequests: number;
  maxConcurrentRequests: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  allowedPorts: number[];
}

function toRunnerNetworkPolicy(config: WorkerConfig): RunnerNetworkPolicy | undefined {
  if (config.networkPolicy.mode !== "shared_serverless") {
    return undefined;
  }
  return {
    mode: "shared_serverless",
    maxRequests: config.networkPolicy.maxRequests,
    maxConcurrentRequests: config.networkPolicy.maxConcurrentRequests,
    requestTimeoutMs: config.networkPolicy.requestTimeoutMs,
    maxResponseBytes: config.networkPolicy.maxResponseBytes,
    allowedPorts: config.networkPolicy.allowedPorts,
  };
}

/**
 * Download a file from a URL.
 */
async function downloadFile(
  url: string,
  destPath: string,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }

    const file = await Deno.open(destPath, { write: true, create: true });
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await file.write(value);
      }
    } finally {
      file.close();
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Calculate SHA-256 checksum of a file.
 */
async function calculateChecksum(filePath: string): Promise<string> {
  const file = await Deno.open(filePath, { read: true });
  try {
    const buffer = new Uint8Array(8192);
    const _hasher = new Uint8Array(32); // SHA-256 produces 32 bytes
    let totalBytes = new Uint8Array(0);

    while (true) {
      const bytesRead = await file.read(buffer);
      if (bytesRead === null) break;

      const chunk = buffer.subarray(0, bytesRead);
      const newTotal = new Uint8Array(totalBytes.length + chunk.length);
      newTotal.set(totalBytes);
      newTotal.set(chunk, totalBytes.length);
      totalBytes = newTotal;
    }

    const hashBuffer = await crypto.subtle.digest("SHA-256", totalBytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } finally {
    file.close();
  }
}

/**
 * Find deno.json/deno.jsonc in extracted bundle root.
 */
async function findDenoConfigPath(
  rootDir: string,
): Promise<string | undefined> {
  const candidates = [join(rootDir, "deno.json"), join(rootDir, "deno.jsonc")];
  for (const candidate of candidates) {
    try {
      await Deno.stat(candidate);
      return candidate;
    } catch {
      // Not found, try next
    }
  }
  return undefined;
}

/**
 * Verify checksum of a downloaded file.
 */
async function verifyChecksum(
  filePath: string,
  expectedChecksum: string | undefined,
  logger: Logger,
): Promise<void> {
  if (!expectedChecksum) {
    logger.warn("No checksum provided, skipping verification");
    return;
  }

  logger.debug("Verifying checksum", { expected: expectedChecksum });
  const actualChecksum = await calculateChecksum(filePath);

  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Bundle checksum mismatch. Expected: ${expectedChecksum}, Got: ${actualChecksum}`,
    );
  }

  logger.debug("Checksum verified successfully");
}

/**
 * Extract a tar file to a directory.
 */
async function extractTar(tarPath: string, destDir: string): Promise<void> {
  const resolvedDest = resolve(destDir) + "/";
  const file = await Deno.open(tarPath, { read: true });
  try {
    for await (const entry of file.readable.pipeThrough(new UntarStream())) {
      const filePath = resolve(destDir, entry.path);
      if (!filePath.startsWith(resolvedDest) && filePath !== resolve(destDir)) {
        throw new Error(
          `Path traversal detected in tar entry: ${entry.path}`,
        );
      }
      if (entry.header.typeflag === "directory") {
        await ensureDir(filePath);
      } else {
        await ensureDir(dirname(filePath));
        if (entry.readable) {
          const outFile = await Deno.create(filePath);
          await entry.readable.pipeTo(outFile.writable);
        }
      }
    }
  } finally {
    // File is consumed by the stream, no need to close
  }
}

/**
 * Load environment variables from a file.
 */
async function loadEnvFile(filePath: string): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  const content = await Deno.readTextFile(filePath);

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    vars[key] = value;
  }

  return vars;
}

/**
 * Load secrets from local filesystem.
 * Secrets are NEVER transmitted over the network - they must be loaded locally.
 *
 * Priority order:
 * 1. context.secretsPath (from Job config)
 * 2. GLUBEAN_SECRETS_PATH environment variable
 * 3. .env.secrets in bundle directory
 * 4. config.defaultSecretsPath (worker config)
 * 5. Empty (no secrets)
 */
async function loadLocalSecrets(
  context: RuntimeContext,
  bundleDir: string,
  config: WorkerConfig,
  logger: Logger,
): Promise<Record<string, string>> {
  // Try paths in priority order
  const pathsToTry: Array<{ path: string; source: string }> = [];

  // 1. Job-configured path
  if (context.secretsPath) {
    const resolved = context.secretsPath.startsWith("/") ? context.secretsPath : join(bundleDir, context.secretsPath);
    pathsToTry.push({ path: resolved, source: "job.secretsPath" });
  }

  // 2. Environment variable
  const envSecretsPath = Deno.env.get(ENV_VARS.SECRETS_PATH);
  if (envSecretsPath) {
    pathsToTry.push({
      path: envSecretsPath,
      source: "GLUBEAN_SECRETS_PATH env",
    });
  }

  // 3. Bundle directory default
  pathsToTry.push({
    path: join(bundleDir, ".env.secrets"),
    source: "bundle/.env.secrets",
  });

  // 4. Worker config default
  if (config.defaultSecretsPath) {
    pathsToTry.push({
      path: config.defaultSecretsPath,
      source: "worker.defaultSecretsPath",
    });
  }

  // Try each path
  for (const { path, source } of pathsToTry) {
    try {
      const secrets = await loadEnvFile(path);
      if (Object.keys(secrets).length > 0) {
        logger.info("Secrets loaded from local file", {
          source,
          secretCount: Object.keys(secrets).length,
          // Never log secret keys or values for security
        });
        return secrets;
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        logger.warn("Failed to load secrets file", {
          source,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // File not found - try next path
    }
  }

  // No secrets found
  logger.debug("No secrets file found, running without secrets");
  return {};
}

/**
 * Select tests to run based on context selection.
 */
function selectTests(
  metadata: BundleMetadata,
  context: RuntimeContext,
): SelectedTest[] {
  const candidates: SelectedTest[] = [];

  for (const [filePath, meta] of Object.entries(metadata.files)) {
    for (const exp of meta.exports) {
      candidates.push({
        filePath,
        testId: exp.id,
        exportName: exp.exportName,
        tags: exp.tags ?? [],
        timeout: exp.timeout,
      });
    }
  }

  if (!candidates.length) {
    throw new Error("No runnable tests found in bundle metadata");
  }

  const selection = context.selection ?? {};
  const ids = new Set(selection.ids ?? []);
  const tags = new Set(selection.tags ?? []);
  const tagMode = selection.tagMode ?? "any";

  // When both ids and tags are provided, results are combined (union).
  // When only one is provided, only that filter applies.
  // When neither is provided, all tests run.

  const selected = new Map<string, SelectedTest>();
  const add = (candidate: SelectedTest) => {
    selected.set(`${candidate.filePath}:${candidate.testId}`, candidate);
  };

  // Collect by IDs (exact match on testId)
  if (ids.size > 0) {
    for (const candidate of candidates) {
      if (ids.has(candidate.testId)) add(candidate);
    }
  }

  // Collect by tags
  // "any" (default) = OR: test matches if it has ANY of the specified tags
  // "all" = AND: test matches only if it has ALL of the specified tags
  if (tags.size > 0) {
    const matcher = tagMode === "all"
      ? (candidate: SelectedTest) => [...tags].every((tag) => candidate.tags.includes(tag))
      : (candidate: SelectedTest) => candidate.tags.some((tag) => tags.has(tag));
    for (const candidate of candidates) {
      if (matcher(candidate)) add(candidate);
    }
  }

  // Return combined results, or all tests if no filters were specified
  if (selected.size > 0) return Array.from(selected.values());
  if (ids.size > 0 || tags.size > 0) return []; // Filters specified but nothing matched
  return candidates;
}

/**
 * Execute tests from a downloaded bundle.
 */
export async function executeBundle(
  context: RuntimeContext,
  config: WorkerConfig,
  logger: Logger,
  onEvent: OnEvent,
  signal?: AbortSignal,
): Promise<ExecutorResult> {
  const taskDir = join(config.workDir, context.taskId);
  const bundlePath = join(taskDir, "bundle.tar");
  const extractDir = join(taskDir, "bundle");

  let eventCount = 0;
  let seq = 1;
  const now = () => new Date().toISOString();

  const pushEvent = (type: RunEvent["type"], payload: unknown) => {
    const event: RunEvent = {
      runId: context.runId,
      taskId: context.taskId,
      seq: seq++,
      ts: now(),
      type,
      payload,
    };
    eventCount++;
    onEvent(event);
  };

  let success = true;
  let error: string | undefined;
  let aborted = false;
  let timedOut = false;

  try {
    // Create task directory
    await ensureDir(taskDir);

    // Download bundle
    logger.debug("Downloading bundle", { url: context.bundle.download.url });
    await downloadFile(
      context.bundle.download.url,
      bundlePath,
      config.downloadTimeoutMs,
    );
    logger.debug("Bundle downloaded");

    // Verify checksum
    await verifyChecksum(bundlePath, context.bundle.download.checksum, logger);

    // Extract bundle
    await ensureDir(extractDir);
    await extractTar(bundlePath, extractDir);
    logger.debug("Bundle extracted");

    // Read metadata
    const metadataPath = join(extractDir, "metadata.json");
    const metadataContent = await Deno.readTextFile(metadataPath);
    const metadata = JSON.parse(metadataContent) as BundleMetadata;

    const configPath = await findDenoConfigPath(extractDir);
    if (configPath) {
      logger.debug("Using deno config", { configPath });
    }

    // Select tests
    const tests = selectTests(metadata, context);
    logger.info("Tests selected", { count: tests.length });

    // Secrets resolution:
    // - Cloud-managed worker may receive plaintext secrets in RuntimeContext.
    // - Private/self-hosted runner loads secrets locally via secretsPath.
    const secrets = context.secrets && Object.keys(context.secrets).length > 0
      ? context.secrets
      : await loadLocalSecrets(context, extractDir, config, logger);

    if (context.secrets && Object.keys(context.secrets).length > 0) {
      logger.info("Using secrets from runtime context (cloud-managed)", {
        secretCount: Object.keys(context.secrets).length,
      });
    }

    // Create executor with memory limit if configured
    // V8 heap limit helps throw a catchable OOM error before process is killed
    const maxHeapSizeMb = config.taskMemoryLimitBytes > 0
      ? Math.floor(config.taskMemoryLimitBytes / (1024 * 1024))
      : undefined;

    const executor = TestExecutor.fromSharedConfig(config.run, {
      maxHeapSizeMb,
      configPath,
      cwd: extractDir,
      maskEnvPrefixes: ["GLUBEAN_WORKER_TOKEN"],
    });

    // Set up timeout
    const internalAbort = new AbortController();
    const forwardAbort = () => internalAbort.abort();
    signal?.addEventListener("abort", forwardAbort);

    const overallTimeoutMs = context.limits?.timeoutMs ??
      config.taskTimeoutMs;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      internalAbort.abort();
    }, overallTimeoutMs);

    // Determine concurrency
    const requestedConcurrency = context.limits?.requestedConcurrency ??
      config.run.concurrency;
    const maxConcurrency = context.limits?.maxConcurrency ??
      requestedConcurrency;
    const concurrency = Math.min(
      Math.max(1, requestedConcurrency),
      Math.max(1, maxConcurrency),
      tests.length,
    );

    // Derive per-test timeout from overall task deadline (reserve 10% for overhead)
    if (tests.length === 0) {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", forwardAbort);
      return { success: true, eventCount, aborted: false, timedOut: false };
    }
    const derivedPerTestTimeoutMs = Math.floor(
      (overallTimeoutMs * 0.9) / tests.length,
    );

    // Execute tests
    let nextIndex = 0;
    const runNext = async (): Promise<void> => {
      while (!internalAbort.signal.aborted) {
        const index = nextIndex++;
        if (index >= tests.length) return;

        const test = tests[index];
        const testUrl = `file://${join(extractDir, test.filePath)}`;
        const derivedTimeout = derivedPerTestTimeoutMs > 0 ? derivedPerTestTimeoutMs : undefined;
        const explicitTaskTimeout = context.limits?.timeoutMs !== undefined;
        const metaTimeout = normalizePositiveTimeoutMs(test.timeout);
        const configuredTimeout = normalizePositiveTimeoutMs(
          config.run.perTestTimeoutMs,
        );
        // Precedence:
        // 1) Explicit task budget (context.limits.timeoutMs) -> derived per-test budget
        // 2) Test metadata timeout
        // 3) Worker config per-test timeout
        //
        // When an explicit task budget is present, we honor the derived budget
        // to keep the whole task within that hard ceiling.
        const effectiveTimeout = explicitTaskTimeout
          ? derivedTimeout
          : (metaTimeout ?? configuredTimeout ?? derivedTimeout);

        logger.debug("Running test", { testId: test.testId });

        // Map timeline events to run events
        let hasFailedAssertion = false;
        const handleEvent = (event: TimelineEvent) => {
          // Common fields for grouping events by test/step
          const ctx: Record<string, unknown> = {};
          if ("testId" in event && event.testId) ctx.testId = event.testId;
          if ("stepIndex" in event && event.stepIndex !== undefined) {
            ctx.stepIndex = event.stepIndex;
          }

          if (event.type === "log") {
            pushEvent("log", {
              ...ctx,
              level: "info",
              message: event.message,
              data: event.data,
            });
          } else if (event.type === "assertion") {
            pushEvent("assert", {
              ...ctx,
              passed: event.passed,
              message: event.message,
              actual: event.actual,
              expected: event.expected,
            });
            // Track assertion failures
            if (!event.passed) {
              hasFailedAssertion = true;
            }
          } else if (event.type === "trace") {
            pushEvent("trace", { ...ctx, data: event.data });
          } else if (event.type === "metric") {
            pushEvent("metric", {
              ...ctx,
              name: event.name,
              value: event.value,
              unit: event.unit,
              tags: event.tags,
            });
          } else if (event.type === "step_start") {
            pushEvent("step_start", {
              ...ctx,
              index: event.index,
              name: event.name,
            });
          } else if (event.type === "step_end") {
            pushEvent("step_end", {
              ...ctx,
              index: event.index,
              name: event.name,
              status: event.status,
              durationMs: event.durationMs,
              error: event.error,
            });
          } else if (event.type === "summary") {
            pushEvent("summary", event.data);
          }
        };

        try {
          const executionContext = {
            vars: context.vars ?? {},
            // Secrets are loaded locally, never from RuntimeContext
            secrets,
            test: {
              id: test.testId,
              tags: test.tags,
            },
            networkPolicy: toRunnerNetworkPolicy(config),
          };
          const result = await executor.execute(
            testUrl,
            test.exportName,
            executionContext,
            {
              onEvent: handleEvent,
              includeTestId: true,
              timeout: effectiveTimeout,
            },
          );

          // Test fails if: runner reported failure OR any assertion failed
          const testFailed = !result.success || hasFailedAssertion;

          pushEvent("result", {
            status: testFailed ? "failed" : "completed",
            testId: result.testId,
            error: result.error ||
              (hasFailedAssertion ? "Assertion failed" : undefined),
            stack: result.stack,
          });

          if (testFailed) {
            success = false;
            if (!error) {
              error = result.error || "Assertion failed";
            }
            if (config.run.failFast) {
              internalAbort.abort();
              return;
            }
          }
        } catch (err) {
          success = false;
          const message = err instanceof Error ? err.message : String(err);
          if (!error) error = message;
          pushEvent("result", {
            status: "failed",
            testId: test.testId,
            error: message,
          });
          if (config.run.failFast) {
            internalAbort.abort();
            return;
          }
        }
      }
    };

    // Run tests with concurrency
    const workers = Array.from(
      { length: Math.max(1, concurrency) },
      () => runNext(),
    );
    await Promise.all(workers);

    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", forwardAbort);

    // Check if aborted
    if (signal?.aborted || internalAbort.signal.aborted) {
      aborted = true;
      if (timedOut) {
        error = `Execution timed out after ${overallTimeoutMs}ms`;
      } else {
        error = error ?? "Execution aborted";
      }
    }
  } catch (err) {
    success = false;
    error = err instanceof Error ? err.message : String(err);
    logger.error("Execution failed", { error });
  } finally {
    // Clean up task directory
    try {
      await Deno.remove(taskDir, { recursive: true });
      logger.debug("Cleaned up task directory", { taskDir });
    } catch (err) {
      // Log cleanup failures instead of silently ignoring
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("Failed to cleanup task directory", {
        taskDir,
        error: errorMessage,
        warning: "Temporary files may accumulate over time",
      });

      // Attempt to at least remove the bundle file if directory removal failed
      try {
        await Deno.remove(bundlePath).catch(() => {});
      } catch {
        // Best effort
      }
    }
  }

  return { success, eventCount, error, aborted, timedOut };
}
