import { assertEquals } from "@std/assert";
import { extractAliasesFromSource, extractFromSource, isGlubeanFile } from "./extractor-static.ts";

// =============================================================================
// Empty / no-export cases
// =============================================================================

Deno.test("extractFromSource returns empty array for empty content", () => {
  assertEquals(extractFromSource(""), []);
});

Deno.test("extractFromSource returns empty array when no test exports exist", () => {
  const content = `
import { something } from "some-lib";

export const helper = () => "not a test";
const internal = test("hidden", async () => {});
`;
  assertEquals(extractFromSource(content), []);
});

// =============================================================================
// Simple test — string ID
// =============================================================================

Deno.test("extracts simple test with string ID", () => {
  const content = `
import { test } from "@glubean/sdk";

export const healthCheck = test("health-check", async (ctx) => {
  const res = await ctx.http.get(ctx.vars.require("BASE_URL"));
  ctx.assert(res.ok, "Should be healthy");
});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].type, "test");
  assertEquals(result[0].id, "health-check");
  assertEquals(result[0].exportName, "healthCheck");
  assertEquals(result[0].name, undefined);
  assertEquals(result[0].tags, undefined);
  assertEquals(result[0].steps, undefined);
});

// =============================================================================
// Simple test — TestMeta object
// =============================================================================

Deno.test("extracts simple test with TestMeta object (id, name, tags array)", () => {
  const content = `
import { test } from "@glubean/sdk";

export const listProducts = test(
  { id: "list-products", name: "List Products", tags: ["smoke", "api"] },
  async (ctx) => {
    ctx.log("hello");
  }
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "list-products");
  assertEquals(result[0].name, "List Products");
  assertEquals(result[0].tags, ["smoke", "api"]);
  assertEquals(result[0].exportName, "listProducts");
});

Deno.test("extracts simple test with TestMeta object (tags as single string)", () => {
  const content = `
export const myTest = test(
  { id: "my-test", tags: "smoke" },
  async (ctx) => {}
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "my-test");
  assertEquals(result[0].tags, ["smoke"]);
});

Deno.test("extracts simple test timeout from TestMeta object", () => {
  const content = `
export const withTimeout = test(
  { id: "timeout-meta", timeout: 1200 },
  async (ctx) => {}
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "timeout-meta");
  assertEquals(result[0].timeout, 1200);
});

// =============================================================================
// Builder pattern — string ID + .meta() + .step()
// =============================================================================

Deno.test("extracts builder test with string ID and step chain", () => {
  const content = `
import { test } from "@glubean/sdk";

export const authFlow = test("auth-flow")
  .meta({ name: "Authentication Flow", tags: ["auth"] })
  .step("login", async (ctx) => {
    return { token: "abc" };
  })
  .step("get profile", async (ctx, state) => {
    ctx.log(state.token);
  });
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "auth-flow");
  assertEquals(result[0].name, "Authentication Flow");
  assertEquals(result[0].tags, ["auth"]);
  assertEquals(result[0].steps, [{ name: "login" }, { name: "get profile" }]);
});

Deno.test("extracts builder timeout from .meta()", () => {
  const content = `
export const timedFlow = test("timed-flow")
  .meta({ timeout: 900, tags: ["auth"] })
  .step("login", async (ctx) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "timed-flow");
  assertEquals(result[0].timeout, 900);
});

Deno.test("extracts builder test without .meta() — steps only", () => {
  const content = `
export const flow = test("my-flow")
  .step("step one", async (ctx) => {})
  .step("step two", async (ctx) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "my-flow");
  assertEquals(result[0].name, undefined);
  assertEquals(result[0].tags, undefined);
  assertEquals(result[0].steps, [{ name: "step one" }, { name: "step two" }]);
});

// =============================================================================
// test.each() — data-driven
// =============================================================================

Deno.test("extracts test.each() with string ID template", () => {
  const content = `
import { test } from "@glubean/sdk";
import users from "./data/users.json" with { type: "json" };

export const userTests = test.each(users)(
  "get-user-$id",
  async (ctx, { id, expected }) => {
    ctx.assert(true, "ok");
  }
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "get-user-$id");
  assertEquals(result[0].exportName, "userTests");
});

