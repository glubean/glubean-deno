/**
 * Upload run results and artifacts to Glubean Cloud.
 *
 * Upload flow:
 * 1. POST results JSON to /open/v1/cli-runs → { runId, url }
 * 2. If artifact files exist, build a single zip (manifest.json + files/):
 *    a. zip < 512KB → POST multipart to /artifacts/upload (inline, 1 request)
 *    b. zip ≥ 512KB → POST /artifacts/upload { size } → PUT zip to signed URL
 *       → POST /artifacts/upload/complete (3 requests)
 */

import { walk } from "@std/fs/walk";
import { basename, extname, join, relative } from "@std/path";
import { CLI_VERSION } from "../version.ts";
import { detectCiContext } from "./ci.ts";

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
};

const RESULTS_TIMEOUT_MS = 5_000;
const ARTIFACT_TIMEOUT_MS = 30_000;
const INLINE_THRESHOLD = 512 * 1024; // 512KB
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 1_000;

async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  retries = MAX_RETRIES,
): Promise<Response> {
  const { timeoutMs, ...fetchInit } = init;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const resp = await fetch(url, { ...fetchInit, signal: controller.signal });
      if (timeout) clearTimeout(timeout);
      // Retry on 5xx server errors
      if (resp.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return resp;
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
  // Unreachable, but TypeScript needs it
  throw new Error("fetchWithRetry exhausted");
}

export interface UploadResultPayload {
  target?: string;
  files?: string[];
  runAt: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
    stats?: unknown;
  };
  tests: Array<{
    testId: string;
    testName: string;
    success: boolean;
    durationMs: number;
    tags?: string[];
    events?: unknown[];
  }>;
}

export interface UploadOptions {
  apiUrl: string;
  token: string;
  projectId: string;
  envFile?: string;
  rootDir: string;
}

interface ManifestEntry {
  name: string;
  artifactType: string;
  mimeType: string;
  sizeBytes: number;
  stepIndex?: number;
  testId?: string;
}

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".html": "text/html",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".har": "application/json",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".log": "text/plain",
    ".xml": "application/xml",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

function extToArtifactType(ext: string): string {
  const map: Record<string, string> = {
    ".png": "screenshot",
    ".jpg": "screenshot",
    ".jpeg": "screenshot",
    ".gif": "screenshot",
    ".webp": "screenshot",
    ".html": "html",
    ".har": "har",
    ".json": "data",
    ".jsonl": "data",
    ".csv": "data",
    ".txt": "log",
    ".log": "log",
    ".xml": "report",
  };
  return map[ext.toLowerCase()] ?? "other";
}

/**
 * Upload run results and optionally artifacts to Glubean Cloud.
 * All operations are best-effort — failures print a warning but never throw.
 */
