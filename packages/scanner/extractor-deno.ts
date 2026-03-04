import type { ExportMeta } from "./types.ts";
import { dirname, join, resolve } from "@std/path";

/**
 * Find deno.json config file by walking up the directory tree.
 */
async function findDenoConfig(startDir: string): Promise<string | null> {
  let dir = startDir;
  while (true) {
    const configPath = join(dir, "deno.json");
    try {
      await Deno.stat(configPath);
      return configPath;
    } catch {
      // Not found, try parent
    }

    const jsonc = join(dir, "deno.jsonc");
    try {
      await Deno.stat(jsonc);
      return jsonc;
    } catch {
      // Not found, try parent
    }

    const parent = dirname(dir);
    if (parent === dir) {
      // Reached root
      return null;
    }
    dir = parent;
  }
}

/**
 * Deno-based metadata extractor.
 * Runs a subprocess to import the test file and read SDK registry.
 */
export async function extractWithDeno(filePath: string): Promise<ExportMeta[]> {
  // Resolve to absolute path
  const absolutePath = resolve(filePath);
  const fileUrl = `file://${absolutePath}`;

  // Find deno.json config for import map resolution
  const configPath = await findDenoConfig(dirname(absolutePath));

  const extractorScript = `
import { getRegistry, clearRegistry } from "@glubean/sdk/internal";

clearRegistry();

const targetPath = ${JSON.stringify(fileUrl)};
const testModule = await import(targetPath);

const registry = getRegistry();
const exportNames = new Map();
const seenIds = new Set();

function isNewTest(value) {
  return value && typeof value === "object" && value.meta && (value.type === "simple" || value.type === "steps");
}

function isEachBuilder(value) {
  return value && typeof value === "object" && value.__glubean_type === "each-builder" && typeof value.build === "function";
}

function isBuilder(value) {
  return value && typeof value === "object" && value.__glubean_type === "builder";
}

for (const [name, value] of Object.entries(testModule)) {
  if (isEachBuilder(value)) {
    // EachBuilder: build it to get Test[] and map export names
    const tests = value.build();
    for (const t of tests) {
      if (t && t.meta && t.meta.id) {
        exportNames.set(t.meta.id, name);
      }
    }
  } else if (isBuilder(value)) {
    // Un-built TestBuilder: read private _meta for id -> exportName mapping
    if (value._meta && value._meta.id) {
      exportNames.set(value._meta.id, name);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object" && item.meta && item.meta.id) {
        exportNames.set(item.meta.id, name);
      }
    }
  } else if (value && typeof value === "object" && value.meta && value.meta.id) {
    exportNames.set(value.meta.id, name);
  }
}

function processExport(name, value) {
  if (isNewTest(value)) {
    const reg = registry.find((r) => r.id === value.meta.id);
    const entry = {
      type: "test",
      id: value.meta.id,
      name: value.meta.name || value.meta.id,
      tags: value.meta.tags,
      timeout: value.meta.timeout,
      exportName: name,
      steps: reg && reg.steps ? reg.steps : undefined,
    };
    if (value.meta.skip) entry.skip = true;
    if (value.meta.only) entry.only = true;
    if (reg && reg.groupId) entry.groupId = reg.groupId;
    exports.push(entry);
    seenIds.add(value.meta.id);
  }
}

const exports = [];

for (const [name, value] of Object.entries(testModule)) {
  if (isEachBuilder(value)) {
    // EachBuilder: build and process each generated test
    const tests = value.build();
    for (const item of tests) {
      processExport(name, item);
    }
  } else if (isBuilder(value)) {
    // Un-built TestBuilder: read _meta directly for skip/only and correct exportName
    const m = value._meta;
    if (m && m.id) {
      const reg = registry.find((r) => r.id === m.id);
      const entry = {
        type: "test",
        id: m.id,
        name: m.name || m.id,
        tags: m.tags,
        timeout: m.timeout,
        exportName: name,
        steps: reg && reg.steps ? reg.steps : undefined,
      };
      if (m.skip) entry.skip = true;
      if (m.only) entry.only = true;
      exports.push(entry);
      seenIds.add(m.id);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      processExport(name, item);
    }
  } else {
    processExport(name, value);
  }
}

for (const reg of registry) {
  if (!seenIds.has(reg.id)) {
    const entry = {
      type: "test",
      id: reg.id,
      name: reg.name,
      tags: reg.tags,
      timeout: reg.timeout,
      exportName: exportNames.get(reg.id) || reg.id,
      steps: reg.steps ? reg.steps : undefined,
    };
    if (reg.skip) entry.skip = true;
    if (reg.only) entry.only = true;
    if (reg.groupId) entry.groupId = reg.groupId;
    exports.push(entry);
  }
}

// Sort by registry order (source/call order) instead of ES module
// alphabetical export order. The registry tracks test() calls in the
// order they execute during module loading, which matches source order.
const regOrder = new Map();
registry.forEach((r, i) => regOrder.set(r.id, i));
exports.sort((a, b) => {
  const oA = regOrder.has(a.id) ? regOrder.get(a.id) : Infinity;
  const oB = regOrder.has(b.id) ? regOrder.get(b.id) : Infinity;
  return oA - oB;
});

console.log(JSON.stringify(exports));
`;

  // Write script to temp file (Deno 2.x doesn't support --eval)
  const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(tempFile, extractorScript);

    const args = ["run", "--allow-read", "--allow-env", "--no-check"];

    // Add config file for import map resolution
    if (configPath) {
      args.push(`--config=${configPath}`);
    }

    args.push(tempFile);

    const command = new Deno.Command(Deno.execPath(), {
      args,
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout, stderr } = await command.output();

    if (code !== 0) {
      const errorText = new TextDecoder().decode(stderr);
      throw new Error(`Extraction failed: ${errorText}`);
    }

    const output = new TextDecoder().decode(stdout).trim();
    if (!output) {
      return [];
    }

    try {
      return JSON.parse(output) as ExportMeta[];
    } catch {
      throw new Error(`Failed to parse extraction output: ${output}`);
    }
  } finally {
    // Clean up temp file
    try {
      await Deno.remove(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
