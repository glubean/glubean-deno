/**
 * Glubean CLI - Main entry point
 *
 * Uses Cliffy for structured command handling with automatic help generation,
 * argument validation, and shell completions.
 */

// Support running from outside workspace (e.g. shell alias with GLUBEAN_CWD)
const _cwd = Deno.env.get("GLUBEAN_CWD");
if (_cwd) Deno.chdir(_cwd);

import { Command, EnumType } from "@cliffy/command";
import { initCommand } from "./commands/init.ts";
import { runCommand } from "./commands/run.ts";
import { loadConfig } from "./lib/config.ts";
import { scanCommand } from "./commands/scan.ts";
import { syncCommand } from "./commands/sync.ts";
import { triggerCommand } from "./commands/trigger.ts";
import { validateMetadataCommand } from "./commands/validate_metadata.ts";
import { workerCommand } from "./commands/worker.ts";
import { upgradeCommand } from "./commands/upgrade.ts";
import { loginCommand } from "./commands/login.ts";
import { patchCommand } from "./commands/patch.ts";
import { specSplitCommand } from "./commands/spec_split.ts";
import { CLI_VERSION } from "./version.ts";
import { abortUpdateCheck, checkForUpdates } from "./update_check.ts";

// Custom type for log level validation
const logLevelType = new EnumType(["debug", "info", "warn", "error"]);

// Build the CLI
const cli = new Command()
  .name("glubean")
  .version(CLI_VERSION)
  .description("🫘 Glubean CLI - Run and sync API tests from the command line")
  .globalOption("--no-update-check", "Skip update check")
  .action(() => {
    cli.showHelp();
  });