export async function uploadToCloud(
  resultPayload: UploadResultPayload,
  options: UploadOptions,
): Promise<void> {
  const { apiUrl, token, projectId, rootDir } = options;

  const ci = detectCiContext();

  // ── Step 1: Upload results JSON ──

  const body = {
    projectId,
    source: ci.source,
    clientVersion: CLI_VERSION,
    environment: options.envFile ? basename(options.envFile, extname(options.envFile)) : undefined,
    gitRef: ci.gitRef,
    commitSha: ci.commitSha,
    runUrl: ci.runUrl,
    runAt: resultPayload.runAt,
    target: resultPayload.target,
    files: resultPayload.files,
    denoVersion: Deno.version.deno,
    os: Deno.build.os,
    summary: resultPayload.summary,
    tests: resultPayload.tests,
  };

  let runId: string;
  let runUrl: string;
  try {
    const resp = await fetchWithRetry(`${apiUrl}/open/v1/cli-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      timeoutMs: RESULTS_TIMEOUT_MS,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.log(
        `${colors.yellow}Upload failed (${resp.status}): ${errText}${colors.reset}`,
      );
      return;
    }

    const result = await resp.json();
    runId = result.runId;
    runUrl = result.url;
    console.log(
      `${colors.green}Results uploaded${colors.reset} ${colors.dim}→ ${runUrl}${colors.reset}`,
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.log(`${colors.yellow}Upload timed out${colors.reset}`);
    } else {
      console.log(
        `${colors.yellow}Upload failed: ${err instanceof Error ? err.message : err}${colors.reset}`,
      );
    }
    return;
  }

  // ── Step 2: Upload artifacts (if any) ──

  const artifactDirs = [
    join(rootDir, ".glubean", "artifacts"),
    join(rootDir, ".glubean", "screenshots"),
  ];

  const files: { path: string; relativeName: string }[] = [];
  for (const dir of artifactDirs) {
    try {
      for await (const entry of walk(dir, { includeDirs: false })) {
        files.push({
          path: entry.path,
          relativeName: relative(join(rootDir, ".glubean"), entry.path),
        });
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  if (files.length === 0) return;

  let tmpDir: string | undefined;
  try {
    // Build manifest
    const manifest: ManifestEntry[] = [];
    for (const file of files) {
      const stat = await Deno.stat(file.path);
      const ext = extname(file.relativeName);
      manifest.push({
        name: file.relativeName,
        artifactType: extToArtifactType(ext),
        mimeType: extToMime(ext),
        sizeBytes: stat.size,
      });
    }

    // Stage files + manifest into temp dir, then zip
    tmpDir = await Deno.makeTempDir({ prefix: "glubean-artifacts-" });
    const stagingDir = join(tmpDir, "staging");
    const filesDir = join(stagingDir, "files");
    await Deno.mkdir(filesDir, { recursive: true });

    for (const file of files) {
      const destPath = join(filesDir, file.relativeName);
      const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
      await Deno.mkdir(destDir, { recursive: true });
      await Deno.copyFile(file.path, destPath);
    }

    await Deno.writeTextFile(
      join(stagingDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    const zipPath = join(tmpDir, "artifacts.zip");
    const zipCmd = new Deno.Command("zip", {
      args: ["-r", zipPath, "."],
      cwd: stagingDir,
      stdout: "null",
      stderr: "null",
    });
    const zipResult = await zipCmd.output();
    if (!zipResult.success) {
      console.log(
        `${colors.yellow}Failed to create artifact archive${colors.reset}`,
      );
      return;
    }

    const zipData = await Deno.readFile(zipPath);
    const zipSize = zipData.byteLength;

    if (zipSize < INLINE_THRESHOLD) {
      // ── Inline mode: POST multipart with zip ──
      await uploadArtifactsInline(apiUrl, token, runId, zipData);
    } else {
      // ── Presigned mode: get signed URL → PUT → complete ──
      await uploadArtifactsPresigned(apiUrl, token, runId, zipData, zipSize);
    }

    const totalSize = manifest.reduce((sum, e) => sum + e.sizeBytes, 0);
    const sizeStr = totalSize > 1024 * 1024
      ? `${(totalSize / 1024 / 1024).toFixed(1)} MB`
      : `${(totalSize / 1024).toFixed(1)} KB`;
    console.log(
      `${colors.green}Artifacts uploaded${colors.reset} ${colors.dim}(${files.length} files, ${sizeStr})${colors.reset}`,
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.log(
        `${colors.yellow}Artifact upload timed out${colors.reset}`,
      );
    } else {
      console.log(
        `${colors.yellow}Artifact upload failed: ${err instanceof Error ? err.message : err}${colors.reset}`,
      );
    }
  } finally {
    if (tmpDir) {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  }
}

/**
 * Inline upload: POST multipart with zip file directly to server.
 * Server extracts and indexes in-place. Single request.
 */
async function uploadArtifactsInline(
  apiUrl: string,
  token: string,
  runId: string,
  zipData: Uint8Array,
): Promise<void> {
  const form = new FormData();
  form.append(
    "archive",
    new Blob([zipData.buffer as ArrayBuffer], { type: "application/zip" }),
    "artifacts.zip",
  );

  const resp = await fetchWithRetry(
    `${apiUrl}/open/v1/cli-runs/${runId}/artifacts/upload`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      timeoutMs: ARTIFACT_TIMEOUT_MS,
    },
  );

  if (!resp.ok) {
    const errText = await resp.text();
    console.log(
      `${colors.yellow}Artifact upload failed (${resp.status}): ${errText}${colors.reset}`,
    );
  }
}

/**
 * Presigned upload: get signed URL → PUT zip → POST complete.
 * Three requests total.
 */
async function uploadArtifactsPresigned(
  apiUrl: string,
  token: string,
  runId: string,
  zipData: Uint8Array,
  zipSize: number,
): Promise<void> {
  // 1. Request presigned URL
  const form = new FormData();
  form.append("size", String(zipSize));

  const urlResp = await fetchWithRetry(
    `${apiUrl}/open/v1/cli-runs/${runId}/artifacts/upload`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      timeoutMs: RESULTS_TIMEOUT_MS,
    },
  );

  if (!urlResp.ok) {
    const errText = await urlResp.text();
    console.log(
      `${colors.yellow}Artifact upload URL request failed (${urlResp.status}): ${errText}${colors.reset}`,
    );
    return;
  }

  const { signedUrl, archiveKey } = await urlResp.json();

  // 2. PUT zip to signed URL
  const putResp = await fetchWithRetry(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/zip" },
    body: zipData as unknown as BodyInit,
    timeoutMs: ARTIFACT_TIMEOUT_MS,
  });

  if (!putResp.ok) {
    console.log(
      `${colors.yellow}Artifact upload failed (${putResp.status})${colors.reset}`,
    );
    return;
  }

  // 3. Notify server to extract + index
  await fetchWithRetry(
    `${apiUrl}/open/v1/cli-runs/${runId}/artifacts/upload/complete`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ archiveKey }),
      timeoutMs: RESULTS_TIMEOUT_MS,
    },
  );
}
