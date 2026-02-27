/**
 * Shared credential resolution for Glubean Cloud auth.
 *
 * Priority order:
 *   1. CLI flag (--token / --project / --api-url)
 *   2. Environment variable (GLUBEAN_TOKEN / GLUBEAN_PROJECT_ID / GLUBEAN_API_URL)
 *   3. ~/.glubean/credentials.json
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

export async function resolveToken(options: AuthOptions): Promise<string | null> {
  if (options.token) return options.token;
  const env = Deno.env.get("GLUBEAN_TOKEN");
  if (env) return env;
  const creds = await readCredentials();
  return creds?.token ?? null;
}

export async function resolveProjectId(options: AuthOptions): Promise<string | null> {
  if (options.project) return options.project;
  const env = Deno.env.get("GLUBEAN_PROJECT_ID");
  if (env) return env;
  const creds = await readCredentials();
  return creds?.projectId ?? null;
}

export async function resolveApiUrl(options: AuthOptions): Promise<string> {
  const env = Deno.env.get("GLUBEAN_API_URL");
  if (env) return env;
  if (options.apiUrl) return options.apiUrl;
  const creds = await readCredentials();
  return creds?.apiUrl ?? DEFAULT_API_URL;
}