// ─────────────────────────────────────────────────────────────────────────────
// init command
// ─────────────────────────────────────────────────────────────────────────────
cli
  .command("init", "Initialize a new test project (interactive wizard)")
  .option("--minimal", "Scaffold minimal explore-only project (GET, POST, pick)")
  .option("--hooks", "Install git hooks (pre-commit, pre-push)")
  .option("--github-actions", "Scaffold GitHub Actions workflow")
  .option("--base-url <url:string>", "API base URL for .env")
  .option("--no-interactive", "Disable prompts (use with flags)")
  .option("--overwrite", "Overwrite existing files (dangerous)")
  .option("--overwrite-hooks", "Overwrite existing .git/hooks files")
  .option("--overwrite-actions", "Overwrite GitHub Actions workflow")
  .action(async (options) => {
    await initCommand({
      minimal: options.minimal,
      hooks: options.hooks,
      githubActions: options.githubActions,
      baseUrl: options.baseUrl,
      interactive: options.interactive,
      overwrite: options.overwrite,
      overwriteHooks: options.overwriteHooks,
      overwriteActions: options.overwriteActions,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// run command
// ─────────────────────────────────────────────────────────────────────────────
cli
  .command(
    "run [target:string]",
    "Run tests from a file, directory, or glob pattern (defaults to testDir)",
  )
  .option("--explore", "Run explore tests (from exploreDir instead of testDir)")
  .option(
    "-f, --filter <pattern:string>",
    "Run only tests matching pattern (name or id substring)",
  )
  .option(
    "-t, --tag <tag:string>",
    "Run only tests with matching tag (comma-separated or repeatable)",
    { collect: true },
  )
  .option(
    "--tag-mode <mode:string>",
    'Tag match logic: "or" (any tag) or "and" (all tags)',
    { default: "or" },
  )
  .option("--env-file <path:string>", "Path to .env file", { default: ".env" })
  .option("-l, --log-file", "Write logs to file (<testfile>.log)")
  .option("--pretty", "Pretty-print JSON in log file (2-space indent)")
  .option("--verbose", "Show all output (traces, assertions) in console")
  .option("--fail-fast", "Stop on first test failure")
  .option("--fail-after <count:number>", "Stop after N test failures")
  .option(
    "--result-json [path:string]",
    "Write structured results to .result.json (or custom path)",
  )
  .option(
    "--emit-full-trace",
    "Include full request/response headers and bodies in HTTP traces",
  )
  .option(
    "--config <paths:string>",
    "Config file(s), comma-separated or repeatable (default: deno.json glubean field)",
    { collect: true },
  )
  .option(
    "--pick <keys:string>",
    "Select specific test.pick example(s) by key (comma-separated)",
  )
  .option(
    "--inspect-brk [port:number]",
    "Enable V8 Inspector for debugging (pauses until debugger attaches)",
  )
  .option(
    "--reporter <format:string>",
    'Output format: "junit" or "junit:/path/to/output.xml"',
  )
  .option(
    "--trace-limit <count:number>",
    "Max trace files to keep per test (default: 20)",
  )
  .option(
    "--ci",
    "CI mode: enables --fail-fast and --reporter junit",
  )
  .option("--upload", "Upload run results and artifacts to Glubean Cloud")
  .option(
    "--project <id:string>",
    "Glubean Cloud project ID (or GLUBEAN_PROJECT_ID env)",
  )
  .option(
    "--token <token:string>",
    "Auth token for cloud upload (or GLUBEAN_TOKEN env)",
  )
  .option("--api-url <url:string>", "Glubean API server URL")
  .action(async (options, target?: string) => {
    // Flatten --config values: support both comma-separated and repeated flags
    const configFiles = options.config
      ? (options.config as string[]).flatMap((v: string) =>
        v
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      )
      : undefined;

    // Resolve default target from config when not explicitly provided
    let resolvedTarget = target;
    if (!resolvedTarget) {
      const config = await loadConfig(Deno.cwd(), configFiles);
      resolvedTarget = options.explore ? config.run.exploreDir : config.run.testDir;
    }

    // --ci implies --fail-fast and --reporter junit
    const isCi = options.ci === true;
    const failFast = options.failFast || isCi;
    let reporter = options.reporter;
    let reporterPath: string | undefined;
    if (!reporter && isCi) {
      reporter = "junit";
    }
    // Parse "junit:/path/to/file.xml" syntax
    if (reporter && reporter.startsWith("junit:")) {
      reporterPath = reporter.slice("junit:".length);
      reporter = "junit";
    }

    // --result-json: true (boolean flag), string (custom path), or undefined
    const resultJson = options.resultJson;

    await runCommand(resolvedTarget, {
      filter: options.filter,
      pick: options.pick,
      tags: options.tag?.flatMap((t: string) => t.split(",").map((s: string) => s.trim()).filter(Boolean)),
      tagMode: options.tagMode as "or" | "and",
      envFile: options.envFile,
      logFile: options.logFile,
      pretty: options.pretty,
      verbose: options.verbose,
      failFast,
      failAfter: options.failAfter,
      resultJson,
      emitFullTrace: options.emitFullTrace,
      configFiles,
      inspectBrk: options.inspectBrk,
      reporter,
      reporterPath,
      traceLimit: options.traceLimit,
      upload: options.upload,
      project: options.project,
      token: options.token,
      apiUrl: options.apiUrl,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// scan command
// ─────────────────────────────────────────────────────────────────────────────
cli
  .command("scan", "Generate metadata.json from a directory")
  .option("-d, --dir <path:string>", "Directory to scan", { default: "." })
  .option("--out <path:string>", "Output path for metadata.json")
  .action(async (options) => {
    await scanCommand({
      dir: options.dir,
      output: options.out,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// validate-metadata command
// ─────────────────────────────────────────────────────────────────────────────
cli
  .command("validate-metadata", "Validate metadata.json against local files")
  .option("-d, --dir <path:string>", "Project root", { default: "." })
  .option("--metadata <path:string>", "Path to metadata.json")
  .action(async (options) => {
    await validateMetadataCommand({
      dir: options.dir,
      metadata: options.metadata,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// sync command
// ─────────────────────────────────────────────────────────────────────────────
cli
  .command("sync", "Sync tests to Glubean Cloud")
  .option("-p, --project <id:string>", "Target project ID (required)")
  .option("-t, --tag <version:string>", "Version tag (default: timestamp)")
  .option("-d, --dir <path:string>", "Directory to scan", { default: "." })
  .option("--api-url <url:string>", "API server URL")
  .option("--token <token:string>", "Auth token (or GLUBEAN_TOKEN env)")
  .option("--dry-run", "Generate bundle without uploading")
  .action(async (options) => {
    await syncCommand({
      project: options.project,
      version: options.tag,
      dir: options.dir,
      apiUrl: options.apiUrl,
      token: options.token,
      dryRun: options.dryRun,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// trigger command
// ─────────────────────────────────────────────────────────────────────────────
cli
  .command("trigger", "Trigger a remote run on Glubean Cloud")
  .option("-p, --project <id:string>", "Target project ID (required)")
  .option(
    "-b, --bundle <id:string>",
    "Bundle ID (uses latest if not specified)",
  )
  .option("-j, --job <id:string>", "Job ID")
  .option("-F, --follow", "Tail logs until run completes")
  .option("--api-url <url:string>", "API server URL")
  .option("--token <token:string>", "Auth token (or GLUBEAN_TOKEN env)")
  .action(async (options) => {
    await triggerCommand({
      project: options.project,
      bundle: options.bundle,
      job: options.job,
      apiUrl: options.apiUrl,
      token: options.token,
      follow: options.follow,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// login command
// ─────────────────────────────────────────────────────────────────────────────
cli
  .command("login", "Authenticate with Glubean Cloud")
  .option(
    "--token <token:string>",
    "Auth token (skip interactive prompt)",
  )
  .option(
    "--project <id:string>",
    "Default project ID",
  )
  .option("--api-url <url:string>", "API server URL")
  .action(async (options) => {
    await loginCommand({
      token: options.token,
      project: options.project,
      apiUrl: options.apiUrl,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// patch command
// ─────────────────────────────────────────────────────────────────────────────
cli
  .command(
    "patch <spec:string>",
    "Merge an OpenAPI spec with its .patch.yaml and write the complete spec",
  )
  .option("--patch <file:string>", "Path to patch file (auto-discovered if omitted)")
  .option("-o, --output <file:string>", "Output file path (default: <name>.patched.json)")
  .option("--stdout", "Write to stdout instead of file")
  .option("--format <fmt:string>", 'Output format: "json" or "yaml" (default: same as input)')
  .action(async (options, spec: string) => {
    await patchCommand(spec, {
      patch: options.patch,
      output: options.output,
      stdout: options.stdout,
      format: options.format as "json" | "yaml" | undefined,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// spec command (with subcommands)
// ─────────────────────────────────────────────────────────────────────────────
const specCmd = new Command()
  .description("OpenAPI spec tools")
  .action(() => {
    specCmd.showHelp();
  });

specCmd
  .command(
    "split <spec:string>",
    "Dereference $refs and split spec into per-endpoint files for AI",
  )
  .option("-o, --output <dir:string>", "Output directory (default: <name>-endpoints/ next to spec)")
  .action(async (options, spec: string) => {
    await specSplitCommand(spec, { output: options.output });
  });

cli.command("spec", specCmd);

// ─────────────────────────────────────────────────────────────────────────────
// upgrade command
// ─────────────────────────────────────────────────────────────────────────────
cli
  .command("upgrade", "Upgrade Glubean CLI to the latest version")
  .option("--force", "Force reinstall even if already up to date")
  .action(async (options) => {
    await upgradeCommand({ force: options.force });
  });

// ─────────────────────────────────────────────────────────────────────────────
// worker command (with subcommands)
// ─────────────────────────────────────────────────────────────────────────────
const workerCmd = new Command()
  .description("Self-hosted worker management")
  .action(() => {
    workerCmd.showHelp();
  });

workerCmd
  .command("start", "Start worker instance(s)")
  .option("-n, --instances <count:string>", "Number of instances (or 'auto')", {
    default: "1",
  })
  .option("--config <path:string>", "Worker config file (JSON)")
  .option("--api-url <url:string>", "Control plane URL")
  .option(
    "--token <token:string>",
    "Worker token (or GLUBEAN_WORKER_TOKEN env)",
  )
  .type("log-level", logLevelType)
  .option("--log-level <level:log-level>", "Log level")
  .option(
    "--worker-id <id:string>",
    "Base worker ID (auto-generated if not set)",
  )
  .action(async (options) => {
    let instances: number | "auto" | undefined;
    if (options.instances === "auto") {
      instances = "auto";
    } else {
      const parsed = parseInt(options.instances, 10);
      if (!isNaN(parsed) && parsed >= 1) {
        instances = parsed;
      }
    }

    await workerCommand("start", {
      instances,
      config: options.config,
      apiUrl: options.apiUrl,
      token: options.token,
      logLevel: options.logLevel,
      workerId: options.workerId,
    });
  });

workerCmd.command("help", "Show worker help").action(() => {
  workerCmd.showHelp();
});

cli.command("worker", workerCmd);

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  // Check for updates (non-blocking — don't delay CLI startup)
  if (!Deno.args.includes("--no-update-check")) {
    checkForUpdates(CLI_VERSION).catch(() => {});
  }

  try {
    await cli.parse(Deno.args);
  } catch (error) {
    if (error instanceof Error) {
      // Cliffy validation errors have a nice message
      console.error(`Error: ${error.message}`);
    } else {
      console.error("An unexpected error occurred");
    }
    Deno.exit(1);
  } finally {
    abortUpdateCheck();
  }
}

// Export CLI version for programmatic access
export { CLI_VERSION } from "./version.ts";
