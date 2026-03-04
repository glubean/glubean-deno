# oss — SDK, CLI, Runner, Plugins Core

## What This Repo Is

Deno monorepo containing @glubean/sdk, @glubean/cli, @glubean/runner, @glubean/scanner, and core plugin types. Published
to JSR. This is the data collection layer.

**Feature Map:** Before modifying SDK or CLI, check `internal/00-overview/feature-map/sdk.md` and `cli.md` for existing capabilities.

## Current Focus (updated 2026-03-03)

1. P3.1 is DONE — `feat/cli-cloud-upload` already squash-merged to main (#52)
2. Next oss work: after Cloud deployment (Phase 3), resume with Cloud Hardening (X1, X5-X7)
3. `feat/task-builder` branch has unmerged Scraper S1a code — PAUSED until Cloud is live

## Version Policy (Pre-Launch)

- ALL version bumps are PATCH only (0.x.Y) until public launch.
- Every merge to main that changes runtime behavior MUST be followed by a version bump + publish.
- Workflow: branch → PR → squash-merge → bump version → publish → delete branch.
- Do NOT leave merged branches around. After squash-merge, delete the local and remote branch.

## Branch Discipline

- **One active branch at a time.** Before creating a new branch, the current one must be: merged, deleted, or explicitly
  stashed with a note in backlog.md.
- If the user tries to create a new branch while one is active, ask: "当前 branch 还没处理完，要先 merge 还是 stash？"
- Paused branches must have a corresponding Paused item in `internal/30-execution/backlog.md`.

## Package Dependency Graph & Publish Order

```
Layer 0 (no deps):  sdk, scanner, redaction
Layer 1:            runner → sdk
                    auth → sdk
                    graphql → sdk
Layer 2:            mcp → runner
                    worker → runner, redaction, sdk
Layer 3 (top):      cli → sdk, runner, scanner, redaction
```

### Publishing rules
- Use `deno task version patch` to bump ALL packages uniformly, then create a GitHub Release (triggers `release.yml` which runs `deno publish` for the whole workspace at once).
- Do NOT use auto-patch workflow for cross-package version bumps — it publishes packages independently and will fail on dependency ordering (e.g. cli depends on scanner@^0.12.0 but scanner 0.12.x isn't published yet).
- After oss packages are live on JSR, THEN update vscode extension deps. See `docs/guides/releasing.md` for full cross-repo coordination.

### Post-publish checklist (run after every release)
1. **Poll JSR until live:**
   ```bash
   for pkg in sdk runner cli scanner mcp auth graphql redaction worker; do
     curl -s "https://jsr.io/@glubean/$pkg/meta.json" | jq -r '"@glubean/'$pkg': " + .latest';
   done
   ```
   Retry after 15s if versions don't match. Do NOT proceed until all packages show the new version.

2. **Update local CLI:**
   ```bash
   deno install -g --name glubean -A --force "jsr:@glubean/cli@<VERSION>"
   glubean --version
   ```

3. **Clear Deno cache in oss repo** (so local dev uses the freshly published versions):
   ```bash
   deno cache --reload packages/*/mod.ts
   ```

4. **Update downstream repos** (cookbook, collections — any repo that imports @glubean/*):
   - Update `deno.json` import map to new version: `"@glubean/sdk": "jsr:@glubean/sdk@^X.Y.0"`
   - Run `deno cache --reload` to pull new versions
   - Verify: `deno test -A` or `deno check`

5. **Update vscode extension** (separate repo, separate publish):
   - Update `@glubean/scanner` version in `package.json`
   - `npm install && npm run build`
   - Bump extension version (patch) → PR → merge → publish to VS Code Marketplace

## Tech Notes

- Uses deno.json workspaces for monorepo
- JSR publish via GitHub Release → `release.yml` (workspace `deno publish`)
- Auto-patch via `auto-patch.yml` — only safe for single-package changes
- `scripts/bump-version.ts` handles version bumping
