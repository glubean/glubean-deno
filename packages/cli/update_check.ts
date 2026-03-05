import { dirname, join } from "@std/path";

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_URL = "https://jsr.io/@glubean/cli/meta.json";

type UpdateCache = {
  lastChecked: number;
  latest?: string;
};

/** @internal Exported for testing. */
export function parseSemver(version: string): { parts: number[]; pre: string | null } | null {
  // Strip build metadata (+...) per semver spec — it has no ordering significance
  const noBuild = version.split("+")[0];
  const [core, ...rest] = noBuild.split("-");
  const parts = core.split(".").map((p) => Number(p));
  if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null;
  return { parts: parts.slice(0, 3), pre: rest.length > 0 ? rest.join("-") : null };
}

/**
 * Compare pre-release identifiers per semver 2.0.0 spec (§11):
 * dot-separated identifiers compared left to right; numeric ids compared as
 * integers, string ids compared lexically, numeric < string, fewer fields < more.
 */
function comparePrerelease(a: string, b: string): number {
  const segsA = a.split(".");
  const segsB = b.split(".");
  const len = Math.max(segsA.length, segsB.length);
  for (let i = 0; i < len; i++) {
    if (i >= segsA.length) return -1; // a has fewer fields → a < b
    if (i >= segsB.length) return 1;
    const na = Number(segsA[i]);
    const nb = Number(segsB[i]);
    const aIsNum = !Number.isNaN(na);
    const bIsNum = !Number.isNaN(nb);
    if (aIsNum && bIsNum) {
      if (na !== nb) return na - nb;
    } else if (aIsNum !== bIsNum) {
      return aIsNum ? -1 : 1; // numeric < string
    } else {
      if (segsA[i] < segsB[i]) return -1;
      if (segsA[i] > segsB[i]) return 1;
    }
  }
  return 0;
}

/** @internal Exported for testing. */
export function isNewer(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (!l || !c) return false;
  for (let i = 0; i < 3; i += 1) {
    if (l.parts[i] > c.parts[i]) return true;
    if (l.parts[i] < c.parts[i]) return false;
  }
  // Same major.minor.patch — compare pre-release
  if (c.pre !== null && l.pre === null) return true; // release > pre-release
  if (c.pre === null && l.pre !== null) return false; // pre-release < release
  if (c.pre !== null && l.pre !== null) return comparePrerelease(l.pre, c.pre) > 0;
  return false;
}

function getDefaultCachePath(): string | null {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!home) return null;
  return join(home, ".glubean", "update-check.json");
}

export async function checkForUpdates(
  currentVersion: string,
  options?: {
    cachePath?: string;
    now?: number;
    fetchFn?: typeof fetch;
  },
): Promise<void> {
  try {
    const cachePath = options?.cachePath ?? getDefaultCachePath();
    if (!cachePath) return;

    const now = options?.now ?? Date.now();
    const fetchFn = options?.fetchFn ?? fetch;

    let cache: UpdateCache | null = null;
    try {
      cache = JSON.parse(await Deno.readTextFile(cachePath)) as UpdateCache;
    } catch {
      cache = null;
    }

    if (cache && now - cache.lastChecked < UPDATE_INTERVAL_MS) {
      if (cache.latest && isNewer(cache.latest, currentVersion)) {
        console.error(
          `Update available: glubean v${cache.latest} (current v${currentVersion}). ` +
            "Run: glubean upgrade",
        );
      }
      return;
    }

    let latest: string | undefined;
    try {
      const response = await fetchFn(UPDATE_URL);
      if (!response.ok) return;
      const data = (await response.json()) as { latest?: string };
      latest = data.latest;
    } catch {
      return;
    }

    try {
      await Deno.mkdir(dirname(cachePath), { recursive: true });
      const payload: UpdateCache = { lastChecked: now, latest };
      await Deno.writeTextFile(cachePath, JSON.stringify(payload));
    } catch {
      // Ignore cache write errors
    }

    if (latest && isNewer(latest, currentVersion)) {
      console.log(
        `Update available: glubean v${latest} (current v${currentVersion}). ` +
          "Run: glubean upgrade",
      );
    }
  } catch {
    // Ignore update check errors
  }
}