Deno.test("extracts test.each() with TestMeta object", () => {
  const content = `
export const endpoints = test.each(data)(
  {
    id: "endpoint-$method-$path",
    name: "$method $path",
    tags: ["smoke", "endpoints"],
  },
  async (ctx, row) => {}
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "endpoint-$method-$path");
  assertEquals(result[0].name, "$method $path");
  assertEquals(result[0].tags, ["smoke", "endpoints"]);
});

Deno.test("extracts test.each() builder mode with steps", () => {
  const content = `
export const scenarioTests = test
  .each(await fromYaml("./data/scenarios.yaml"))({
    id: "scenario-$id",
    name: "$description",
    tags: "scenario",
  })
  .step("send request", async (ctx, _state, row) => {
    return { status: 200 };
  })
  .step("log result", async (ctx, state, row) => {
    ctx.log("done");
  });
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "scenario-$id");
  assertEquals(result[0].name, "$description");
  assertEquals(result[0].tags, ["scenario"]);
  assertEquals(result[0].steps, [{ name: "send request" }, { name: "log result" }]);
});

// =============================================================================
// test.pick() — example selection
// =============================================================================

Deno.test("extracts test.pick() with string ID template", () => {
  const content = `
export const searchProducts = test.pick({
  "by-name": { q: "phone" },
  "by-category": { q: "laptops" },
})(
  "search-products-$_pick",
  async (ctx, data) => {}
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "search-products-$_pick");
  assertEquals(result[0].exportName, "searchProducts");
});

Deno.test("extracts test.pick() with TestMeta object", () => {
  const content = `
export const createUser = test.pick(examples)({
  id: "create-user-$_pick",
  tags: ["smoke"],
}, async (ctx, data) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "create-user-$_pick");
  assertEquals(result[0].tags, ["smoke"]);
});

// =============================================================================
// Multiple exports in one file
// =============================================================================

Deno.test("extracts multiple exports from a single file", () => {
  const content = `
import { test } from "@glubean/sdk";

export const first = test("first-test", async (ctx) => {});

export const second = test(
  { id: "second-test", name: "Second", tags: ["smoke"] },
  async (ctx) => {}
);

export const third = test("third-test")
  .step("only step", async (ctx) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 3);
  assertEquals(result[0].id, "first-test");
  assertEquals(result[0].exportName, "first");
  assertEquals(result[1].id, "second-test");
  assertEquals(result[1].name, "Second");
  assertEquals(result[2].id, "third-test");
  assertEquals(result[2].steps, [{ name: "only step" }]);
});

// =============================================================================
// Comment handling
// =============================================================================

Deno.test("ignores test() calls inside block comments", () => {
  const content = `
/*
export const commented = test("should-not-appear", async (ctx) => {});
*/

export const real = test("real-test", async (ctx) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "real-test");
});

Deno.test("ignores test() calls inside line comments", () => {
  const content = `
// export const commented = test("should-not-appear", async (ctx) => {});

export const real = test("real-test", async (ctx) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "real-test");
});

// =============================================================================
// Location tracking
// =============================================================================

Deno.test("reports correct line numbers", () => {
  const content = `import { test } from "@glubean/sdk";

export const a = test("alpha", async () => {});

export const b = test("beta", async () => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 2);
  assertEquals(result[0].location?.line, 3);
  assertEquals(result[1].location?.line, 5);
});

// =============================================================================
// Edge cases
// =============================================================================

Deno.test("handles single-quoted string IDs", () => {
  const content = `export const t = test('single-quoted', async () => {});`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "single-quoted");
});

Deno.test("handles single-quoted TestMeta object (id, tags)", () => {
  const content = `export const t = test({ id: 'x', tags: ['a'] }, async ()=>{});`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "x");
  assertEquals(result[0].tags, ["a"]);
});

