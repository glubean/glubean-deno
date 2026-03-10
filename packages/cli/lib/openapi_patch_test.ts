import { assertEquals } from "@std/assert";
import { applyPatch, deepMerge, parsePatchContent, patchToOpenApi } from "./openapi_patch.ts";

// ---------------------------------------------------------------------------
// parsePatchContent
// ---------------------------------------------------------------------------

Deno.test("parsePatchContent: nested path/method/response", () => {
  const yaml = `
endpoints:
  /api/whoami:
    get:
      200:
        kind: string
        userId?: string
`;
  const patch = parsePatchContent(yaml);
  const get = patch.endpoints!["/api/whoami"].get;
  assertEquals((get["200"] as Record<string, string>).kind, "string");
  assertEquals((get["200"] as Record<string, string>)["userId?"], "string");
});

Deno.test("parsePatchContent: description-only response", () => {
  const yaml = `
endpoints:
  /api/whoami:
    get:
      401: Unauthorized
`;
  const patch = parsePatchContent(yaml);
  assertEquals(patch.endpoints!["/api/whoami"].get["401"], "Unauthorized");
});

Deno.test("parsePatchContent: schemas section", () => {
  const yaml = `
schemas:
  Project:
    id: string
    name: string
    isPublic: boolean
`;
  const patch = parsePatchContent(yaml);
  assertEquals(patch.schemas?.Project.id, "string");
  assertEquals(patch.schemas?.Project.isPublic, "boolean");
});

Deno.test("parsePatchContent: raw section preserved", () => {
  const yaml = `
raw:
  components:
    securitySchemes:
      BearerAuth:
        type: http
        scheme: bearer
`;
  const patch = parsePatchContent(yaml);
  assertEquals(patch.raw?.components?.securitySchemes?.BearerAuth?.type, "http");
});

Deno.test("parsePatchContent: multiple methods on same path", () => {
  const yaml = `
endpoints:
  /projects:
    get:
      200:
        items: string[]
    post:
      body:
        name: string
      201:
        id: string
`;
  const patch = parsePatchContent(yaml);
  assertEquals(patch.endpoints!["/projects"].get != null, true);
  assertEquals(patch.endpoints!["/projects"].post != null, true);
});

// ---------------------------------------------------------------------------
// patchToOpenApi
// ---------------------------------------------------------------------------

Deno.test("patchToOpenApi: converts endpoint with object response to OpenAPI", () => {
  const patch = parsePatchContent(`
endpoints:
  /api/whoami:
    get:
      summary: Get identity
      200:
        kind: string
        userId?: string
`);
  const result = patchToOpenApi(patch);

  assertEquals(result.paths["/api/whoami"].get.summary, "Get identity");

  const schema = result.paths["/api/whoami"].get.responses["200"].content["application/json"].schema;
  assertEquals(schema.type, "object");
  assertEquals(schema.properties.kind, { type: "string" });
  assertEquals(schema.properties.userId, { type: "string" });
  assertEquals(schema.required, ["kind"]);
});

Deno.test("patchToOpenApi: converts string response to description only", () => {
  const patch = parsePatchContent(`
endpoints:
  /api/whoami:
    get:
      401: Unauthorized
`);
  const result = patchToOpenApi(patch);
  assertEquals(result.paths["/api/whoami"].get.responses["401"], {
    description: "Unauthorized",
  });
});

Deno.test("patchToOpenApi: converts request body", () => {
  const patch = parsePatchContent(`
endpoints:
  /projects:
    post:
      body:
        name: string
        teamId: string
      201:
        shortId: string
`);
  const result = patchToOpenApi(patch);

  const bodySchema = result.paths["/projects"].post.requestBody.content["application/json"].schema;
  assertEquals(bodySchema.properties.name, { type: "string" });
  assertEquals(bodySchema.required.includes("name"), true);
  assertEquals(bodySchema.required.includes("teamId"), true);
});

Deno.test("patchToOpenApi: enum type via pipe syntax", () => {
  const patch = parsePatchContent(`
endpoints:
  /api/whoami:
    get:
      200:
        kind: '"user" | "project"'
`);
  const result = patchToOpenApi(patch);
  const schema = result.paths["/api/whoami"].get.responses["200"].content["application/json"].schema;
  assertEquals(schema.properties.kind, { type: "string", enum: ["user", "project"] });
});

Deno.test("patchToOpenApi: array type", () => {
  const patch = parsePatchContent(`
endpoints:
  /projects:
    get:
      200:
        items: string[]
`);
  const result = patchToOpenApi(patch);
  const schema = result.paths["/projects"].get.responses["200"].content["application/json"].schema;
  assertEquals(schema.properties.items, { type: "array", items: { type: "string" } });
});

Deno.test("patchToOpenApi: datetime format shorthand", () => {
  const patch = parsePatchContent(`
endpoints:
  /projects/{id}:
    get:
      200:
        createdAt: datetime
`);
  const result = patchToOpenApi(patch);
  const schema = result.paths["/projects/{id}"].get.responses["200"].content["application/json"].schema;
  assertEquals(schema.properties.createdAt, { type: "string", format: "date-time" });
});

Deno.test("patchToOpenApi: schema reference via schemas section", () => {
  const patch = parsePatchContent(`
schemas:
  Project:
    id: string
    name: string

endpoints:
  /projects:
    get:
      200:
        items: Project[]
`);
  const result = patchToOpenApi(patch);

  assertEquals(result.components.schemas.Project.properties.id, { type: "string" });

  const schema = result.paths["/projects"].get.responses["200"].content["application/json"].schema;
  assertEquals(schema.properties.items, {
    type: "array",
    items: { $ref: "#/components/schemas/Project" },
  });
});

