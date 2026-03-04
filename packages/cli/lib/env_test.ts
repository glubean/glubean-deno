import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { loadEnvFile, loadProjectEnv } from "./env.ts";

Deno.test("loadEnvFile: parses key=value pairs", async () => {
  const tmp = await Deno.makeTempDir();
  const envPath = join(tmp, ".env");
  await Deno.writeTextFile(envPath, "FOO=bar\nBAZ=qux\n");

  const vars = await loadEnvFile(envPath);
  assertEquals(vars.FOO, "bar");
  assertEquals(vars.BAZ, "qux");

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadEnvFile: returns empty for missing file", async () => {
  const vars = await loadEnvFile("/nonexistent/.env.nope");
  assertEquals(vars, {});
});

Deno.test("loadProjectEnv: merges .env and .env.secrets", async () => {
  const tmp = await Deno.makeTempDir();
  await Deno.writeTextFile(join(tmp, ".env"), "A=1\nB=2\n");
  await Deno.writeTextFile(join(tmp, ".env.secrets"), "B=override\nC=3\n");

  const vars = await loadProjectEnv(tmp);
  assertEquals(vars.A, "1");
  assertEquals(vars.B, "override"); // secrets wins
  assertEquals(vars.C, "3");

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadProjectEnv: custom envFileName", async () => {
  const tmp = await Deno.makeTempDir();
  await Deno.writeTextFile(join(tmp, ".env.staging"), "STAGE=true\n");
  await Deno.writeTextFile(
    join(tmp, ".env.staging.secrets"),
    "TOKEN=secret\n",
  );

  const vars = await loadProjectEnv(tmp, ".env.staging");
  assertEquals(vars.STAGE, "true");
  assertEquals(vars.TOKEN, "secret");

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadProjectEnv: missing files return empty", async () => {
  const tmp = await Deno.makeTempDir();
  const vars = await loadProjectEnv(tmp);
  assertEquals(vars, {});
  await Deno.remove(tmp, { recursive: true });
});
