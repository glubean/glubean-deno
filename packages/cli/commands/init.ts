/**
 * Init command - scaffolds a new Glubean test project with a 3-step wizard.
 *
 * Step 1: Project Type — Best Practice or Minimal
 * Step 2: API Setup — Base URL and optional OpenAPI spec (Best Practice only)
 * Step 3: Git & CI — Auto-detect/init git, hooks, GitHub Actions (Best Practice only)
 */

import cliDenoJson from "../deno.json" with { type: "json" };
import { Confirm, Input, Select } from "@cliffy/prompt";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function isInteractive(): boolean {
  return Deno.stdin.isTerminal();
}

/**
 * True when running in a real TTY (not piped stdin).
 * Cliffy prompts (arrow-key selection) only work in a real TTY.
 * Piped stdin (used by tests with GLUBEAN_FORCE_INTERACTIVE=1) falls back
 * to the plain readLine-based helpers.
 */
function useFancyPrompts(): boolean {
  return Deno.stdin.isTerminal();
}

/**
 * Read a line from stdin. Works correctly with both TTY and piped input.
 * Uses Deno's built-in prompt() for TTY (shows prompt text, handles backspace).
 * Falls back to manual stdin read for piped input (prompt() ignores piped data).
 */
function readLine(message: string): string {
  if (Deno.stdin.isTerminal()) {
    return prompt(message) ?? "";
  }
  const encoder = new TextEncoder();
  Deno.stdout.writeSync(encoder.encode(message + " "));
  const buf = new Uint8Array(1);
  const line: number[] = [];
  while (true) {
    const n = Deno.stdin.readSync(buf);
    if (n === null || n === 0) break;
    if (buf[0] === 0x0a) break;
    if (buf[0] !== 0x0d) line.push(buf[0]);
  }
  Deno.stdout.writeSync(encoder.encode("\n"));
  return new TextDecoder().decode(new Uint8Array(line));
}

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  if (useFancyPrompts()) {
    return await Confirm.prompt({ message: question, default: defaultYes });
  }
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  while (true) {
    const input = readLine(`${question} ${hint}`);
    const normalized = input.trim().toLowerCase();
    if (!normalized) return defaultYes;
    if (normalized === "y" || normalized === "yes") return true;
    if (normalized === "n" || normalized === "no") return false;
  }
}

async function promptChoice(
  question: string,
  options: { key: string; label: string; desc: string }[],
  defaultKey: string,
): Promise<string> {
  if (useFancyPrompts()) {
    return await Select.prompt({
      message: question,
      options: options.map((o) => ({
        name: `${o.label}  ${colors.dim}${o.desc}${colors.reset}`,
        value: o.key,
      })),
      default: defaultKey,
    });
  }
  console.log(`  ${question}\n`);
  for (const opt of options) {
    const marker = opt.key === defaultKey ? `${colors.green}❯${colors.reset}` : " ";
    console.log(
      `  ${marker} ${colors.bold}${opt.key}.${colors.reset} ${opt.label}  ${colors.dim}${opt.desc}${colors.reset}`,
    );
  }
  console.log();

  while (true) {
    const input = readLine(
      `  Enter choice ${colors.dim}[${defaultKey}]${colors.reset}`,
    );
    const trimmed = input.trim();
    if (!trimmed) return defaultKey;
    const match = options.find((o) => o.key === trimmed);
    if (match) return match.key;
  }
}

function validateBaseUrl(raw: string): { ok: true; value: string } | {
  ok: false;
  reason: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, reason: "URL cannot be empty." };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: "Must be a valid absolute URL, for example: https://api.example.com",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only http:// and https:// are supported." };
  }

  if (!parsed.hostname) {
    return { ok: false, reason: "Hostname is required (for example: localhost)." };
  }

  const normalized = parsed.toString();
  // Keep pathful URLs as entered (`/v2/` stays `/v2/`) and only trim the
  // synthetic root slash from origin-only URLs to keep env values stable.
  if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
    return { ok: true, value: normalized.slice(0, -1) };
  }
  return { ok: true, value: normalized };
}

