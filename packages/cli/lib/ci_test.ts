import { assertEquals } from "@std/assert";
import { detectCiContext } from "./ci.ts";

/**
 * Tests for CI environment detection.
 *
 * Each test stubs the relevant env vars, calls detectCiContext(),
 * and verifies the returned CiContext fields.
 *
 * Note: Deno.env.set/delete mutate the process environment, so we
 * save and restore original values to avoid cross-test leaks.
 */

const CI_ENV_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_REF_NAME",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_SERVER_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ID",
  "GITLAB_CI",
  "CI_COMMIT_REF_NAME",
  "CI_COMMIT_SHA",
  "CI_PIPELINE_URL",
  "CIRCLECI",
  "CIRCLE_BRANCH",
  "CIRCLE_TAG",
  "CIRCLE_SHA1",
  "CIRCLE_BUILD_URL",
  "BUILDKITE",
  "BUILDKITE_BRANCH",
  "BUILDKITE_COMMIT",
  "BUILDKITE_BUILD_URL",
  "JENKINS_URL",
];

function saveEnv(): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const key of CI_ENV_KEYS) {
    saved.set(key, Deno.env.get(key));
  }
  return saved;
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
}

function clearCiEnv(): void {
  for (const key of CI_ENV_KEYS) {
    Deno.env.delete(key);
  }
}

Deno.test("detectCiContext: returns source=cli when no CI env vars", () => {
  const saved = saveEnv();
  try {
    clearCiEnv();
    const ctx = detectCiContext();
    assertEquals(ctx.isCI, false);
    assertEquals(ctx.source, "cli");
    assertEquals(ctx.gitRef, undefined);
    assertEquals(ctx.commitSha, undefined);
    assertEquals(ctx.runUrl, undefined);
  } finally {
    restoreEnv(saved);
  }
});

Deno.test("detectCiContext: detects GitHub Actions", () => {
  const saved = saveEnv();
  try {
    clearCiEnv();
    Deno.env.set("CI", "true");
    Deno.env.set("GITHUB_ACTIONS", "true");
    Deno.env.set("GITHUB_REF_NAME", "main");
    Deno.env.set("GITHUB_SHA", "abc123def");
    Deno.env.set("GITHUB_SERVER_URL", "https://github.com");
    Deno.env.set("GITHUB_REPOSITORY", "org/repo");
    Deno.env.set("GITHUB_RUN_ID", "42");

    const ctx = detectCiContext();
    assertEquals(ctx.isCI, true);
    assertEquals(ctx.source, "ci");
    assertEquals(ctx.gitRef, "main");
    assertEquals(ctx.commitSha, "abc123def");
    assertEquals(
      ctx.runUrl,
      "https://github.com/org/repo/actions/runs/42",
    );
  } finally {
    restoreEnv(saved);
  }
});

Deno.test("detectCiContext: detects GitLab CI", () => {
  const saved = saveEnv();
  try {
    clearCiEnv();
    Deno.env.set("CI", "true");
    Deno.env.set("GITLAB_CI", "true");
    Deno.env.set("CI_COMMIT_REF_NAME", "develop");
    Deno.env.set("CI_COMMIT_SHA", "deadbeef");
    Deno.env.set("CI_PIPELINE_URL", "https://gitlab.com/org/repo/-/pipelines/99");

    const ctx = detectCiContext();
    assertEquals(ctx.isCI, true);
    assertEquals(ctx.source, "ci");
    assertEquals(ctx.gitRef, "develop");
    assertEquals(ctx.commitSha, "deadbeef");
    assertEquals(ctx.runUrl, "https://gitlab.com/org/repo/-/pipelines/99");
  } finally {
    restoreEnv(saved);
  }
});

Deno.test("detectCiContext: detects CircleCI", () => {
  const saved = saveEnv();
  try {
    clearCiEnv();
    Deno.env.set("CI", "true");
    Deno.env.set("CIRCLECI", "true");
    Deno.env.set("CIRCLE_BRANCH", "feature/x");
    Deno.env.set("CIRCLE_SHA1", "cafebabe");
    Deno.env.set("CIRCLE_BUILD_URL", "https://circleci.com/gh/org/repo/123");

    const ctx = detectCiContext();
    assertEquals(ctx.isCI, true);
    assertEquals(ctx.source, "ci");
    assertEquals(ctx.gitRef, "feature/x");
    assertEquals(ctx.commitSha, "cafebabe");
    assertEquals(ctx.runUrl, "https://circleci.com/gh/org/repo/123");
  } finally {
    restoreEnv(saved);
  }
});

Deno.test("detectCiContext: detects Buildkite", () => {
  const saved = saveEnv();
  try {
    clearCiEnv();
    Deno.env.set("BUILDKITE", "true");
    Deno.env.set("BUILDKITE_BRANCH", "release/v1");
    Deno.env.set("BUILDKITE_COMMIT", "12345678");
    Deno.env.set("BUILDKITE_BUILD_URL", "https://buildkite.com/org/pipeline/builds/55");

    const ctx = detectCiContext();
    assertEquals(ctx.isCI, true);
    assertEquals(ctx.source, "ci");
    assertEquals(ctx.gitRef, "release/v1");
    assertEquals(ctx.commitSha, "12345678");
    assertEquals(ctx.runUrl, "https://buildkite.com/org/pipeline/builds/55");
  } finally {
    restoreEnv(saved);
  }
});

Deno.test("detectCiContext: generic CI=true without provider-specific vars", () => {
  const saved = saveEnv();
  try {
    clearCiEnv();
    Deno.env.set("CI", "true");

    const ctx = detectCiContext();
    assertEquals(ctx.isCI, true);
    assertEquals(ctx.source, "ci");
    assertEquals(ctx.gitRef, undefined);
    assertEquals(ctx.commitSha, undefined);
    assertEquals(ctx.runUrl, undefined);
  } finally {
    restoreEnv(saved);
  }
});