Deno.test("patchToOpenApi: multiple methods on same path", () => {
  const patch = parsePatchContent(`
endpoints:
  /projects/{id}/tokens:
    post:
      201:
        id: string
        token: string
    get:
      200:
        tokens: string[]
`);
  const result = patchToOpenApi(patch);
  assertEquals(result.paths["/projects/{id}/tokens"].post.responses["201"] != null, true);
  assertEquals(result.paths["/projects/{id}/tokens"].get.responses["200"] != null, true);
});

// ---------------------------------------------------------------------------
// String as description (not a type)
// ---------------------------------------------------------------------------

Deno.test("patchToOpenApi: non-type string becomes description", () => {
  const patch = parsePatchContent(`
endpoints:
  /api/whoami:
    get:
      200:
        kind: Identity type of the caller
        userId?: string
`);
  const result = patchToOpenApi(patch);
  const schema = result.paths["/api/whoami"].get.responses["200"].content["application/json"].schema;
  assertEquals(schema.properties.kind, { type: "string", description: "Identity type of the caller" });
  assertEquals(schema.properties.userId, { type: "string" });
  // "kind" is still required (no ?)
  assertEquals(schema.required, ["kind"]);
});

// ---------------------------------------------------------------------------
// Record with validations
// ---------------------------------------------------------------------------

Deno.test("patchToOpenApi: record with type + description + validations", () => {
  const patch = parsePatchContent(`
endpoints:
  /api/items:
    get:
      200:
        count:
          type: integer
          description: Number of items returned
          minimum: 0
          maximum: 100
        name:
          type: string
          description: Display name
          minLength: 1
          maxLength: 255
          example: "My Project"
`);
  const result = patchToOpenApi(patch);
  const schema = result.paths["/api/items"].get.responses["200"].content["application/json"].schema;
  assertEquals(schema.properties.count, {
    type: "integer",
    description: "Number of items returned",
    minimum: 0,
    maximum: 100,
  });
  assertEquals(schema.properties.name, {
    type: "string",
    description: "Display name",
    minLength: 1,
    maxLength: 255,
    example: "My Project",
  });
});

Deno.test("patchToOpenApi: record with pattern and default", () => {
  const patch = parsePatchContent(`
endpoints:
  /api/users:
    post:
      body:
        email:
          type: email
          description: User email address
          pattern: "^[^@]+@[^@]+$"
        role:
          type: string
          default: viewer
          enum: [viewer, editor, admin]
`);
  const result = patchToOpenApi(patch);
  const bodySchema = result.paths["/api/users"].post.requestBody.content["application/json"].schema;
  assertEquals(bodySchema.properties.email, {
    type: "string",
    format: "email",
    description: "User email address",
    pattern: "^[^@]+@[^@]+$",
  });
  assertEquals(bodySchema.properties.role, {
    type: "string",
    default: "viewer",
    enum: ["viewer", "editor", "admin"],
  });
});

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

Deno.test("deepMerge: merges nested objects", () => {
  const target = { a: { b: 1, c: 2 } };
  const source = { a: { c: 3, d: 4 } };
  assertEquals(deepMerge(target, source), { a: { b: 1, c: 3, d: 4 } });
});

Deno.test("deepMerge: source replaces arrays", () => {
  const target = { a: [1, 2] };
  const source = { a: [3] };
  assertEquals(deepMerge(target, source), { a: [3] });
});

Deno.test("deepMerge: adds new keys", () => {
  const target = { a: 1 };
  const source = { b: 2 };
  assertEquals(deepMerge(target, source), { a: 1, b: 2 });
});

Deno.test("deepMerge: handles null/undefined", () => {
  assertEquals(deepMerge(null, { a: 1 }), { a: 1 });
  assertEquals(deepMerge({ a: 1 }, null), { a: 1 });
});

// ---------------------------------------------------------------------------
// applyPatch (integration)
// ---------------------------------------------------------------------------

Deno.test("applyPatch: merges patch into spec, adding missing response schemas", () => {
  const spec = {
    openapi: "3.0.0",
    paths: {
      "/open/v1/whoami": {
        get: {
          operationId: "WhoamiController_whoami",
          summary: "Identify the caller",
          responses: {
            "200": { description: "Success" },
            "401": { description: "Unauthorized" },
          },
        },
      },
    },
  };

  const patch = parsePatchContent(`
endpoints:
  /open/v1/whoami:
    get:
      200:
        kind: string
        userId?: string
        projectId?: string
`);

  const result = applyPatch(spec, patch);

  // Original fields preserved
  assertEquals(result.paths["/open/v1/whoami"].get.operationId, "WhoamiController_whoami");
  assertEquals(result.paths["/open/v1/whoami"].get.summary, "Identify the caller");

  // Response schema added
  const schema = result.paths["/open/v1/whoami"].get.responses["200"].content["application/json"].schema;
  assertEquals(schema.type, "object");
  assertEquals(schema.properties.kind, { type: "string" });
  assertEquals(schema.properties.userId, { type: "string" });
  assertEquals(schema.required, ["kind"]);

  // 401 untouched
  assertEquals(result.paths["/open/v1/whoami"].get.responses["401"].description, "Unauthorized");
});

Deno.test("applyPatch: raw section merged before endpoints", () => {
  const spec = { openapi: "3.0.0", paths: {} };

  const patch = parsePatchContent(`
raw:
  info:
    title: My API
    version: "1.0"

endpoints:
  /health:
    get:
      200:
        status: string
`);

  const result = applyPatch(spec, patch);
  assertEquals(result.info.title, "My API");
  assertEquals(result.paths["/health"].get.responses["200"].content["application/json"].schema.properties.status, {
    type: "string",
  });
});
