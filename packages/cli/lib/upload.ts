/**
 * Upload run results and artifacts to Glubean Cloud.
 *
 * Upload flow:
 * 1. POST results JSON to /open/v1/cli-runs → { runId, url }
 * 2. If artifact files exist:
 *    a. Zip artifacts + generate manifest
 *    b. Request signed upload URL
 *    c. PUT zip to signed URL
 *    d. Notify server to extract + index
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RESULTS_TIMEOUT_MS);

    const resp = await fetch(`${apiUrl}/open/v1/cli-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

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

    // Get signed upload URL
    const urlResp = await fetch(
      `${apiUrl}/open/v1/cli-runs/${runId}/artifacts/upload-url`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      },
    );

    if (!urlResp.ok) {
      console.log(
        `${colors.yellow}Artifact upload URL request failed (${urlResp.status})${colors.reset}`,
      );
      return;
    }

    const { signedUrl, archiveKey } = await urlResp.json();

    // Create zip using Deno subprocess (tar + gzip for cross-platform reliability)
    const tmpDir = await Deno.makeTempDir({ prefix: "glubean-artifacts-" });
    const zipPath = join(tmpDir, "artifacts.zip");

    // Copy files to temp staging area with proper structure
    const stagingDir = join(tmpDir, "staging", "files");
    await Deno.mkdir(stagingDir, { recursive: true });

    for (const file of files) {
      const destPath = join(stagingDir, file.relativeName);
      await Deno.mkdir(join(destPath, "..").replace(/\/\.\.$/, ""), {
        recursive: true,
      });
      // Use dirname properly
      const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
      await Deno.mkdir(destDir, { recursive: true });
      await Deno.copyFile(file.path, destPath);
    }

    // Write manifest alongside files
    const manifestPath = join(tmpDir, "staging", "manifest.json");
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));

    // Also upload manifest to storage directly (for server-side extraction)
    const manifestUploadResp = await fetch(
      `${apiUrl}/open/v1/cli-runs/${runId}/artifacts/upload-url`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ key: "manifest.json" }),
      },
    );

    // Create zip
    const zipCmd = new Deno.Command("zip", {
      args: ["-r", zipPath, "."],
      cwd: join(tmpDir, "staging"),
      stdout: "null",
      stderr: "null",
    });
    const zipResult = await zipCmd.output();
    if (!zipResult.success) {
      console.log(
        `${colors.yellow}Failed to create artifact archive${colors.reset}`,
      );
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
      return;
    }

    // Upload zip to signed URL
    const zipData = await Deno.readFile(zipPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARTIFACT_TIMEOUT_MS);

    const putResp = await fetch(signedUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/zip" },
      body: zipData,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!putResp.ok) {
      console.log(
        `${colors.yellow}Artifact upload failed (${putResp.status})${colors.reset}`,
      );
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
      return;
    }

    // Upload manifest separately for server-side indexing
    if (manifestUploadResp.ok) {
      const manifestResult = await manifestUploadResp.json();
      if (manifestResult.signedUrl) {
        const manifestData = new TextEncoder().encode(
          JSON.stringify(manifest),
        );
        await fetch(manifestResult.signedUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: manifestData,
        }).catch(() => {});
      }
    }

    // Upload individual files to storage for direct access
    for (const file of files) {
      try {
        const fileUrlResp = await fetch(
          `${apiUrl}/open/v1/cli-runs/${runId}/artifacts/upload-url`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ key: `files/${file.relativeName}` }),
          },
        );
        if (fileUrlResp.ok) {
          const { signedUrl: fileSignedUrl } = await fileUrlResp.json();
          const ext = extname(file.relativeName);
          const fileData = await Deno.readFile(file.path);
          await fetch(fileSignedUrl, {
            method: "PUT",
            headers: { "Content-Type": extToMime(ext) },
            body: fileData,
          });
        }
      } catch {
        // Best effort — skip individual file upload failures
      }
    }

    // Notify server to extract + index
    await fetch(`${apiUrl}/open/v1/cli-runs/${runId}/artifacts/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ archiveKey }),
    }).catch(() => {});

    const totalSize = manifest.reduce((sum, e) => sum + e.sizeBytes, 0);
    const sizeStr = totalSize > 1024 * 1024
      ? `${(totalSize / 1024 / 1024).toFixed(1)} MB`
      : `${(totalSize / 1024).toFixed(1)} KB`;
    console.log(
      `${colors.green}Artifacts uploaded${colors.reset} ${colors.dim}(${files.length} files, ${sizeStr})${colors.reset}`,
    );

    // Cleanup temp dir
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
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
  }
}
