/**
 * OpenAPI Patch — a concise YAML DSL for supplementing incomplete OpenAPI specs.
 *
 * Format:
 * ```yaml
 * endpoints:
 *   /open/v1/whoami:
 *     get:
 *       summary: Get current identity
 *       200:
 *         kind: string
 *         userId?: string
 *       401: Unauthorized
 *
 * schemas:
 *   Project:
 *     id: string
 *     name: string
 *
 * raw:
 *   components:
 *     securitySchemes: ...
 * ```
 *
 * Merge order: base spec → raw (deep merge) → endpoints/schemas (converted to OpenAPI, deep merge)
 */

import { parse as yamlParse } from "@std/yaml";
// deno-lint-ignore no-explicit-any
type OpenApiSpec = Record<string, any>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed patch file structure. */
export interface PatchFile {
  /** path → method → operation patch */
  endpoints?: Record<string, Record<string, OperationPatch>>;
  schemas?: Record<string, Record<string, unknown>>;
  // deno-lint-ignore no-explicit-any
  raw?: Record<string, any>;
}

/** A single operation patch (under a method key). */
export interface OperationPatch {
  summary?: string;
  description?: string;
  body?: Record<string, string>;
  [statusOrField: string]: unknown;
}

// Type shorthand mappings
const TYPE_MAP: Record<string, { type: string; format?: string }> = {
  string: { type: "string" },
  number: { type: "number" },
  integer: { type: "integer" },
  boolean: { type: "boolean" },
  datetime: { type: "string", format: "date-time" },
  date: { type: "string", format: "date" },
  email: { type: "string", format: "email" },
  uri: { type: "string", format: "uri" },
  url: { type: "string", format: "uri" },
  uuid: { type: "string", format: "uuid" },
};

// ---------------------------------------------------------------------------
// Patch file discovery & loading
// ---------------------------------------------------------------------------

const PATCH_EXTENSIONS = [".patch.yaml", ".patch.yml", ".patch.json"];

/**
 * Given an OpenAPI spec path, find the corresponding patch file.
 * e.g. `openapi.json` → `openapi.patch.yaml`
 */
export async function findPatchFile(
  specPath: string,
): Promise<string | null> {
  // Extract base name without extension
  const lastDot = specPath.lastIndexOf(".");
  const base = lastDot > 0 ? specPath.substring(0, lastDot) : specPath;

  for (const ext of PATCH_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    try {
      await Deno.stat(candidate);
      return candidate;
    } catch {
      // not found
    }
  }
  return null;
}

/**
 * Load and parse a patch file.
 */
export async function loadPatchFile(path: string): Promise<PatchFile> {
  const content = await Deno.readTextFile(path);
  return parsePatchContent(content);
}

/**
 * Parse patch file content (YAML or JSON string) into a PatchFile.
 */
