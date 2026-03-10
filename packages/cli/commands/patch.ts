import { basename, dirname, extname, resolve } from "@std/path";
import { parse as yamlParse } from "@std/yaml";
import { applyPatch, findPatchFile, loadPatchFile } from "../lib/openapi_patch.ts";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

export interface PatchCommandOptions {
  patch?: string;
  output?: string;
  stdout?: boolean;
  format?: "json" | "yaml";
}

export async function patchCommand(
  specPath: string,
  options: PatchCommandOptions = {},
): Promise<void> {
  const resolvedSpec = resolve(specPath);

  // 1. Load the base spec
  let specContent: string;
  try {
    specContent = await Deno.readTextFile(resolvedSpec);
  } catch {
    console.error(
      `${colors.red}Error: Cannot read spec file: ${specPath}${colors.reset}`,
    );
    Deno.exit(1);
  }

  const specExt = extname(resolvedSpec).toLowerCase();
  let spec: Record<string, unknown>;
  try {
    if (specExt === ".yaml" || specExt === ".yml") {
      spec = yamlParse(specContent) as Record<string, unknown>;
    } else {
      spec = JSON.parse(specContent);
    }
  } catch {
    console.error(
      `${colors.red}Error: Failed to parse spec file: ${specPath}${colors.reset}`,
    );
    Deno.exit(1);
  }

  // 2. Find or use the patch file
  let patchPath: string | null;
  if (options.patch) {
    patchPath = resolve(options.patch);
  } else {
    patchPath = await findPatchFile(resolvedSpec);
  }

  if (!patchPath) {
    console.error(
      `${colors.red}Error: No patch file found for ${specPath}${colors.reset}`,
    );
    console.error(
      `${colors.dim}Expected one of: ${
        basename(resolvedSpec, extname(resolvedSpec))
      }.patch.yaml, .patch.yml, .patch.json${colors.reset}`,
    );
    Deno.exit(1);
  }

  // 3. Load and apply patch
  const patch = await loadPatchFile(patchPath);
  const merged = applyPatch(spec, patch);

  // 4. Determine output format
  const outputFormat = options.format ??
    (specExt === ".yaml" || specExt === ".yml" ? "yaml" : "json");

  let outputContent: string;
  if (outputFormat === "yaml") {
    // Dynamic import to avoid loading yaml stringify unless needed
    const { stringify } = await import("@std/yaml");
    outputContent = stringify(merged as Record<string, unknown>);
  } else {
    outputContent = JSON.stringify(merged, null, 2) + "\n";
  }

  // 5. Output
  if (options.stdout) {
    await Deno.stdout.write(new TextEncoder().encode(outputContent));
    return;
  }

  const outputPath = options.output ? resolve(options.output) : resolve(
    dirname(resolvedSpec),
    `${basename(resolvedSpec, extname(resolvedSpec))}.patched${outputFormat === "yaml" ? ".yaml" : ".json"}`,
  );

  await Deno.writeTextFile(outputPath, outputContent);

  // Print summary (only when writing to file)
  const relPatch = patchPath.startsWith(Deno.cwd()) ? patchPath.slice(Deno.cwd().length + 1) : patchPath;
  const relOutput = outputPath.startsWith(Deno.cwd()) ? outputPath.slice(Deno.cwd().length + 1) : outputPath;

  console.log(
    `${colors.green}Patched${colors.reset} ${specPath} + ${relPatch} → ${colors.bold}${relOutput}${colors.reset}`,
  );
}
