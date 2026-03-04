/**
 * Shared .env file loading for the Glubean CLI.
 *
 * Extracted from run.ts to be reusable by auth resolution,
 * sync, trigger, and other commands that need project-level env vars.
 */

import { resolve } from "@std/path";
import { parse as parseDotenv } from "@std/dotenv/parse";

/**
 * Load a single .env file and return its key-value pairs.
 * Returns an empty object if the file doesn't exist or can't be read.
 */
export async function loadEnvFile(
  envPath: string,
): Promise<Record<string, string>> {
  try {
    const content = await Deno.readTextFile(envPath);
    return parseDotenv(content);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {};
    }
    console.warn(`Warning: Could not read env file ${envPath}: ${(error as Error).message}`);
    return {};
  }
}

/**
 * Load `.env` + `.env.secrets` from a project root directory.
 *
 * The secrets file path follows the env file name:
 *   `.env` → `.env.secrets`
 *   `.env.staging` → `.env.staging.secrets`
 *
 * Secrets overlay env vars (later values win).
 *
 * @param rootDir  - Project root directory.
 * @param envFileName - Base env file name (default: ".env").
 * @returns Merged key-value pairs from both files.
 */
export async function loadProjectEnv(
  rootDir: string,
  envFileName = ".env",
): Promise<Record<string, string>> {
  const envPath = resolve(rootDir, envFileName);
  const secretsPath = resolve(rootDir, `${envFileName}.secrets`);

  const envVars = await loadEnvFile(envPath);
  const secrets = await loadEnvFile(secretsPath);

  return { ...envVars, ...secrets };
}
