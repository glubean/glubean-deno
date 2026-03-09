/**
 * Tests for the unified config loader (lib/config.ts).
 *
 * Covers:
 * - readSingleConfig: plain JSON and deno.json special-case
 * - mergeConfigInputs: scalar override, array concatenation
 * - loadConfig: auto deno.json, explicit --config, multi-file merge
 * - mergeRunOptions: CLI flags override config, undefined = no-op
 */

import { assertEquals } from "@std/assert";
import {
  type CONFIG_DEFAULTS as _CONFIG_DEFAULTS,
  type GlubeanConfigInput,
  loadConfig,
  mergeConfigInputs,
  mergeRunOptions,
  readSingleConfig,
  RUN_DEFAULTS,
} from "./config.ts";
import { resolve } from "@std/path";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temp dir with files, run fn, clean up. */
async function withTempDir(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "glubean-config-test-" });
  try {
    for (const [name, content] of Object.entries(files)) {
      const filePath = resolve(dir, name);
      const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
      await Deno.mkdir(parentDir, { recursive: true });
      await Deno.writeTextFile(filePath, content);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// readSingleConfig
// ═════════════════════════════════════════════════════════════════════════════

Deno.test("readSingleConfig: plain JSON file", async () => {
  await withTempDir(
    {
      "my-config.json": JSON.stringify({
        run: { verbose: true, pretty: false },
        redaction: { replacementFormat: "labeled" },
      }),
    },
    async (dir) => {
      const config = await readSingleConfig(resolve(dir, "my-config.json"));
      assertEquals(config.run?.verbose, true);
      assertEquals(config.run?.pretty, false);
      assertEquals(config.redaction?.replacementFormat, "labeled");
    },
  );
});

Deno.test("readSingleConfig: deno.json extracts glubean field", async () => {
  await withTempDir(
    {
      "deno.json": JSON.stringify({
        imports: { "@glubean/sdk": "jsr:@glubean/sdk@^0.6.0" },
        tasks: { test: "deno run -A ..." },
        glubean: {
          run: { emitFullTrace: true },
          redaction: {
            sensitiveKeys: { additional: ["x-custom-key"] },
          },
        },
      }),
    },
    async (dir) => {
      const config = await readSingleConfig(resolve(dir, "deno.json"));
      assertEquals(config.run?.emitFullTrace, true);
      assertEquals(config.redaction?.sensitiveKeys?.additional, [
        "x-custom-key",
      ]);
    },
  );
});

Deno.test(
  "readSingleConfig: deno.json without glubean field returns empty",
  async () => {
    await withTempDir(
      {
        "deno.json": JSON.stringify({
          imports: {},
          tasks: {},
        }),
      },
      async (dir) => {
        const config = await readSingleConfig(resolve(dir, "deno.json"));
        assertEquals(config, {});
      },
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// mergeConfigInputs
// ═════════════════════════════════════════════════════════════════════════════

Deno.test("mergeConfigInputs: scalar override (right wins)", () => {
  const base: GlubeanConfigInput = {
    run: { verbose: false, pretty: true },
    redaction: { replacementFormat: "simple" },
  };
  const overlay: GlubeanConfigInput = {
    run: { verbose: true },
    redaction: { replacementFormat: "labeled" },
  };
  const merged = mergeConfigInputs(base, overlay);
  assertEquals(merged.run?.verbose, true);
  assertEquals(merged.run?.pretty, true); // kept from base
  assertEquals(merged.redaction?.replacementFormat, "labeled");
});

Deno.test("mergeConfigInputs: arrays concatenate", () => {
  const base: GlubeanConfigInput = {
    redaction: {
      sensitiveKeys: { additional: ["key-a"] },
      patterns: {
        custom: [{ name: "pat-a", regex: "a+" }],
      },
    },
  };
  const overlay: GlubeanConfigInput = {
    redaction: {
      sensitiveKeys: { additional: ["key-b"], excluded: ["password"] },
      patterns: {
        custom: [{ name: "pat-b", regex: "b+" }],
      },
    },
  };
  const merged = mergeConfigInputs(base, overlay);
  assertEquals(merged.redaction?.sensitiveKeys?.additional, ["key-a", "key-b"]);
  assertEquals(merged.redaction?.sensitiveKeys?.excluded, ["password"]);
  assertEquals(merged.redaction?.patterns?.custom?.length, 2);
  assertEquals(merged.redaction?.patterns?.custom?.[0].name, "pat-a");
  assertEquals(merged.redaction?.patterns?.custom?.[1].name, "pat-b");
});

Deno.test("mergeConfigInputs: empty inputs produce empty", () => {
  const merged = mergeConfigInputs({}, {});
  assertEquals(merged.run, undefined);
  assertEquals(merged.redaction, undefined);
});

// ═════════════════════════════════════════════════════════════════════════════
// loadConfig
// ═════════════════════════════════════════════════════════════════════════════

Deno.test("loadConfig: auto-reads deno.json glubean field", async () => {
  await withTempDir(
    {
      "deno.json": JSON.stringify({
        imports: {},
        glubean: {
          run: { verbose: true, pretty: false },
        },
      }),
    },
    async (dir) => {
      const config = await loadConfig(dir);
      assertEquals(config.run.verbose, true);
      assertEquals(config.run.pretty, false);
      // Defaults still applied for unspecified fields
      assertEquals(config.run.logFile, RUN_DEFAULTS.logFile);
      assertEquals(config.run.emitFullTrace, RUN_DEFAULTS.emitFullTrace);
    },
  );
});

Deno.test("loadConfig: no deno.json returns defaults", async () => {
  await withTempDir({}, async (dir) => {
    const config = await loadConfig(dir);
    assertEquals(config.run, { ...RUN_DEFAULTS });
    // Redaction should be the default config
    assertEquals(config.redaction.replacementFormat, "partial");
    assertEquals(config.redaction.scopes.requestHeaders, true);
  });
});

Deno.test("loadConfig: explicit --config skips auto deno.json", async () => {
  await withTempDir(
    {
      "deno.json": JSON.stringify({
        glubean: { run: { verbose: true } },
      }),
      "ci.json": JSON.stringify({
        run: { pretty: false, failFast: true },
      }),
    },
    async (dir) => {
      // Only ci.json is loaded; deno.json's glubean field is ignored
      const config = await loadConfig(dir, ["ci.json"]);
      assertEquals(config.run.verbose, false); // default, not from deno.json
      assertEquals(config.run.pretty, false); // from ci.json
      assertEquals(config.run.failFast, true); // from ci.json
    },
  );
});

Deno.test(
  "loadConfig: --config with deno.json in list (explicit)",
  async () => {
    await withTempDir(
      {
        "deno.json": JSON.stringify({
          imports: {},
          glubean: {
            run: { verbose: true, pretty: true },
            redaction: {
              sensitiveKeys: { additional: ["x-api-key"] },
            },
          },
        }),
        "staging.json": JSON.stringify({
          run: { verbose: false },
          redaction: {
            sensitiveKeys: { additional: ["x-staging-key"] },
          },
        }),
      },
      async (dir) => {
        // Merge: deno.json (glubean field) -> staging.json
        const config = await loadConfig(dir, ["deno.json", "staging.json"]);
        assertEquals(config.run.verbose, false); // staging overrides
        assertEquals(config.run.pretty, true); // from deno.json, not overridden
        // Redaction keys accumulate
        assertEquals(
          config.redaction.sensitiveKeys.additional.includes("x-api-key"),
          true,
        );
        assertEquals(
          config.redaction.sensitiveKeys.additional.includes("x-staging-key"),
          true,
        );
      },
    );
  },
);

Deno.test("loadConfig: multi-file merge left to right", async () => {
  await withTempDir(
    {
      "base.json": JSON.stringify({
        run: { verbose: false, pretty: true, failFast: false },
      }),
      "env.json": JSON.stringify({
        run: { verbose: true },
      }),
      "override.json": JSON.stringify({
        run: { failFast: true },
      }),
    },
    async (dir) => {
      const config = await loadConfig(dir, [
        "base.json",
        "env.json",
        "override.json",
      ]);
      assertEquals(config.run.verbose, true); // from env.json
      assertEquals(config.run.pretty, true); // from base.json
      assertEquals(config.run.failFast, true); // from override.json
    },
  );
});

Deno.test("loadConfig: missing config file shows warning", async () => {
  await withTempDir({}, async (dir) => {
    // Should not throw, just warn
    const config = await loadConfig(dir, ["nonexistent.json"]);
    // Falls back to defaults
    assertEquals(config.run, { ...RUN_DEFAULTS });
  });
});

Deno.test(
  "loadConfig: redaction custom patterns accumulate across files",
  async () => {
    await withTempDir(
      {
        "a.json": JSON.stringify({
          redaction: {
            patterns: {
              custom: [{ name: "pat-a", regex: "aaa" }],
            },
          },
        }),
        "b.json": JSON.stringify({
          redaction: {
            patterns: {
              custom: [{ name: "pat-b", regex: "bbb" }],
            },
          },
        }),
      },
      async (dir) => {
        const config = await loadConfig(dir, ["a.json", "b.json"]);
        const customNames = config.redaction.patterns.custom.map((p) => p.name);
        assertEquals(customNames.includes("pat-a"), true);
        assertEquals(customNames.includes("pat-b"), true);
      },
    );
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// mergeRunOptions
// ═════════════════════════════════════════════════════════════════════════════

Deno.test("mergeRunOptions: CLI flags override config", () => {
  const config = { ...RUN_DEFAULTS, verbose: false, pretty: true };
  const result = mergeRunOptions(config, {
    verbose: true,
    pretty: false,
  });
  assertEquals(result.verbose, true);
  assertEquals(result.pretty, false);
  // Other fields unchanged
  assertEquals(result.logFile, RUN_DEFAULTS.logFile);
  assertEquals(result.emitFullTrace, RUN_DEFAULTS.emitFullTrace);
});

Deno.test("mergeRunOptions: undefined CLI flags preserve config", () => {
  const config = {
    ...RUN_DEFAULTS,
    verbose: true,
    pretty: false,
    failFast: true,
  };
  const result = mergeRunOptions(config, {
    // No flags passed — all undefined
  });
  assertEquals(result.verbose, true);
  assertEquals(result.pretty, false);
  assertEquals(result.failFast, true);
});

Deno.test("mergeRunOptions: failAfter number", () => {
  const result = mergeRunOptions(RUN_DEFAULTS, {
    failAfter: 5,
  });
  assertEquals(result.failAfter, 5);
});

Deno.test("mergeRunOptions: envFile override", () => {
  const result = mergeRunOptions(RUN_DEFAULTS, {
    envFile: ".env.staging",
  });
  assertEquals(result.envFile, ".env.staging");
});

// ═════════════════════════════════════════════════════════════════════════════
// cloud config
// ═════════════════════════════════════════════════════════════════════════════

Deno.test("loadConfig: cloud section from deno.json", async () => {
  await withTempDir(
    {
      "deno.json": JSON.stringify({
        glubean: {
          cloud: { projectId: "proj_abc", apiUrl: "https://custom.api.com" },
        },
      }),
    },
    async (dir) => {
      const config = await loadConfig(dir);
      assertEquals(config.cloud?.projectId, "proj_abc");
      assertEquals(config.cloud?.apiUrl, "https://custom.api.com");
    },
  );
});

Deno.test("mergeConfigInputs: cloud section merges", () => {
  const base: GlubeanConfigInput = {
    cloud: { projectId: "proj_a" },
  };
  const overlay: GlubeanConfigInput = {
    cloud: { apiUrl: "https://overlay.api.com" },
  };
  const merged = mergeConfigInputs(base, overlay);
  assertEquals(merged.cloud?.projectId, "proj_a");
  assertEquals(merged.cloud?.apiUrl, "https://overlay.api.com");
});