Deno.test("handles single-quoted TestMeta with name and multiple tags", () => {
  const content = `
export const t = test(
  { id: 'my-test', name: 'My Test', tags: ['smoke', 'api'] },
  async (ctx) => {}
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "my-test");
  assertEquals(result[0].name, "My Test");
  assertEquals(result[0].tags, ["smoke", "api"]);
});

Deno.test("handles single-quoted tags in builder .meta()", () => {
  const content = `
export const flow = test('my-flow')
  .meta({ name: 'My Flow', tags: ['auth'] })
  .step('login', async (ctx) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "my-flow");
  assertEquals(result[0].name, "My Flow");
  assertEquals(result[0].tags, ["auth"]);
  assertEquals(result[0].steps, [{ name: "login" }]);
});

Deno.test("non-exported test() calls are not extracted", () => {
  const content = `
const internal = test("internal-only", async (ctx) => {});
`;
  assertEquals(extractFromSource(content), []);
});

Deno.test("test.pick with imported JSON examples", () => {
  const content = `
import examples from "../data/examples.json" with { type: "json" };

export const createUser = test.pick(examples)(
  "create-user-$_pick",
  async (ctx, { body }) => {}
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "create-user-$_pick");
});

Deno.test("test.each with nested function calls in data arg", () => {
  const content = `
export const csvTests = test.each(await fromCsv("./data/endpoints.csv"))(
  {
    id: "csv-$method-$path",
    tags: ["csv"],
  },
  async (ctx, row) => {}
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "csv-$method-$path");
  assertEquals(result[0].tags, ["csv"]);
});

// =============================================================================
// isGlubeanFile
// =============================================================================

Deno.test("isGlubeanFile detects JSR import with version", () => {
  const content = `import { test } from "jsr:@glubean/sdk@0.10.0";`;
  assertEquals(isGlubeanFile(content), true);
});

Deno.test("isGlubeanFile detects JSR import without version", () => {
  const content = `import { test } from "jsr:@glubean/sdk";`;
  assertEquals(isGlubeanFile(content), true);
});

Deno.test("isGlubeanFile detects bare specifier import", () => {
  const content = `import { test } from "@glubean/sdk";`;
  assertEquals(isGlubeanFile(content), true);
});

Deno.test("isGlubeanFile detects subpath import", () => {
  const content = `import { getRegistry } from "@glubean/sdk/internal";`;
  assertEquals(isGlubeanFile(content), true);
});

Deno.test("isGlubeanFile returns false for unrelated code", () => {
  assertEquals(isGlubeanFile(`import { something } from "other-lib";`), false);
  assertEquals(isGlubeanFile(`const x = 1;`), false);
  assertEquals(isGlubeanFile(""), false);
});

Deno.test("isGlubeanFile returns false for non-convention imports from other packages", () => {
  // Non-convention identifiers from other packages should NOT match
  assertEquals(
    isGlubeanFile(`import { something } from "@glubean/runner";`),
    false,
  );
  assertEquals(
    isGlubeanFile(`import { utils } from "jsr:@other/sdk";`),
    false,
  );
});

Deno.test("isGlubeanFile detects convention-based *Test/*Task imports from any module", () => {
  // Convention: import { browserTest } from local fixtures
  assertEquals(
    isGlubeanFile(`import { browserTest } from "./configure.ts";`),
    true,
  );
  // Convention: import { deployTask } from local module
  assertEquals(
    isGlubeanFile(`import { deployTask } from "../tasks.ts";`),
    true,
  );
  // Convention: import { test } from a re-export module
  assertEquals(
    isGlubeanFile(`import { test } from "./fixtures.ts";`),
    true,
  );
  // Convention: import { task } from another package
  assertEquals(
    isGlubeanFile(`import { task } from "@glubean/runner";`),
    true,
  );
});

Deno.test("isGlubeanFile rejects identifiers that only contain test/task substring", () => {
  // "latestResult" contains "test" but doesn't end with Test/Task
  assertEquals(
    isGlubeanFile(`import { latestResult } from "./utils.ts";`),
    false,
  );
  // "multitask" contains "task" but doesn't end with Task
  assertEquals(
    isGlubeanFile(`import { multitask } from "./parallel.ts";`),
    false,
  );
});

// =============================================================================
// variant field
// =============================================================================

