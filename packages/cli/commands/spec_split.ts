/**
 * `glubean spec split <spec>` — dereference $refs and split an OpenAPI spec
 * into per-endpoint JSON files for efficient AI consumption.
 *
 * Output: context/<basename>-endpoints/
 *   ├── _index.md
 *   ├── get-users.json
 *   ├── post-users.json
 *   └── ...
 */

import { basename, dirname, extname, resolve } from "@std/path";
import { parseSpec, splitSpec } from "../lib/openapi_split.ts";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

export interface SpecSplitOptions {
  output?: string;
}

export async function specSplitCommand(
  specPath: string,
  options: SpecSplitOptions = {},
): Promise<void> {
  const absSpec = resolve(specPath);

  // Read and parse spec
  let content: string;
  try {
    content = await Deno.readTextFile(absSpec);
  } catch {
    console.error(`Error: Cannot read spec file: ${specPath}`);
    Deno.exit(1);
  }

  let spec: Record<string, unknown>;
  try {
    spec = parseSpec(content, absSpec);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }

  if (!spec || typeof spec !== "object") {
    console.error("Error: Spec file did not parse to a valid object.");
    Deno.exit(1);
  }

  if (!spec.paths || typeof spec.paths !== "object" || Object.keys(spec.paths).length === 0) {
    console.error("Error: No paths found in spec. Is this an OpenAPI 3.x file?");
    Deno.exit(1);
  }

  // Determine output directory
  const specBasename = basename(absSpec, extname(absSpec));
  const outDir = options.output ? resolve(options.output) : resolve(dirname(absSpec), `${specBasename}-endpoints`);

  // Split
  const { endpoints, index } = splitSpec(spec);

  // Write files
  await Deno.mkdir(outDir, { recursive: true });

  // Write index
  await Deno.writeTextFile(resolve(outDir, "_index.md"), index);
  console.log(
    `  ${colors.green}create${colors.reset} _index.md`,
  );

  // Write endpoint files
  for (const ep of endpoints) {
    const filePath = resolve(outDir, `${ep.slug}.json`);
    await Deno.writeTextFile(filePath, JSON.stringify(ep.content, null, 2) + "\n");
    console.log(
      `  ${colors.green}create${colors.reset} ${ep.slug}.json`,
    );
  }

  const relOut = outDir.startsWith(Deno.cwd()) ? outDir.slice(Deno.cwd().length + 1) : outDir;

  console.log(
    `\n${colors.bold}Done:${colors.reset} ${endpoints.length} endpoints → ${colors.cyan}${relOut}/${colors.reset}`,
  );
}
