import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import cliDenoJson from "../deno.json" with { type: "json" };

/**
 * Tests for the init command (3-step wizard).
 */

const EXPECTED_SDK_IMPORT = (
  cliDenoJson.imports as Record<string, string>
)["@glubean/sdk"];

async function createTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "glubean-init-test-" });
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runInitCommand(
  dir: string,
  args: string[] = [],
  stdinText?: string,
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "packages/cli/mod.ts"),
      "init",
      ...args,
    ],
    cwd: dir,
    // Merge extra env with current env to preserve PATH, HOME, etc.
    env: extraEnv ? { ...Deno.env.toObject(), ...extraEnv } : undefined,
    stdin: stdinText ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });

  const child = command.spawn();
  if (stdinText && child.stdin) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdinText));
    await writer.close();
  }
  const status = await child.status;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  return {
    code: status.code,
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// Non-interactive tests (--no-interactive)
// ---------------------------------------------------------------------------

Deno.test("init --no-interactive creates basic project files", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runInitCommand(dir, ["--no-interactive"]);
    assertEquals(code, 0, "init command should succeed");

    // Check that basic files were created
    assertEquals(await fileExists(join(dir, "deno.json")), true);
    assertEquals(await fileExists(join(dir, ".env")), true);
    assertEquals(await fileExists(join(dir, ".env.secrets")), true);
    assertEquals(await fileExists(join(dir, ".gitignore")), true);
    assertEquals(await fileExists(join(dir, "README.md")), true);
    assertEquals(
      await fileExists(join(dir, "context/openapi.sample.json")),
      true,
    );
    assertEquals(await fileExists(join(dir, "tests/demo.test.ts")), true);
    assertEquals(
      await fileExists(join(dir, "tests/data-driven.test.ts")),
      true,
    );
    assertEquals(await fileExists(join(dir, "tests/pick.test.ts")), true);
    assertEquals(await fileExists(join(dir, "data/create-user.json")), true);
    assertEquals(
      await fileExists(join(dir, "data/search-examples.json")),
      true,
    );
    assertEquals(await fileExists(join(dir, "CLAUDE.md")), true);
    assertEquals(await fileExists(join(dir, "AGENTS.md")), true);

    // Explore files
    assertEquals(await fileExists(join(dir, "explore/api.test.ts")), true);
    assertEquals(await fileExists(join(dir, "explore/search.test.ts")), true);
    assertEquals(await fileExists(join(dir, "explore/auth.test.ts")), true);

    // Verify deno.json content
    const denoJson = JSON.parse(
      await Deno.readTextFile(join(dir, "deno.json")),
    );
    assertEquals(
      denoJson.imports?.["@glubean/sdk"],
      EXPECTED_SDK_IMPORT,
    );
    assertEquals(typeof denoJson.tasks?.scan, "string");
    assertEquals(typeof denoJson.tasks?.["validate-metadata"], "string");

    // Verify .env contains default base URL
    const envContent = await Deno.readTextFile(join(dir, ".env"));
    assertEquals(envContent.includes("https://dummyjson.com"), true);

    // Verify sample test uses builder API and ctx.http
    const testContent = await Deno.readTextFile(
      join(dir, "tests/demo.test.ts"),
    );
    assertEquals(testContent.includes("ctx.http"), true);
    assertEquals(
      testContent.includes(".step("),
      true,
      "Sample test should demonstrate builder API with .step()",
    );
    assertEquals(
      testContent.includes(".build()"),
      false,
      "Sample test should NOT include .build() (auto-finalized)",
    );
    assertEquals(
      testContent.includes("ctx.trace({"),
      false,
      "Sample test should use ctx.http auto-tracing, not manual ctx.trace() calls",
    );
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("init --no-interactive --base-url uses custom URL", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runInitCommand(dir, [
      "--no-interactive",
      "--base-url",
      "https://api.example.com",
    ]);
    assertEquals(code, 0, "init command should succeed");

    // Verify .env contains custom base URL
    const envContent = await Deno.readTextFile(join(dir, ".env"));
    assertEquals(envContent.includes("https://api.example.com"), true);

    // Verify deno.json was created
    assertEquals(await fileExists(join(dir, "deno.json")), true);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("init --no-interactive --base-url accepts localhost URL", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runInitCommand(dir, [
      "--no-interactive",
      "--base-url",
      "http://localhost:3000",
    ]);
    assertEquals(code, 0, "init command should succeed");

    const envContent = await Deno.readTextFile(join(dir, ".env"));
    assertEquals(envContent.includes("BASE_URL=http://localhost:3000"), true);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("init --no-interactive --base-url rejects malformed URL", async () => {
  const dir = await createTempDir();
  try {
    const { code, stderr } = await runInitCommand(dir, [
      "--no-interactive",
      "--base-url",
      "not-a-url",
    ]);
    assertEquals(code, 1, "init command should fail with invalid base URL");
    assertEquals(await fileExists(join(dir, "deno.json")), false);
    assertStringIncludes(stderr, "Invalid base URL from --base-url");
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("init --no-interactive --base-url rejects unsupported protocol", async () => {
  const dir = await createTempDir();
  try {
    const { code, stderr } = await runInitCommand(dir, [
      "--no-interactive",
      "--base-url",
      "ftp://example.com",
    ]);
    assertEquals(code, 1, "init command should fail with unsupported protocol");
    assertEquals(await fileExists(join(dir, "deno.json")), false);
    assertStringIncludes(stderr, "Only http:// and https:// are supported");
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("init --no-interactive skips existing files", async () => {
  const dir = await createTempDir();
  try {
    // Create a file that already exists
    await Deno.writeTextFile(join(dir, "deno.json"), '{"existing": true}');

    const { code, stdout } = await runInitCommand(dir, ["--no-interactive"]);
    assertEquals(code, 0, "init command should succeed");

    // Verify the existing file was not overwritten
    const content = await Deno.readTextFile(join(dir, "deno.json"));
    assertEquals(content, '{"existing": true}');

    // Verify stdout mentions skipping
    assertEquals(stdout.includes("skip"), true);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test(
  "init --no-interactive --overwrite replaces existing files",
  async () => {
    const dir = await createTempDir();
    try {
      await Deno.writeTextFile(join(dir, "deno.json"), '{"existing": true}');

      const { code, stdout } = await runInitCommand(dir, [
        "--overwrite",
        "--no-interactive",
      ]);
      assertEquals(code, 0, "init command should succeed");

      const content = await Deno.readTextFile(join(dir, "deno.json"));
      assertEquals(content.includes('"imports"'), true);
      assertEquals(stdout.includes("overwrite"), true);
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test(
  "init --no-interactive --github-actions creates workflow files",
  async () => {
    const dir = await createTempDir();
    try {
      const { code } = await runInitCommand(dir, [
        "--github-actions",
        "--no-interactive",
      ]);
      assertEquals(code, 0, "init command should succeed");

      const metadataPath = join(
        dir,
        ".github/workflows/glubean-metadata.yml",
      );
      assertEquals(await fileExists(metadataPath), true);

      const metadataContent = await Deno.readTextFile(metadataPath);
      assertEquals(metadataContent.includes("Glubean Metadata"), true);
      assertEquals(metadataContent.includes("glubean scan"), true);

      const testsPath = join(dir, ".github/workflows/glubean-tests.yml");
      assertEquals(await fileExists(testsPath), true);

      const testsContent = await Deno.readTextFile(testsPath);
      assertEquals(testsContent.includes("Glubean Tests"), true);
      assertEquals(testsContent.includes("glubean run --ci"), true);
      assertEquals(testsContent.includes("upload-artifact"), true);
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test(
  "init --overwrite-actions overwrites both workflow files",
  async () => {
    const dir = await createTempDir();
    try {
      // First init to create the files
      await runInitCommand(dir, ["--github-actions", "--no-interactive"]);

      // Tamper with both workflow files
      const metadataPath = join(
        dir,
        ".github/workflows/glubean-metadata.yml",
      );
      const testsPath = join(dir, ".github/workflows/glubean-tests.yml");
      await Deno.writeTextFile(metadataPath, "custom-metadata");
      await Deno.writeTextFile(testsPath, "custom-tests");

      // Re-init with --overwrite-actions
      const { code } = await runInitCommand(dir, [
        "--github-actions",
        "--overwrite-actions",
        "--no-interactive",
      ]);
      assertEquals(code, 0, "init command should succeed");

      const metadataContent = await Deno.readTextFile(metadataPath);
      assertEquals(
        metadataContent.includes("Glubean Metadata"),
        true,
        "metadata workflow should be overwritten",
      );

      const testsContent = await Deno.readTextFile(testsPath);
      assertEquals(
        testsContent.includes("Glubean Tests"),
        true,
        "tests workflow should be overwritten",
      );
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test(
  "init --no-interactive --hooks creates git hooks when .git exists",
  async () => {
    const dir = await createTempDir();
    try {
      // Create .git directory to simulate git repo
      await Deno.mkdir(join(dir, ".git/hooks"), { recursive: true });

      const { code } = await runInitCommand(dir, [
        "--hooks",
        "--no-interactive",
      ]);
      assertEquals(code, 0, "init command should succeed");

      assertEquals(await fileExists(join(dir, ".git/hooks/pre-commit")), true);
      assertEquals(await fileExists(join(dir, ".git/hooks/pre-push")), true);

      const preCommit = await Deno.readTextFile(
        join(dir, ".git/hooks/pre-commit"),
      );
      assertEquals(preCommit.includes("glubean scan"), true);

      const prePush = await Deno.readTextFile(join(dir, ".git/hooks/pre-push"));
      assertEquals(prePush.includes("validate-metadata"), true);
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test(
  "init --no-interactive --hooks fails when no .git directory",
  async () => {
    const dir = await createTempDir();
    try {
      const { code, stderr } = await runInitCommand(dir, [
        "--hooks",
        "--no-interactive",
      ]);
      assertEquals(code, 1, "init command should fail without .git");

      // No files should be created (exit before file creation)
      assertEquals(await fileExists(join(dir, "deno.json")), false);

      // Should mention git init
      assertEquals(stderr.includes("git init"), true);
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test(
  "init --no-interactive --hooks --github-actions creates both",
  async () => {
    const dir = await createTempDir();
    try {
      await Deno.mkdir(join(dir, ".git/hooks"), { recursive: true });

      const { code } = await runInitCommand(dir, [
        "--hooks",
        "--github-actions",
        "--no-interactive",
      ]);
      assertEquals(code, 0, "init command should succeed");

      assertEquals(await fileExists(join(dir, ".git/hooks/pre-commit")), true);
      assertEquals(await fileExists(join(dir, ".git/hooks/pre-push")), true);
      assertEquals(
        await fileExists(join(dir, ".github/workflows/glubean-metadata.yml")),
        true,
      );
      assertEquals(
        await fileExists(join(dir, ".github/workflows/glubean-tests.yml")),
        true,
      );
    } finally {
      await cleanupDir(dir);
    }
  },
);

// ---------------------------------------------------------------------------
// Interactive tests (GLUBEAN_FORCE_INTERACTIVE=1 + piped stdin)
// ---------------------------------------------------------------------------

Deno.test(
  "init interactive - defaults create project with hooks and actions",
  async () => {
    const dir = await createTempDir();
    try {
      await Deno.mkdir(join(dir, ".git/hooks"), { recursive: true });

      // Step 1: Enter (default = Standard)
      // Step 2: Enter (default base URL)
      // Step 3: .git detected → hooks Y/n (Enter=Y) → actions Y/n (Enter=Y)
      const { code } = await runInitCommand(dir, [], "\n\n\n\n", {
        GLUBEAN_FORCE_INTERACTIVE: "1",
      });
      assertEquals(code, 0, "init command should succeed");

      assertEquals(await fileExists(join(dir, "deno.json")), true);
      assertEquals(await fileExists(join(dir, "tests/demo.test.ts")), true);
      assertEquals(await fileExists(join(dir, ".git/hooks/pre-commit")), true);
      assertEquals(await fileExists(join(dir, ".git/hooks/pre-push")), true);
      assertEquals(
        await fileExists(join(dir, ".github/workflows/glubean-metadata.yml")),
        true,
      );
      assertEquals(
        await fileExists(join(dir, ".github/workflows/glubean-tests.yml")),
        true,
      );
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test("init interactive - no .git offers to init git", async () => {
  const dir = await createTempDir();
  try {
    // Step 1: Enter (default = Standard)
    // Step 2: Enter (default base URL)
    // Step 3: no .git → init git? Y (Enter=Y) → hooks Y/n (Enter=Y) → actions Y/n (Enter=Y)
    const { code, stdout } = await runInitCommand(dir, [], "\n\n\n\n\n", {
      GLUBEAN_FORCE_INTERACTIVE: "1",
    });
    assertEquals(code, 0, "init command should succeed");

    // Git should have been initialized
    assertEquals(await fileExists(join(dir, ".git")), true);
    assertEquals(stdout.includes("Git repository initialized"), true);

    // Hooks should be created
    assertEquals(await fileExists(join(dir, ".git/hooks/pre-commit")), true);
    assertEquals(await fileExists(join(dir, ".git/hooks/pre-push")), true);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("init interactive - decline git init skips hooks", async () => {
  const dir = await createTempDir();
  try {
    // Step 1: Enter (default = Standard)
    // Step 2: Enter (default base URL)
    // Step 3: no .git → init git? n
    const { code, stdout } = await runInitCommand(dir, [], "\n\nn\n", {
      GLUBEAN_FORCE_INTERACTIVE: "1",
    });
    assertEquals(code, 0, "init command should succeed");

    // Basic files should still be created
    assertEquals(await fileExists(join(dir, "deno.json")), true);
    assertEquals(await fileExists(join(dir, "tests/demo.test.ts")), true);

    // No git, no hooks
    assertEquals(await fileExists(join(dir, ".git")), false);
    assertEquals(stdout.includes("Skipping Git hooks"), true);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test(
  "init interactive - invalid base URL reprompts until valid URL",
  async () => {
    const dir = await createTempDir();
    try {
      // Step 1: Enter (Best Practice)
      // Step 2: invalid URL -> valid URL
      // Step 3: no .git -> init git? n
      const { code, stdout } = await runInitCommand(
        dir,
        [],
        "\nnot-a-url\nhttps://api.example.com\nn\n",
        {
          GLUBEAN_FORCE_INTERACTIVE: "1",
        },
      );
      assertEquals(code, 0, "init command should succeed");
      assertStringIncludes(stdout, "Invalid URL:");

      const envContent = await Deno.readTextFile(join(dir, ".env"));
      assertEquals(envContent.includes("BASE_URL=https://api.example.com"), true);
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test("init --minimal creates minimal files", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runInitCommand(dir, [
      "--minimal",
      "--no-interactive",
    ]);
    assertEquals(code, 0, "init command should succeed");

    // Minimal files should exist
    assertEquals(await fileExists(join(dir, "deno.json")), true);
    assertEquals(await fileExists(join(dir, ".env")), true);
    assertEquals(await fileExists(join(dir, ".env.secrets")), true);
    assertEquals(await fileExists(join(dir, ".gitignore")), true);
    assertEquals(await fileExists(join(dir, "README.md")), true);
    assertEquals(await fileExists(join(dir, "explore/api.test.ts")), true);
    assertEquals(await fileExists(join(dir, "explore/search.test.ts")), true);
    assertEquals(await fileExists(join(dir, "explore/auth.test.ts")), true);
    assertEquals(
      await fileExists(join(dir, "data/search-examples.json")),
      true,
    );

    // tests/ has demo + AI instruction files
    assertEquals(await fileExists(join(dir, "tests/demo.test.ts")), true);
    assertEquals(await fileExists(join(dir, "CLAUDE.md")), true);
    assertEquals(await fileExists(join(dir, "AGENTS.md")), true);

    // Staging env files
    assertEquals(await fileExists(join(dir, ".env.staging")), true);
    assertEquals(await fileExists(join(dir, ".env.staging.secrets")), true);

    // Verify deno.json has explore and test tasks
    const denoJson = JSON.parse(
      await Deno.readTextFile(join(dir, "deno.json")),
    );
    assertEquals(typeof denoJson.tasks?.explore, "string");
    assertEquals(denoJson.tasks?.test, "glubean run");
    assertEquals(denoJson.tasks?.["test:staging"], "glubean run --env-file .env.staging");
    assertEquals(denoJson.tasks?.["test:ci"], "glubean run --ci --result-json");
    assertEquals(denoJson.glubean?.run?.testDir, "./tests");

    // Verify .env has DummyJSON
    const envContent = await Deno.readTextFile(join(dir, ".env"));
    assertEquals(envContent.includes("dummyjson.com"), true);

    // Verify README contains upgrade prompt
    const readme = await Deno.readTextFile(join(dir, "README.md"));
    assertEquals(readme.includes("glubean init"), true);
    assertEquals(readme.includes("Best Practice"), true);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("init interactive - choose minimal", async () => {
  const dir = await createTempDir();
  try {
    // Step 1: "2" (Minimal)
    const { code } = await runInitCommand(dir, [], "2\n", {
      GLUBEAN_FORCE_INTERACTIVE: "1",
    });
    assertEquals(code, 0, "init command should succeed");

    // Minimal files
    assertEquals(await fileExists(join(dir, "explore/api.test.ts")), true);
    assertEquals(await fileExists(join(dir, "explore/search.test.ts")), true);
    assertEquals(await fileExists(join(dir, "explore/auth.test.ts")), true);
    assertEquals(
      await fileExists(join(dir, "data/search-examples.json")),
      true,
    );

    // Minimal now scaffolds tests/demo.test.ts
    assertEquals(await fileExists(join(dir, "tests/demo.test.ts")), true);

    const envContent = await Deno.readTextFile(join(dir, ".env"));
    assertEquals(envContent.includes("dummyjson.com"), true);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test(
  "init interactive - existing files prompts overwrite, yes overwrites",
  async () => {
    const dir = await createTempDir();
    try {
      await Deno.writeTextFile(join(dir, "deno.json"), '{"existing": true}');

      // Step 1: Enter (Best Practice)
      // Overwrite prompt: y
      // Step 2: Enter (default base URL)
      // Step 3: no .git → init git? n
      const { code } = await runInitCommand(dir, [], "\ny\n\nn\n", {
        GLUBEAN_FORCE_INTERACTIVE: "1",
      });
      assertEquals(code, 0, "init command should succeed");

      const content = await Deno.readTextFile(join(dir, "deno.json"));
      assertEquals(
        content.includes('"imports"'),
        true,
        "deno.json should be overwritten with new content",
      );
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test(
  "init interactive - existing files prompts overwrite, no keeps them",
  async () => {
    const dir = await createTempDir();
    try {
      await Deno.writeTextFile(join(dir, "deno.json"), '{"existing": true}');

      // Step 1: Enter (Best Practice)
      // Overwrite prompt: n (keep existing)
      // Step 2: Enter (default base URL)
      // Step 3: no .git → init git? n
      const { code, stdout } = await runInitCommand(dir, [], "\nn\n\nn\n", {
        GLUBEAN_FORCE_INTERACTIVE: "1",
      });
      assertEquals(code, 0, "init command should succeed");

      const content = await Deno.readTextFile(join(dir, "deno.json"));
      assertEquals(
        content,
        '{"existing": true}',
        "deno.json should be preserved",
      );
      assertEquals(stdout.includes("skip"), true);
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test(
  "init interactive - minimal with existing files prompts overwrite",
  async () => {
    const dir = await createTempDir();
    try {
      await Deno.writeTextFile(join(dir, ".env"), "OLD=true");

      // Step 1: "2" (Minimal)
      // Overwrite prompt: y
      const { code } = await runInitCommand(dir, [], "2\ny\n", {
        GLUBEAN_FORCE_INTERACTIVE: "1",
      });
      assertEquals(code, 0, "init command should succeed");

      const content = await Deno.readTextFile(join(dir, ".env"));
      assertEquals(
        content.includes("dummyjson.com"),
        true,
        ".env should be overwritten",
      );
    } finally {
      await cleanupDir(dir);
    }
  },
);