Deno.test("variant is undefined for simple tests", () => {
  const content = `
export const simple = test("simple-test", async (ctx) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].variant, undefined);
});

Deno.test("variant is undefined for builder tests", () => {
  const content = `
export const flow = test("my-flow")
  .step("login", async (ctx) => {})
  .step("verify", async (ctx) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].variant, undefined);
});

Deno.test("variant is 'each' for test.each()", () => {
  const content = `
export const userTests = test.each(users)(
  "get-user-$id",
  async (ctx, { id }) => {}
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].variant, "each");
});

Deno.test("variant is 'pick' for test.pick()", () => {
  const content = `
export const searchTests = test.pick({
  "by-name": { q: "phone" },
})("search-$_pick", async (ctx, data) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].variant, "pick");
});

Deno.test("variant is 'each' for test.each() builder mode", () => {
  const content = `
export const scenarios = test.each(data)({
  id: "scenario-$id",
  tags: ["scenario"],
})
  .step("request", async (ctx) => {})
  .step("verify", async (ctx) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].variant, "each");
  assertEquals(result[0].steps, [{ name: "request" }, { name: "verify" }]);
});

Deno.test("mixed file: variant set correctly per test", () => {
  const content = `
import { test } from "@glubean/sdk";

export const health = test("health", async (ctx) => {});

export const items = test.each(data)("item-$id", async (ctx, row) => {});

export const search = test.pick(examples)("search-$_pick", async (ctx, d) => {});

export const flow = test("crud-flow").step("create", async () => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 4);
  assertEquals(result[0].id, "health");
  assertEquals(result[0].variant, undefined);
  assertEquals(result[1].id, "item-$id");
  assertEquals(result[1].variant, "each");
  assertEquals(result[2].id, "search-$_pick");
  assertEquals(result[2].variant, "pick");
  assertEquals(result[3].id, "crud-flow");
  assertEquals(result[3].variant, undefined);
});

// =============================================================================
// Extended function names (*Test, *Task, task)
// =============================================================================

Deno.test("extracts test from custom *Test function (test.extend)", () => {
  const content = `
import { browserTest } from "./configure.ts";

export const homepageLoads = browserTest(
  { id: "landing-homepage-loads", tags: ["smoke"] },
  async ({ page }) => {}
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "landing-homepage-loads");
  assertEquals(result[0].tags, ["smoke"]);
  assertEquals(result[0].exportName, "homepageLoads");
});

Deno.test("extracts test from 'task' base function", () => {
  const content = `
export const deploy = task("deploy-staging", async (ctx) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "deploy-staging");
  assertEquals(result[0].exportName, "deploy");
});

Deno.test("extracts test from custom *Task function", () => {
  const content = `
export const deployProd = deployTask(
  { id: "deploy-prod", tags: ["deploy"] },
  async (ctx) => {}
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "deploy-prod");
  assertEquals(result[0].tags, ["deploy"]);
  assertEquals(result[0].exportName, "deployProd");
});

Deno.test("extracts *Test builder with steps", () => {
  const content = `
export const loginFlow = browserTest("browser-login")
  .meta({ tags: ["e2e"] })
  .step("navigate", async (ctx) => {})
  .step("fill form", async (ctx) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "browser-login");
  assertEquals(result[0].tags, ["e2e"]);
  assertEquals(result[0].steps, [{ name: "navigate" }, { name: "fill form" }]);
});

Deno.test("extracts *Test.each() data-driven pattern", () => {
  const content = `
export const pageTests = browserTest.each(pages)(
  "page-$slug",
  async ({ page }, { slug }) => {}
);
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "page-$slug");
  assertEquals(result[0].variant, "each");
});

Deno.test("extracts *Test.pick() example selection pattern", () => {
  const content = `
export const searchTests = screenshotTest.pick({
  "desktop": { viewport: "1920x1080" },
  "mobile": { viewport: "390x844" },
})("screenshot-$_pick", async ({ page }, data) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "screenshot-$_pick");
  assertEquals(result[0].variant, "pick");
});

