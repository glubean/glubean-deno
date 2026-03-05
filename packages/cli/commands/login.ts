/**
 * glubean login — Authenticate with Glubean Cloud.
 *
 * Stores credentials in ~/.glubean/credentials.json for use by
 * `glubean run --upload` and other cloud-connected commands.
 */

import { Input, Secret } from "@cliffy/prompt";
import { type AuthOptions, resolveApiUrl, writeCredentials } from "../lib/auth.ts";

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  yellow: "\x1b[33m",
};

export interface LoginOptions {
  token?: string;
  project?: string;
  apiUrl?: string;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const apiUrl = await resolveApiUrl(options as AuthOptions);

  // Resolve token: flag → interactive prompt
  let token = options.token;
  if (!token) {
    console.log(
      `${colors.dim}Get a project token from your project settings at ${apiUrl.replace("api.", "app.")}${colors.reset}`,
    );
    token = await Secret.prompt({
      message: "Paste your project token (gpt_...)",
    });
  }

  if (!token) {
    console.error(`${colors.red}Error: No token provided.${colors.reset}`);
    Deno.exit(1);
  }

  // Validate token via whoami
  console.log(`${colors.dim}Validating...${colors.reset}`);
  try {
    const resp = await fetch(`${apiUrl}/open/v1/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(
        `${colors.red}Authentication failed (${resp.status}): ${body}${colors.reset}`,
      );
      Deno.exit(1);
    }

    const whoami = await resp.json();
    const identity = whoami.kind === "user"
      ? `user ${whoami.userId}`
      : `project ${whoami.projectName ?? whoami.projectId}`;

    console.log(`${colors.green}Authenticated as ${identity}${colors.reset}`);
  } catch (err) {
    console.error(
      `${colors.red}Failed to reach ${apiUrl}: ${err instanceof Error ? err.message : err}${colors.reset}`,
    );
    Deno.exit(1);
  }

  // Resolve project ID: flag → interactive prompt
  let projectId = options.project;
  if (!projectId) {
    projectId = await Input.prompt({
      message: "Project ID (optional, from project settings)",
      default: "",
    });
    if (projectId === "") projectId = undefined;
  }

  // Save credentials
  const savedPath = await writeCredentials({
    token,
    projectId,
    apiUrl: apiUrl !== "https://api.glubean.com" ? apiUrl : undefined,
  });

  console.log(
    `${colors.green}Credentials saved to ${savedPath}${colors.reset}`,
  );
  if (projectId) {
    console.log(
      `${colors.dim}Default project: ${projectId}${colors.reset}`,
    );
  }
  console.log(
    `\n${colors.dim}You can now run: glubean run --upload${colors.reset}`,
  );
}
