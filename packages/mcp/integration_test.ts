import { assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import {
  deriveSecretsPath,
  diagnoseProjectConfig,
  discoverTestsFromFile,
  findProjectRoot,
  loadEnvFile,
  runLocalTestsFromFile,
} from "./mod.ts";

const FIXTURE_DIR = resolve(
  new URL(".", import.meta.url).pathname,
  "testdata",
  "simple-project",
);

// When running in the oss workspace, the harness subprocess needs the
// workspace's deno.json to resolve local @glubean/* packages.
// GLUBEAN_DEV_CONFIG tells the executor to use this config instead of
// the test project's deno.json for harness import resolution.
if (!Deno.env.get("GLUBEAN_DEV_CONFIG")) {
  const workspaceRoot = resolve(new URL(".", import.meta.url).pathname, "..", "..");
  Deno.env.set("GLUBEAN_DEV_CONFIG", resolve(workspaceRoot, "deno.json"));
}

// ---------------------------------------------------------------------------
// Layer 1a: Pure helper unit tests
// ---------------------------------------------------------------------------

Deno.test("findProjectRoot walks up to deno.json", async () => {
  const testsDir = resolve(FIXTURE_DIR, "tests");
  const root = await findProjectRoot(testsDir);
  assertEquals(root, FIXTURE_DIR);
});

Deno.test("findProjectRoot returns startDir when no deno.json found", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "mcp-no-root-" });
  try {
    const root = await findProjectRoot(tmpDir);
    assertEquals(root, tmpDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("deriveSecretsPath follows .env → .env.secrets convention", () => {
  assertEquals(deriveSecretsPath("/project/.env"), "/project/.env.secrets");
});

Deno.test("deriveSecretsPath handles named env files", () => {
  assertEquals(
    deriveSecretsPath("/project/.env.staging"),
    "/project/.env.staging.secrets",
  );
});

Deno.test("deriveSecretsPath resolves relative paths", () => {
  const result = deriveSecretsPath("subdir/.env");
  assertEquals(result.endsWith(".env.secrets"), true);
  assertEquals(result.includes("subdir"), true);
});

Deno.test("loadEnvFile parses dotenv content", async () => {
  const envPath = resolve(FIXTURE_DIR, ".env");
  const vars = await loadEnvFile(envPath);
  assertEquals(vars["BASE_URL"], "https://httpbin.org");
});

Deno.test("loadEnvFile returns empty object for missing file", async () => {
  const vars = await loadEnvFile("/nonexistent/.env.nope");
  assertEquals(vars, {});
});

Deno.test("loadEnvFile parses secrets file", async () => {
  const secretsPath = resolve(FIXTURE_DIR, ".env.secrets");
  const secrets = await loadEnvFile(secretsPath);
  assertEquals(secrets["DUMMY_SECRET"], "test-value");
});

// ---------------------------------------------------------------------------
// Layer 1b: discoverTestsFromFile (static analysis, no import needed)
// ---------------------------------------------------------------------------

Deno.test("discoverTestsFromFile finds exported tests", async () => {
  const filePath = resolve(FIXTURE_DIR, "tests", "health.test.ts");
  const { tests, fileUrl } = await discoverTestsFromFile(filePath);

  assertEquals(fileUrl.startsWith("file://"), true);
  assertEquals(tests.length, 1);
  assertEquals(tests[0].id, "health-check");
  assertEquals(tests[0].exportName, "healthCheck");
});

Deno.test("discoverTestsFromFile finds failing test fixture", async () => {
  const filePath = resolve(FIXTURE_DIR, "tests", "failing.test.ts");
  const { tests } = await discoverTestsFromFile(filePath);

  assertEquals(tests.length, 1);
  assertEquals(tests[0].id, "always-fails");
});

// ---------------------------------------------------------------------------
// Layer 1c: runLocalTestsFromFile (spawns subprocess via TestExecutor)
// ---------------------------------------------------------------------------

Deno.test("runLocalTestsFromFile executes passing test", async () => {
  const filePath = resolve(FIXTURE_DIR, "tests", "health.test.ts");
  const result = await runLocalTestsFromFile({ filePath });

  assertEquals(result.summary.total, 1);
  assertEquals(result.summary.passed, 1);
  assertEquals(result.summary.failed, 0);
  assertEquals(result.results.length, 1);
  assertEquals(result.results[0].success, true);
  assertEquals(result.results[0].id, "health-check");

  const passedAssertions = result.results[0].assertions.filter((a: { passed: boolean }) => a.passed);
  assertEquals(passedAssertions.length > 0, true);
});

Deno.test("runLocalTestsFromFile loads env vars from fixture", async () => {
  const filePath = resolve(FIXTURE_DIR, "tests", "health.test.ts");
  const result = await runLocalTestsFromFile({ filePath });

  assertEquals(result.vars["BASE_URL"], "https://httpbin.org");
  assertEquals(result.secrets["DUMMY_SECRET"], "test-value");
  assertEquals(result.projectRoot, FIXTURE_DIR);
});

Deno.test("runLocalTestsFromFile reports failure correctly", async () => {
  const filePath = resolve(FIXTURE_DIR, "tests", "failing.test.ts");
  const result = await runLocalTestsFromFile({ filePath });

  assertEquals(result.summary.total, 1);
  assertEquals(result.summary.passed, 0);
  assertEquals(result.summary.failed, 1);
  assertEquals(result.results[0].success, false);

  const failedAssertions = result.results[0].assertions.filter((a: { passed: boolean }) => !a.passed);
  assertEquals(failedAssertions.length > 0, true);
});

Deno.test("runLocalTestsFromFile returns error for non-matching filter", async () => {
  const filePath = resolve(FIXTURE_DIR, "tests", "health.test.ts");
  const result = await runLocalTestsFromFile({
    filePath,
    filter: "nonexistent-filter",
  });

  assertEquals(result.results.length, 0);
  assertEquals(result.summary.total, 0);
  assertEquals(typeof result.error, "string");
});

// ---------------------------------------------------------------------------
// Layer 1d: diagnoseProjectConfig with real fixture
// ---------------------------------------------------------------------------

Deno.test("diagnoseProjectConfig detects fixture project structure", async () => {
  const diagnostics = await diagnoseProjectConfig({ dir: FIXTURE_DIR });

  assertEquals(diagnostics.projectRoot, FIXTURE_DIR);
  assertEquals(diagnostics.denoJson.exists, true);
  assertEquals(diagnostics.envFile.exists, true);
  assertEquals(diagnostics.envFile.hasBaseUrl, true);
  assertEquals(diagnostics.envFile.varCount, 1);
  assertEquals(diagnostics.secretsFile.exists, true);
  assertEquals(diagnostics.secretsFile.secretCount, 1);
  assertEquals(diagnostics.testsDir.exists, true);
  assertEquals(diagnostics.recommendations.length, 0);
});
