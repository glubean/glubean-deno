/**
 * Shared credential resolution for Glubean Cloud auth.
 *
 * Priority order:
 *   1. CLI flag (--token / --project / --api-url)
 *   2. System environment variable (GLUBEAN_TOKEN / GLUBEAN_PROJECT_ID / GLUBEAN_API_URL)
 *   3. .env + .env.secrets file vars (project-level)
 *   4. deno.json glubean.cloud config (projectId, apiUrl, token)
 *   5. ~/.glubean/credentials.json (global fallback)
 */

import { dirname, join } from "@std/path";
import { DEFAULT_API_URL } from "./constants.ts";

export interface Credentials {
  token: string;
  projectId?: string;
  apiUrl?: string;
}

export interface AuthOptions {
  token?: string;
  project?: string;
  apiUrl?: string;
}

/**
 * Additional auth sources from the project context.
 * Passed by callers that have already loaded env files and config.
 */
export interface ProjectAuthSources {
  /** Merged vars from .env + .env.secrets */
  envFileVars?: Record<string, string>;
  /** Cloud section from deno.json glubean config */
  cloudConfig?: { apiUrl?: string; projectId?: string; token?: string };
}

function getCredentialsPath(): string | null {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!home) return null;
  return join(home, ".glubean", "credentials.json");
}

export async function readCredentials(): Promise<Credentials | null> {
  const path = getCredentialsPath();
  if (!path) return null;
  try {
    const text = await Deno.readTextFile(path);
    return JSON.parse(text) as Credentials;
  } catch {
    return null;
  }
}

export async function writeCredentials(creds: Credentials): Promise<string> {
  const path = getCredentialsPath();
  if (!path) throw new Error("Cannot determine home directory");
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(creds, null, 2) + "\n");
  return path;
}

export async function resolveToken(
  options: AuthOptions,
  sources?: ProjectAuthSources,
): Promise<string | null> {
  // 1. CLI flag
  if (options.token) return options.token;
  // 2. System env var
  const env = Deno.env.get("GLUBEAN_TOKEN");
  if (env) return env;
  // 3. .env / .env.secrets
  const fileVar = sources?.envFileVars?.["GLUBEAN_TOKEN"];
  if (fileVar) return fileVar;
  // 4. deno.json cloud config
  if (sources?.cloudConfig?.token) return sources.cloudConfig.token;
  // 5. ~/.glubean/credentials.json
  const creds = await readCredentials();
  return creds?.token ?? null;
}

export async function resolveProjectId(
  options: AuthOptions,
  sources?: ProjectAuthSources,
): Promise<string | null> {
  // 1. CLI flag
  if (options.project) return options.project;
  // 2. System env var
  const env = Deno.env.get("GLUBEAN_PROJECT_ID");
  if (env) return env;
  // 3. .env / .env.secrets
  const fileVar = sources?.envFileVars?.["GLUBEAN_PROJECT_ID"];
  if (fileVar) return fileVar;
  // 4. deno.json cloud config
  if (sources?.cloudConfig?.projectId) return sources.cloudConfig.projectId;
  // 5. ~/.glubean/credentials.json
  const creds = await readCredentials();
  return creds?.projectId ?? null;
}

export async function resolveApiUrl(
  options: AuthOptions,
  sources?: ProjectAuthSources,
): Promise<string> {
  // 1. CLI flag
  if (options.apiUrl) return options.apiUrl;
  // 2. System env var
  const env = Deno.env.get("GLUBEAN_API_URL");
  if (env) return env;
  // 3. .env / .env.secrets
  const fileVar = sources?.envFileVars?.["GLUBEAN_API_URL"];
  if (fileVar) return fileVar;
  // 4. deno.json cloud config
  if (sources?.cloudConfig?.apiUrl) return sources.cloudConfig.apiUrl;
  // 5. ~/.glubean/credentials.json
  const creds = await readCredentials();
  return creds?.apiUrl ?? DEFAULT_API_URL;
}