function validateBaseUrlOrExit(raw: string, source: string): string {
  const result = validateBaseUrl(raw);
  if (result.ok) return result.value;

  console.error(
    `Invalid base URL from ${source}: ${result.reason}\n` +
      "Example: --base-url https://api.example.com",
  );
  Deno.exit(1);
}

// ---------------------------------------------------------------------------
// File utilities
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readCliTemplate(relativePath: string): Promise<string> {
  const url = new URL(`../templates/${relativePath}`, import.meta.url);
  if (url.protocol === "file:") {
    return await Deno.readTextFile(url);
  }
  // When installed from JSR, import.meta.url is https:// — use fetch
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Failed to load template ${relativePath} (HTTP ${resp.status})`,
    );
  }
  return await resp.text();
}

type FileEntry = {
  path: string;
  content: string | (() => Promise<string>);
  description: string;
};

async function resolveContent(
  content: string | (() => Promise<string>),
): Promise<string> {
  return typeof content === "function" ? await content() : content;
}

// ---------------------------------------------------------------------------
// Templates — Standard project
// ---------------------------------------------------------------------------

function resolveSdkImportVersion(): string {
  const imports = cliDenoJson.imports;
  const sdkImport = imports && typeof imports === "object"
    ? (imports as Record<string, unknown>)["@glubean/sdk"]
    : undefined;
  if (typeof sdkImport !== "string") {
    throw new Error(
      'Unable to resolve "@glubean/sdk" import from packages/cli/deno.json',
    );
  }
  const match = sdkImport.match(/^jsr:@glubean\/sdk@(.+)$/);
  if (!match) {
    throw new Error(
      `Unexpected @glubean/sdk import format in packages/cli/deno.json: ${sdkImport}`,
    );
  }
  return match[1];
}

// Expected source format in packages/cli/deno.json:
// "@glubean/sdk": "jsr:@glubean/sdk@<version>"
const SDK_IMPORT = `jsr:@glubean/sdk@${resolveSdkImportVersion()}`;

function makeDenoJson(_baseUrl: string): string {
  return (
    JSON.stringify(
      {
        imports: {
          "@glubean/sdk": SDK_IMPORT,
        },
        tasks: {
          test: "glubean run",
          "test:verbose": "glubean run --verbose",
          "test:staging": "glubean run --env-file .env.staging",
          "test:log": "glubean run --log-file",
          "test:ci": "glubean run --ci --result-json",
          explore: "glubean run --explore",
          "explore:verbose": "glubean run --explore --verbose",
          scan: "glubean scan",
          "validate-metadata": "glubean validate-metadata",
        },
        glubean: {
          run: {
            verbose: false,
            pretty: true,
            emitFullTrace: false,
            testDir: "./tests",
            exploreDir: "./explore",
          },
          redaction: {
            replacementFormat: "simple",
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function makeEnvFile(baseUrl: string): string {
  return `# Environment variables for tests
BASE_URL=${baseUrl}
`;
}

const ENV_SECRETS = `# Secrets for tests (add this file to .gitignore)
# DummyJSON test credentials (public, safe to use)
USERNAME=emilys
PASSWORD=emilyspass
`;

function makeStagingEnvFile(baseUrl: string): string {
  // Derive staging URL: replace the host or just show a placeholder
  const stagingUrl = baseUrl.replace(/\/\/([^/]+)/, "//staging.$1");
  return `# Staging environment variables
# Usage: glubean run --env-file .env.staging
BASE_URL=${stagingUrl}
`;
}

const ENV_STAGING_SECRETS = `# Staging secrets (gitignored)
# Usage: auto-loaded when --env-file .env.staging is used
# API_KEY=your-staging-api-key
USERNAME=
PASSWORD=
`;

const GITIGNORE = `# Secrets (all env-specific secrets files)
.env.secrets
.env.*.secrets

# Log files
*.log

# Result files (generated by glubean run)
*.result.json

# Deno
.deno/

# Glubean internal
.glubean/
`;

// SAMPLE_TEST removed — now loaded from templates/demo.test.ts

const PRE_COMMIT_HOOK = `#!/bin/sh
set -e

glubean scan

if [ -n "$(git diff --name-only -- metadata.json)" ]; then
  echo "metadata.json updated. Please git add metadata.json"
  exit 1
fi
`;

const PRE_PUSH_HOOK = `#!/bin/sh
set -e

glubean validate-metadata
`;

const GITHUB_ACTION_METADATA = `name: Glubean Metadata

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  metadata:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v1
        with:
          deno-version: v2.x
      - name: Install CLI
        run: deno install -Agf -n glubean jsr:@glubean/cli
      - name: Generate metadata.json
        run: glubean scan
      - name: Verify metadata.json
        run: git diff --exit-code metadata.json
`;

const GITHUB_ACTION_TESTS = `name: Glubean Tests

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v1
        with:
          deno-version: v2.x

      - name: Write secrets
        run: |
          echo "USERNAME=\${{ secrets.USERNAME }}" >> .env.secrets
          echo "PASSWORD=\${{ secrets.PASSWORD }}" >> .env.secrets

      - name: Install CLI
        run: deno install -Agf -n glubean jsr:@glubean/cli

      - name: Run tests
        run: glubean run --ci --result-json

      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: |
            **/*.junit.xml
            **/*.result.json
`;

// ---------------------------------------------------------------------------
// Templates — Minimal project
// ---------------------------------------------------------------------------

const MINIMAL_DENO_JSON = `{
  "imports": {
    "@glubean/sdk": "${SDK_IMPORT}"
  },
  "tasks": {
    "test": "glubean run",
    "test:verbose": "glubean run --verbose",
    "test:staging": "glubean run --env-file .env.staging",
    "test:ci": "glubean run --ci --result-json",
    "explore": "glubean run --explore --verbose",
    "scan": "glubean scan"
  },
  "glubean": {
    "run": {
      "verbose": true,
      "pretty": true,
      "testDir": "./tests",
      "exploreDir": "./explore"
    }
  }
}
`;

const MINIMAL_ENV = `# Environment variables
# Tip: switch environments from the VS Code status bar — one click to toggle
# between default, staging, and any custom .env.* file.
BASE_URL=https://dummyjson.com
`;

const MINIMAL_ENV_SECRETS = `# Secrets (add this file to .gitignore)
# DummyJSON test credentials (public, safe to use)
USERNAME=emilys
PASSWORD=emilyspass
`;

const MINIMAL_ENV_STAGING = `# Staging environment variables
# Usage: glubean run --env-file .env.staging
# Tip: or switch to "staging" from the VS Code status bar — no CLI flags needed.
BASE_URL=https://staging.dummyjson.com
`;

const MINIMAL_ENV_STAGING_SECRETS = `# Staging secrets (gitignored)
# Usage: auto-loaded when --env-file .env.staging is used
# API_KEY=your-staging-api-key
USERNAME=
PASSWORD=
`;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InitOptions {
  minimal?: boolean;
  hooks?: boolean;
  githubActions?: boolean;
  interactive?: boolean;
  overwrite?: boolean;
  overwriteHooks?: boolean;
  overwriteActions?: boolean;
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Main init command — 3-step wizard
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://dummyjson.com";

export async function initCommand(options: InitOptions = {}): Promise<void> {
  console.log(`\n${colors.bold}${colors.cyan}🫘 Glubean Init${colors.reset}\n`);

  const interactive = options.interactive ?? true;
  const forceInteractive = Deno.env.get("GLUBEAN_FORCE_INTERACTIVE") === "1";
  if (interactive && !isInteractive() && !forceInteractive) {
    console.error(
      "Interactive init requires a TTY. Use --no-interactive and pass --hooks/--github-actions flags.",
    );
    Deno.exit(1);
  }

  // ── Step 1/3 — Project Type ──────────────────────────────────────────────

  let isMinimal = options.minimal ?? false;

  if (interactive && !options.minimal) {
    console.log(
      `${colors.dim}━━━ Step 1/3 — Project Type ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
    );
    const choice = await promptChoice(
      "What would you like to create?",
      [
        {
          key: "1",
          label: "Best Practice",
          desc: "Full project with tests, CI, multi-env, and examples",
        },
        {
          key: "2",
          label: "Minimal",
          desc: "Quick start — explore folder with GET, POST, and pick examples",
        },
      ],
      "1",
    );
    isMinimal = choice === "2";
  }

  if (interactive && !options.overwrite) {
    const hasExisting = await fileExists("deno.json") ||
      await fileExists(".env");
    if (hasExisting) {
      console.log(
        `\n  ${colors.yellow}⚠${colors.reset} Existing Glubean files detected in this directory.\n`,
      );
      const overwrite = await promptYesNo(
        "Overwrite existing files?",
        false,
      );
      if (overwrite) {
        options.overwrite = true;
      } else {
        console.log(
          `\n  ${colors.dim}Keeping existing files — new files will still be created${colors.reset}\n`,
        );
      }
    }
  }

  if (isMinimal) {
    await initMinimal(options.overwrite ?? false);
    return;
  }

  // ── Step 2/3 — API Setup ─────────────────────────────────────────────────

  let baseUrl = options.baseUrl ? validateBaseUrlOrExit(options.baseUrl, "--base-url") : DEFAULT_BASE_URL;

  if (interactive) {
    console.log(
      `\n${colors.dim}━━━ Step 2/3 — API Setup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
    );

    if (useFancyPrompts()) {
      const urlInput = await Input.prompt({
        message: "Your API base URL",
        default: DEFAULT_BASE_URL,
        validate: (value) => {
          if (!value.trim()) return true;
          const result = validateBaseUrl(value);
          return result.ok || result.reason;
        },
      });
      if (urlInput.trim() && urlInput !== DEFAULT_BASE_URL) {
        const validated = validateBaseUrl(urlInput);
        if (validated.ok) baseUrl = validated.value;
      }
    } else {
      while (true) {
        const urlInput = readLine(
          `  Your API base URL ${colors.dim}(Enter for ${DEFAULT_BASE_URL})${colors.reset}`,
        );
        if (!urlInput.trim()) break;

        const validated = validateBaseUrl(urlInput);
        if (validated.ok) {
          baseUrl = validated.value;
          break;
        }

        console.log(
          `  ${colors.yellow}⚠${colors.reset} Invalid URL: ${validated.reason}`,
        );
        console.log(
          `  ${colors.dim}Try something like: https://api.example.com${colors.reset}\n`,
        );
      }
    }
    console.log(
      `\n  ${colors.green}✓${colors.reset} Base URL: ${colors.cyan}${baseUrl}${colors.reset}`,
    );
  }

  // ── Step 3/3 — Git & CI ──────────────────────────────────────────────────

  let enableHooks = options.hooks;
  let enableActions = options.githubActions;
  let hasGit = await fileExists(".git");

  if (interactive) {
    console.log(
      `\n${colors.dim}━━━ Step 3/3 — Git & CI ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
    );

    if (!hasGit) {
      console.log(
        `  ${colors.yellow}⚠${colors.reset} No Git repository detected\n`,
      );
      const initGit = await promptYesNo(
        "Initialize Git repository? (recommended — enables hooks and CI)",
        true,
      );
      if (initGit) {
        const cmd = new Deno.Command("git", {
          args: ["init"],
          stdout: "piped",
          stderr: "piped",
        });
        const result = await cmd.output();
        if (result.success) {
          hasGit = true;
          console.log(
            `\n  ${colors.green}✓${colors.reset} Git repository initialized\n`,
          );
        } else {
          console.log(
            `\n  ${colors.yellow}⚠${colors.reset} Failed to initialize Git — skipping hooks and actions\n`,
          );
        }
      } else {
        console.log(
          `\n  ${colors.dim}Skipping Git hooks and GitHub Actions${colors.reset}`,
        );
        console.log(
          `  ${colors.dim}Run "git init && glubean init --hooks --github-actions" later${colors.reset}\n`,
        );
      }
    } else {
      console.log(
        `  ${colors.green}✓${colors.reset} Git repository detected\n`,
      );
    }

    if (hasGit) {
      if (enableHooks === undefined) {
        enableHooks = await promptYesNo(
          "Enable Git hooks? (auto-updates metadata.json on commit)",
          true,
        );
      }
      if (enableActions === undefined) {
        enableActions = await promptYesNo(
          "Enable GitHub Actions? (CI verifies metadata.json on PR)",
          true,
        );
      }
    } else {
      enableHooks = false;
      enableActions = false;
    }
  } else {
    // Non-interactive mode
    if (enableHooks && !hasGit) {
      console.error(
        "Error: --hooks requires a Git repository. Run `git init` first.",
      );
      Deno.exit(1);
    }
    if (enableHooks === undefined) enableHooks = false;
    if (enableActions === undefined) enableActions = false;
  }

  // ── Create files ─────────────────────────────────────────────────────────

  console.log(
    `\n${colors.dim}━━━ Creating project ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
  );

  const files: FileEntry[] = [
    {
      path: "deno.json",
      content: makeDenoJson(baseUrl),
      description: "Deno config with tasks",
    },
    {
      path: ".env",
      content: makeEnvFile(baseUrl),
      description: "Environment variables",
    },
    {
      path: ".env.secrets",
      content: ENV_SECRETS,
      description: "Secret variables",
    },
    {
      path: ".env.staging",
      content: makeStagingEnvFile(baseUrl),
      description: "Staging environment variables",
    },
    {
      path: ".env.staging.secrets",
      content: ENV_STAGING_SECRETS,
      description: "Staging secret variables",
    },
    {
      path: ".gitignore",
      content: GITIGNORE,
      description: "Git ignore rules",
    },
    {
      path: "README.md",
      content: () => readCliTemplate("README.md"),
      description: "Project README",
    },
    {
      path: "context/openapi.sample.json",
      content: () => readCliTemplate("openapi.sample.json"),
      description: "Sample OpenAPI spec (mock)",
    },
    {
      path: "tests/demo.test.ts",
      content: () => readCliTemplate("demo.test.ts.tpl"),
      description: "Demo tests (rich output for dashboard preview)",
    },
    {
      path: "tests/data-driven.test.ts",
      content: () => readCliTemplate("data-driven.test.ts.tpl"),
      description: "Data-driven test examples (JSON, CSV, YAML)",
    },
    {
      path: "tests/pick.test.ts",
      content: () => readCliTemplate("pick.test.ts.tpl"),
      description: "Example selection with test.pick (inline + JSON)",
    },
    {
      path: "data/users.json",
      content: () => readCliTemplate("data/users.json"),
      description: "Sample JSON test data",
    },
    {
      path: "data/endpoints.csv",
      content: () => readCliTemplate("data/endpoints.csv"),
      description: "Sample CSV test data",
    },
    {
      path: "data/scenarios.yaml",
      content: () => readCliTemplate("data/scenarios.yaml"),
      description: "Sample YAML test data",
    },
    {
      path: "data/create-user.json",
      content: () => readCliTemplate("data/create-user.json"),
      description: "Named examples for test.pick",
    },
    {
      path: "explore/api.test.ts",
      content: () => readCliTemplate("minimal-api.test.ts.tpl"),
      description: "Explore — GET and POST basics",
    },
    {
      path: "explore/search.test.ts",
      content: () => readCliTemplate("minimal-search.test.ts.tpl"),
      description: "Explore — parameterized search with test.pick",
    },
    {
      path: "explore/auth.test.ts",
      content: () => readCliTemplate("minimal-auth.test.ts.tpl"),
      description: "Explore — multi-step auth flow",
    },
    {
      path: "data/search-examples.json",
      content: () => readCliTemplate("data/search-examples.json"),
      description: "Search examples for test.pick",
    },
    {
      path: "CLAUDE.md",
      content: () => readCliTemplate("AI-INSTRUCTIONS.md"),
      description: "AI instructions (Claude Code, Cursor)",
    },
    {
      path: "AGENTS.md",
      content: () => readCliTemplate("AI-INSTRUCTIONS.md"),
      description: "AI instructions (Codex, other agents)",
    },
  ];

  if (enableHooks) {
    files.push(
      {
        path: ".git/hooks/pre-commit",
        content: PRE_COMMIT_HOOK,
        description: "Git pre-commit hook",
      },
      {
        path: ".git/hooks/pre-push",
        content: PRE_PUSH_HOOK,
        description: "Git pre-push hook",
      },
    );
  }

  if (enableActions) {
    files.push(
      {
        path: ".github/workflows/glubean-metadata.yml",
        content: GITHUB_ACTION_METADATA,
        description: "GitHub Actions metadata workflow",
      },
      {
        path: ".github/workflows/glubean-tests.yml",
        content: GITHUB_ACTION_TESTS,
        description: "GitHub Actions test workflow",
      },
    );
  }

  let created = 0;
  let skipped = 0;
  let overwritten = 0;

  const shouldOverwrite = (path: string): boolean => {
    if (options.overwrite) return true;
    if (options.overwriteHooks && path.startsWith(".git/hooks/")) return true;
    if (
      options.overwriteActions &&
      path.startsWith(".github/workflows/glubean-")
    ) {
      return true;
    }
    return false;
  };

  for (const file of files) {
    const existedBefore = await fileExists(file.path);
    if (existedBefore) {
      if (!shouldOverwrite(file.path)) {
        console.log(
          `  ${colors.dim}skip${colors.reset}  ${file.path} (already exists)`,
        );
        skipped++;
        continue;
      }
    }

    const parentDir = file.path.substring(0, file.path.lastIndexOf("/"));
    if (parentDir) {
      await Deno.mkdir(parentDir, { recursive: true });
    }
    const content = await resolveContent(file.content);
    await Deno.writeTextFile(file.path, content);
    if (file.path.startsWith(".git/hooks/")) {
      try {
        await Deno.chmod(file.path, 0o755);
      } catch {
        // Ignore chmod errors on unsupported platforms
      }
    }
    if (existedBefore && shouldOverwrite(file.path)) {
      console.log(
        `  ${colors.yellow}overwrite${colors.reset} ${file.path} - ${file.description}`,
      );
      overwritten++;
    } else {
      console.log(
        `  ${colors.green}create${colors.reset} ${file.path} - ${file.description}`,
      );
      created++;
    }
  }

  console.log(
    `\n${colors.bold}Summary:${colors.reset} ${created} created, ${overwritten} overwritten, ${skipped} skipped\n`,
  );

  if (created > 0) {
    console.log(`${colors.bold}Next steps:${colors.reset}`);
    console.log(
      `  1. Run ${colors.cyan}deno task test${colors.reset} to run all tests in tests/`,
    );
    console.log(
      `  2. Run ${colors.cyan}deno task test:verbose${colors.reset} for detailed output`,
    );
    console.log(
      `  3. Run ${colors.cyan}deno task explore${colors.reset} to run explore/ tests`,
    );
    console.log(
      `  4. Keep ${colors.cyan}CLAUDE.md${colors.reset} or ${colors.cyan}AGENTS.md${colors.reset} — delete whichever you don't need`,
    );
    console.log(
      `  5. Drop your OpenAPI spec in ${colors.cyan}context/${colors.reset} for AI-assisted test writing\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Minimal init
// ---------------------------------------------------------------------------

async function initMinimal(overwrite: boolean): Promise<void> {
  console.log(
    `${colors.dim}  Quick start — explore APIs with GET, POST, and pick examples${colors.reset}\n`,
  );

  const files: FileEntry[] = [
    {
      path: "deno.json",
      content: MINIMAL_DENO_JSON,
      description: "Deno config with explore task",
    },
    {
      path: ".env",
      content: MINIMAL_ENV,
      description: "Environment variables",
    },
    {
      path: ".env.secrets",
      content: MINIMAL_ENV_SECRETS,
      description: "Secret variables (placeholder)",
    },
    {
      path: ".env.staging",
      content: MINIMAL_ENV_STAGING,
      description: "Staging environment variables",
    },
    {
      path: ".env.staging.secrets",
      content: MINIMAL_ENV_STAGING_SECRETS,
      description: "Staging secret variables",
    },
    {
      path: ".gitignore",
      content: GITIGNORE,
      description: "Git ignore rules",
    },
    {
      path: "README.md",
      content: () => readCliTemplate("minimal/README.md"),
      description: "Project README",
    },
    {
      path: "tests/demo.test.ts",
      content: () => readCliTemplate("demo.test.ts.tpl"),
      description: "Demo tests (GET, POST, auth flow, pagination)",
    },
    {
      path: "explore/api.test.ts",
      content: () => readCliTemplate("minimal-api.test.ts.tpl"),
      description: "GET and POST examples",
    },
    {
      path: "explore/search.test.ts",
      content: () => readCliTemplate("minimal-search.test.ts.tpl"),
      description: "Parameterized search with test.pick",
    },
    {
      path: "explore/auth.test.ts",
      content: () => readCliTemplate("minimal-auth.test.ts.tpl"),
      description: "Multi-step auth flow (login → profile)",
    },
    {
      path: "data/search-examples.json",
      content: () => readCliTemplate("data/search-examples.json"),
      description: "Search parameters for pick examples",
    },
    {
      path: "CLAUDE.md",
      content: () => readCliTemplate("AI-INSTRUCTIONS.md"),
      description: "AI instructions (Claude Code, Cursor)",
    },
    {
      path: "AGENTS.md",
      content: () => readCliTemplate("AI-INSTRUCTIONS.md"),
      description: "AI instructions (Codex, other agents)",
    },
  ];

  let created = 0;
  let skipped = 0;
  let overwritten = 0;

  for (const file of files) {
    const existedBefore = await fileExists(file.path);
    if (existedBefore && !overwrite) {
      console.log(
        `  ${colors.dim}skip${colors.reset}  ${file.path} (already exists)`,
      );
      skipped++;
      continue;
    }

    const parentDir = file.path.substring(0, file.path.lastIndexOf("/"));
    if (parentDir) {
      await Deno.mkdir(parentDir, { recursive: true });
    }
    const content = await resolveContent(file.content);
    await Deno.writeTextFile(file.path, content);

    if (existedBefore) {
      console.log(
        `  ${colors.yellow}overwrite${colors.reset} ${file.path} - ${file.description}`,
      );
      overwritten++;
    } else {
      console.log(
        `  ${colors.green}create${colors.reset} ${file.path} - ${file.description}`,
      );
      created++;
    }
  }

  console.log(
    `\n${colors.bold}Summary:${colors.reset} ${created} created, ${overwritten} overwritten, ${skipped} skipped\n`,
  );

  if (created > 0) {
    console.log(`${colors.bold}Next steps:${colors.reset}`);
    console.log(
      `  1. Run ${colors.cyan}deno task explore${colors.reset} to run all explore tests`,
    );
    console.log(
      `  2. Open ${colors.cyan}explore/api.test.ts${colors.reset} — GET and POST basics`,
    );
    console.log(
      `  3. Open ${colors.cyan}explore/search.test.ts${colors.reset} — pick examples with external data`,
    );
    console.log(
      `  4. Open ${colors.cyan}explore/auth.test.ts${colors.reset} — multi-step flow with state`,
    );
    console.log(
      `  5. Read ${colors.cyan}README.md${colors.reset} for links and next steps\n`,
    );
  }
}