export function parsePatchContent(content: string): PatchFile {
  const parsed = yamlParse(content) as PatchFile;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// DSL → OpenAPI conversion
// ---------------------------------------------------------------------------

/**
 * Parse a type string like "string", "number", "Project[]", "string[]"
 * into an OpenAPI schema object.
 */
// deno-lint-ignore no-explicit-any
function parseTypeString(typeStr: string, schemas?: Record<string, Record<string, unknown>>): Record<string, any> {
  // Array type: "string[]" or "Project[]"
  if (typeStr.endsWith("[]")) {
    const inner = typeStr.slice(0, -2);
    return {
      type: "array",
      items: parseTypeString(inner, schemas),
    };
  }

  // Enum type: "user" | "project"
  if (typeStr.includes("|")) {
    const values = typeStr.split("|").map((v) => v.trim().replace(/^["']|["']$/g, ""));
    return { type: "string", enum: values };
  }

  // Known primitive type
  const mapped = TYPE_MAP[typeStr.toLowerCase()];
  if (mapped) {
    return { ...mapped };
  }

  // Schema reference: check if it's defined in schemas section
  if (schemas && schemas[typeStr]) {
    return { $ref: `#/components/schemas/${typeStr}` };
  }

  // Unknown type — treat as string
  return { type: "string" };
}

/**
 * Check if a string value looks like a type expression.
 * Returns true for: known types, "Type[]", '"a" | "b"', schema references.
 */
function isTypeExpression(value: string, schemas?: Record<string, Record<string, unknown>>): boolean {
  // Array syntax
  if (value.endsWith("[]")) return true;
  // Enum syntax
  if (value.includes("|")) return true;
  // Known primitive type
  if (TYPE_MAP[value.toLowerCase()]) return true;
  // Schema reference
  if (schemas && schemas[value]) return true;
  return false;
}

/** Validation keys that map directly to OpenAPI schema properties. */
const VALIDATION_KEYS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "enum",
  "example",
  "default",
  "format",
]);

/**
 * Convert a field map into an OpenAPI schema object with properties and required array.
 *
 * Field values can be:
 * - string matching a type: `kind: string`, `items: Project[]`
 * - string NOT matching a type: treated as description, defaults to string
 * - object: `{ type, description, minimum, ... }` for rich metadata + validations
 */
function fieldsToSchema(
  fields: Record<string, unknown>,
  schemas?: Record<string, Record<string, unknown>>,
  // deno-lint-ignore no-explicit-any
): Record<string, any> {
  // deno-lint-ignore no-explicit-any
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [rawKey, fieldValue] of Object.entries(fields)) {
    const optional = rawKey.endsWith("?");
    const key = optional ? rawKey.slice(0, -1) : rawKey;

    if (typeof fieldValue === "string") {
      if (isTypeExpression(fieldValue, schemas)) {
        // Type shorthand: "kind: string"
        properties[key] = parseTypeString(fieldValue, schemas);
      } else {
        // Description: "kind: Identity type of the caller"
        properties[key] = { type: "string", description: fieldValue };
      }
    } else if (typeof fieldValue === "object" && fieldValue !== null) {
      // Record: "kind: { type: string, description: ..., minimum: 0 }"
      const obj = fieldValue as Record<string, unknown>;
      const typeStr = typeof obj.type === "string" ? obj.type : "string";
      const parsed = parseTypeString(typeStr, schemas);
      if (obj.description) parsed.description = obj.description;
      // Copy all validation keys
      for (const vKey of VALIDATION_KEYS) {
        if (obj[vKey] !== undefined) parsed[vKey] = obj[vKey];
      }
      properties[key] = parsed;
    } else {
      properties[key] = { type: "string" };
    }

    if (!optional) {
      required.push(key);
    }
  }

  // deno-lint-ignore no-explicit-any
  const schema: Record<string, any> = { type: "object", properties };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

/**
 * Check if a string is a valid HTTP status code.
 */
function isStatusCode(key: string): boolean {
  return /^\d{3}$/.test(key);
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

/**
 * Convert the entire PatchFile into standard OpenAPI structure
 * suitable for deep merging into a base spec.
 */
export function patchToOpenApi(patch: PatchFile): OpenApiSpec {
  // deno-lint-ignore no-explicit-any
  const result: Record<string, any> = {};

  // 1. Convert schemas
  if (patch.schemas) {
    result.components = { schemas: {} };
    for (const [name, fields] of Object.entries(patch.schemas)) {
      result.components.schemas[name] = fieldsToSchema(fields, patch.schemas);
    }
  }

  // 2. Convert endpoints (path → method → operation)
  if (patch.endpoints) {
    result.paths = {};
    for (const [path, methods] of Object.entries(patch.endpoints)) {
      if (!result.paths[path]) {
        result.paths[path] = {};
      }

      for (const [method, opPatch] of Object.entries(methods)) {
        if (!HTTP_METHODS.has(method.toLowerCase())) continue;

        // deno-lint-ignore no-explicit-any
        const operation: Record<string, any> = {};

        // Simple metadata
        if (opPatch.summary) operation.summary = opPatch.summary;
        if (opPatch.description) operation.description = opPatch.description;
        if (opPatch.deprecated) operation.deprecated = opPatch.deprecated;
        if (opPatch.tags) operation.tags = opPatch.tags;

        // Request body
        if (opPatch.body && typeof opPatch.body === "object") {
          operation.requestBody = {
            required: true,
            content: {
              "application/json": {
                schema: fieldsToSchema(
                  opPatch.body as Record<string, string>,
                  patch.schemas,
                ),
              },
            },
          };
        }

        // Responses — any key that is a status code
        for (const [rKey, rValue] of Object.entries(opPatch)) {
          if (!isStatusCode(rKey)) continue;

          if (typeof rValue === "string") {
            if (!operation.responses) operation.responses = {};
            operation.responses[rKey] = { description: rValue };
          } else if (typeof rValue === "object" && rValue !== null) {
            if (!operation.responses) operation.responses = {};
            operation.responses[rKey] = {
              description: "",
              content: {
                "application/json": {
                  schema: fieldsToSchema(
                    rValue as Record<string, string>,
                    patch.schemas,
                  ),
                },
              },
            };
          }
        }

        result.paths[path][method.toLowerCase()] = operation;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Deep Merge
// ---------------------------------------------------------------------------

/**
 * Deep merge source into target. Source values override target values.
 * Arrays are replaced, not concatenated.
 */
// deno-lint-ignore no-explicit-any
export function deepMerge(target: any, source: any): any {
  if (source == null) return target;
  if (target == null) return source;

  if (typeof target !== "object" || typeof source !== "object") {
    return source;
  }

  if (Array.isArray(source)) {
    return source;
  }

  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      key in result && typeof result[key] === "object" && typeof source[key] === "object" && !Array.isArray(source[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API: apply patch to spec
// ---------------------------------------------------------------------------

/**
 * Apply a patch file to an OpenAPI spec.
 * Merge order: base → raw → converted endpoints/schemas
 */
export function applyPatch(spec: OpenApiSpec, patch: PatchFile): OpenApiSpec {
  let result = spec;

  // 1. Apply raw section first (lowest priority override)
  if (patch.raw) {
    result = deepMerge(result, patch.raw);
  }

  // 2. Convert DSL and merge (highest priority)
  const converted = patchToOpenApi(patch);
  result = deepMerge(result, converted);

  return result;
}
