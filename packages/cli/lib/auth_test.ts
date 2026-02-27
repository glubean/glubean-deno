import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { readCredentials, resolveApiUrl, resolveProjectId, resolveToken, writeCredentials } from "./auth.ts";
import { DEFAULT_API_URL } from "./constants.ts";

/**
 * Tests for credential resolution logic.
 *
 * Uses a temporary HOME directory to isolate credential file operations
 * and saves/restores env vars to avoid leaks between tests.
 */

const AUTH_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "GLUBEAN_TOKEN",
  "GLUBEAN_PROJECT_ID",
  "GLUBEAN_API_URL",
];

function saveEnv(): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const key of AUTH_ENV_KEYS) {
    saved.set(key, Deno.env.get(key));
  }
  return saved;
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
}

async function withTempHome(
  fn: (tmpHome: string) => Promise<void>,
): Promise<void> {
  const tmpHome = await Deno.makeTempDir({ prefix: "glubean-auth-test-" });
  const saved = saveEnv();
  try {
    Deno.env.set("HOME", tmpHome);
    Deno.env.delete("USERPROFILE");
    Deno.env.delete("GLUBEAN_TOKEN");
    Deno.env.delete("GLUBEAN_PROJECT_ID");
    Deno.env.delete("GLUBEAN_API_URL");
    await fn(tmpHome);
  } finally {
    restoreEnv(saved);
    await Deno.remove(tmpHome, { recursive: true }).catch(() => {});
  }
}

// ── writeCredentials + readCredentials roundtrip ──

Deno.test("writeCredentials + readCredentials roundtrip", async () => {
  await withTempHome(async (tmpHome) => {
    const creds = { token: "gb_test123", projectId: "proj_abc", apiUrl: "https://custom.api.com" };
    const path = await writeCredentials(creds);

    assertEquals(path, join(tmpHome, ".glubean", "credentials.json"));

    const loaded = await readCredentials();
    assertEquals(loaded?.token, "gb_test123");
    assertEquals(loaded?.projectId, "proj_abc");
    assertEquals(loaded?.apiUrl, "https://custom.api.com");
  });
});

Deno.test("readCredentials returns null when no file exists", async () => {
  await withTempHome(async () => {
    const result = await readCredentials();
    assertEquals(result, null);
  });
});

// ── resolveToken ──

Deno.test("resolveToken: flag takes priority over env and file", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_file" });
    Deno.env.set("GLUBEAN_TOKEN", "gb_env");

    const token = await resolveToken({ token: "gb_flag" });
    assertEquals(token, "gb_flag");
  });
});

Deno.test("resolveToken: env takes priority over file", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_file" });
    Deno.env.set("GLUBEAN_TOKEN", "gb_env");

    const token = await resolveToken({});
    assertEquals(token, "gb_env");
  });
});

Deno.test("resolveToken: falls back to credentials file", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_file" });

    const token = await resolveToken({});
    assertEquals(token, "gb_file");
  });
});

Deno.test("resolveToken: returns null when nothing available", async () => {
  await withTempHome(async () => {
    const token = await resolveToken({});
    assertEquals(token, null);
  });
});

// ── resolveProjectId ──

Deno.test("resolveProjectId: flag takes priority", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_x", projectId: "proj_file" });
    Deno.env.set("GLUBEAN_PROJECT_ID", "proj_env");

    const pid = await resolveProjectId({ project: "proj_flag" });
    assertEquals(pid, "proj_flag");
  });
});

Deno.test("resolveProjectId: env takes priority over file", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_x", projectId: "proj_file" });
    Deno.env.set("GLUBEAN_PROJECT_ID", "proj_env");

    const pid = await resolveProjectId({});
    assertEquals(pid, "proj_env");
  });
});

Deno.test("resolveProjectId: falls back to credentials file", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_x", projectId: "proj_file" });

    const pid = await resolveProjectId({});
    assertEquals(pid, "proj_file");
  });
});

Deno.test("resolveProjectId: returns null when nothing available", async () => {
  await withTempHome(async () => {
    const pid = await resolveProjectId({});
    assertEquals(pid, null);
  });
});

// ── resolveApiUrl ──

Deno.test("resolveApiUrl: env takes priority", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_x", apiUrl: "https://file.api.com" });
    Deno.env.set("GLUBEAN_API_URL", "https://env.api.com");

    const url = await resolveApiUrl({ apiUrl: "https://flag.api.com" });
    assertEquals(url, "https://env.api.com");
  });
});

Deno.test("resolveApiUrl: flag used when no env", async () => {
  await withTempHome(async () => {
    const url = await resolveApiUrl({ apiUrl: "https://flag.api.com" });
    assertEquals(url, "https://flag.api.com");
  });
});

Deno.test("resolveApiUrl: falls back to credentials file", async () => {
  await withTempHome(async () => {
    await writeCredentials({ token: "gb_x", apiUrl: "https://file.api.com" });

    const url = await resolveApiUrl({});
    assertEquals(url, "https://file.api.com");
  });
});

Deno.test("resolveApiUrl: defaults to DEFAULT_API_URL", async () => {
  await withTempHome(async () => {
    const url = await resolveApiUrl({});
    assertEquals(url, DEFAULT_API_URL);
  });
});