Deno.test("does NOT match identifiers that merely contain 'test' or 'task'", () => {
  const content = `
export const latestResult = getLatest("id", async () => {});
export const multitask = parallel("id", async () => {});
export const testResult = something("id", async () => {});
export const attest = verify("id", async () => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 0);
});

Deno.test("mixed file with test, task, *Test, and *Task functions", () => {
  const content = `
export const health = test("health", async (ctx) => {});
export const deploy = task("deploy", async (ctx) => {});
export const login = browserTest("browser-login", async ({ page }) => {});
export const cleanup = cleanupTask("cleanup-db", async (ctx) => {});
`;
  const result = extractFromSource(content);
  assertEquals(result.length, 4);
  assertEquals(result[0].id, "health");
  assertEquals(result[0].exportName, "health");
  assertEquals(result[1].id, "deploy");
  assertEquals(result[1].exportName, "deploy");
  assertEquals(result[2].id, "browser-login");
  assertEquals(result[2].exportName, "login");
  assertEquals(result[3].id, "cleanup-db");
  assertEquals(result[3].exportName, "cleanup");
});

// =============================================================================
// extractAliasesFromSource
// =============================================================================

Deno.test("extractAliasesFromSource finds test.extend aliases", () => {
  const content = `
import { test } from "@glubean/sdk";
export const browserTest = test.extend({ page: pageFixture });
export const screenshotTest = test.extend({ page: screenshotFixture });
`;
  const aliases = extractAliasesFromSource(content);
  assertEquals(aliases, ["browserTest", "screenshotTest"]);
});

Deno.test("extractAliasesFromSource finds chained extend aliases", () => {
  const content = `
const withAuth = test.extend({ auth: authFixture });
const withBoth = withAuth.extend({ db: dbFixture });
`;
  const aliases = extractAliasesFromSource(content);
  assertEquals(aliases, ["withAuth", "withBoth"]);
});

Deno.test("extractAliasesFromSource finds non-convention names", () => {
  const content = `
export const scenario = test.extend({ browser: browserFixture });
const check = scenario.extend({ validator: validatorFixture });
`;
  const aliases = extractAliasesFromSource(content);
  assertEquals(aliases, ["scenario", "check"]);
});

Deno.test("extractAliasesFromSource returns empty for files without extend", () => {
  const content = `
import { test } from "@glubean/sdk";
export const health = test("health", async (ctx) => {});
`;
  assertEquals(extractAliasesFromSource(content), []);
});

Deno.test("extractAliasesFromSource ignores extend in comments", () => {
  const content = `
// const commented = test.extend({ page: fixture });
export const real = test.extend({ page: fixture });
`;
  const aliases = extractAliasesFromSource(content);
  assertEquals(aliases, ["real"]);
});

// =============================================================================
// extractFromSource with explicit customFns
// =============================================================================

Deno.test("extractFromSource with customFns matches non-convention names", () => {
  const content = `
export const login = scenario("login-flow", async (ctx) => {});
export const checkout = workflow({ id: "checkout", tags: ["e2e"] }, async (ctx) => {});
`;
  // Without customFns: convention fallback doesn't match "scenario" or "workflow"
  assertEquals(extractFromSource(content).length, 0);

  // With customFns: explicit match
  const result = extractFromSource(content, ["scenario", "workflow"]);
  assertEquals(result.length, 2);
  assertEquals(result[0].id, "login-flow");
  assertEquals(result[1].id, "checkout");
});

Deno.test("extractFromSource with customFns always includes base test/task", () => {
  const content = `
export const health = test("health", async (ctx) => {});
export const login = scenario("login", async (ctx) => {});
`;
  const result = extractFromSource(content, ["scenario"]);
  assertEquals(result.length, 2);
  assertEquals(result[0].id, "health");
  assertEquals(result[1].id, "login");
});

// =============================================================================
// isGlubeanFile with explicit customFns
// =============================================================================

Deno.test("isGlubeanFile with customFns detects non-convention imports", () => {
  // "scenario" doesn't match *Test/*Task convention
  assertEquals(
    isGlubeanFile(`import { scenario } from "./configure.ts";`),
    false,
  );
  // But with customFns, it's recognized
  assertEquals(
    isGlubeanFile(`import { scenario } from "./configure.ts";`, ["scenario"]),
    true,
  );
});
