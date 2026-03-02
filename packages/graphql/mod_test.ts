/**
 * Tests for the @glubean/graphql plugin package.
 *
 * Includes behavioral baseline tests migrated from the SDK core (Phase 0)
 * plus new tests for the graphql() plugin factory.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  createGraphQLClient,
  gql,
  graphql,
  type GraphQLResponse,
  GraphQLResponseError,
  parseOperationName,
} from "./mod.ts";
import type { HttpClient, HttpRequestOptions, HttpResponsePromise } from "@glubean/sdk";
import type { GlubeanRuntime } from "@glubean/sdk";

// =============================================================================
// Test helpers
// =============================================================================

interface CapturedPost {
  url: string | URL | Request;
  options: HttpRequestOptions;
}

/**
 * Create a mock HttpClient that captures post() calls and returns
 * a configurable GraphQL response.
 */
function createMockGqlHttp(
  responseData: GraphQLResponse = { data: null },
  captures: CapturedPost[] = [],
): HttpClient {
  // deno-lint-ignore no-explicit-any
  const mock: any = function () {
    return Promise.resolve(new Response("mock"));
  };

  const jsonPromise = (response: GraphQLResponse): HttpResponsePromise => {
    const p = Promise.resolve(new Response(JSON.stringify(response)));
    // deno-lint-ignore no-explicit-any
    (p as any).json = () => Promise.resolve(response);
    // deno-lint-ignore no-explicit-any
    (p as any).text = () => Promise.resolve(JSON.stringify(response));
    // deno-lint-ignore no-explicit-any
    (p as any).blob = () => Promise.resolve(new Blob([JSON.stringify(response)]));
    // deno-lint-ignore no-explicit-any
    (p as any).arrayBuffer = () =>
      Promise.resolve(
        new TextEncoder().encode(JSON.stringify(response)).buffer,
      );
    return p as HttpResponsePromise;
  };

  mock.post = (url: string | URL | Request, options?: HttpRequestOptions) => {
    captures.push({ url, options: options ?? {} });
    return jsonPromise(responseData);
  };
  mock.get = mock;
  mock.put = mock;
  mock.patch = mock;
  mock.delete = mock;
  mock.head = mock;
  mock.extend = () => mock;

  return mock as HttpClient;
}

/**
 * Create a minimal GlubeanRuntime mock for plugin factory tests.
 */
function createMockRuntime(
  vars: Record<string, string> = {},
  secrets: Record<string, string> = {},
  http?: HttpClient,
): GlubeanRuntime {
  const allValues = { ...vars, ...secrets };
  return {
    vars,
    secrets,
    http: http ?? createMockGqlHttp({ data: { test: true } }),
    requireVar(key: string): string {
      const val = vars[key];
      if (val === undefined) throw new Error(`Missing var: ${key}`);
      return val;
    },
    requireSecret(key: string): string {
      const val = secrets[key];
      if (val === undefined) throw new Error(`Missing secret: ${key}`);
      return val;
    },
    resolveTemplate(template: string): string {
      return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const val = allValues[key];
        if (val === undefined) return `{{${key}}}`;
        return val;
      });
    },
    action() {},
    event() {},
    log() {},
  };
}

// =============================================================================
// parseOperationName()
// =============================================================================

Deno.test("parseOperationName - named query", () => {
  assertEquals(parseOperationName("query GetUser { user { id } }"), "GetUser");
});

Deno.test("parseOperationName - named mutation", () => {
  assertEquals(
    parseOperationName(
      "mutation CreateUser($input: CreateUserInput!) { createUser(input: $input) { id } }",
    ),
    "CreateUser",
  );
});

Deno.test("parseOperationName - named subscription", () => {
  assertEquals(
    parseOperationName("subscription OnMessage { messages { text } }"),
    "OnMessage",
  );
});

Deno.test("parseOperationName - query with arguments", () => {
  assertEquals(
    parseOperationName("query GetUser($id: ID!) { user(id: $id) { name } }"),
    "GetUser",
  );
});

Deno.test("parseOperationName - anonymous query returns undefined", () => {
  assertEquals(parseOperationName("{ users { id } }"), undefined);
});

Deno.test("parseOperationName - anonymous mutation returns undefined", () => {
  assertEquals(parseOperationName("mutation { deleteAll }"), undefined);
});

Deno.test("parseOperationName - multiline query", () => {
  assertEquals(
    parseOperationName(`
      query ListUsers($limit: Int) {
        users(limit: $limit) { id name }
      }
    `),
    "ListUsers",
  );
});

Deno.test("parseOperationName - underscore-prefixed name", () => {
  assertEquals(
    parseOperationName("query _InternalQuery { data }"),
    "_InternalQuery",
  );
});

// =============================================================================
// gql tagged template
// =============================================================================

Deno.test("gql - simple string", () => {
  const query = gql`
    query GetUser {
      user {
        id
      }
    }
  `;
  assertEquals(query, "query GetUser { user { id } }");
});

Deno.test("gql - with interpolation", () => {
  const field = "name";
  const query = gql`query { user { ${field} } }`;
  assertEquals(query, "query { user { name } }");
});

Deno.test("gql - multiline preserves whitespace", () => {
  const query = gql`
    query GetUser($id: ID!) {
      user(id: $id) {
        name
        email
      }
    }
  `;
  assertEquals(query.includes("query GetUser"), true);
  assertEquals(query.includes("user(id: $id)"), true);
});

Deno.test("gql - with multiple interpolations", () => {
  const type = "User";
  const field = "name";
  const query = gql`query { ${type.toLowerCase()} { ${field} } }`;
  assertEquals(query, "query { user { name } }");
});

// =============================================================================
// GraphQLResponseError
// =============================================================================

Deno.test("GraphQLResponseError - constructor sets errors and response", () => {
  const errors = [{ message: "Not found" }, { message: "Unauthorized" }];
  const response: GraphQLResponse = { data: null, errors };
  const err = new GraphQLResponseError(errors, response);

  assertEquals(err.errors, errors);
  assertEquals(err.response, response);
  assertEquals(err.name, "GraphQLResponseError");
  assertEquals(err.message, "GraphQL errors: Not found; Unauthorized");
  assertEquals(err instanceof Error, true);
});

Deno.test("GraphQLResponseError - single error message", () => {
  const errors = [{ message: "Bad request" }];
  const response: GraphQLResponse = { data: null, errors };
  const err = new GraphQLResponseError(errors, response);

  assertEquals(err.message, "GraphQL errors: Bad request");
});

// =============================================================================
// createGraphQLClient - query
// =============================================================================

Deno.test(
  "createGraphQLClient - query sends POST with correct body",
  async () => {
    const captures: CapturedPost[] = [];
    const mockHttp = createMockGqlHttp(
      { data: { user: { name: "Alice" } } },
      captures,
    );

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
    });

    const result = await client.query<{ user: { name: string } }>(
      "query GetUser($id: ID!) { user(id: $id) { name } }",
      { variables: { id: "1" } },
    );

    assertEquals(captures.length, 1);
    assertEquals(captures[0].url, "https://api.example.com/graphql");

    const body = captures[0].options.json as Record<string, unknown>;
    assertEquals(
      body.query,
      "query GetUser($id: ID!) { user(id: $id) { name } }",
    );
    assertEquals(body.variables, { id: "1" });
    assertEquals(body.operationName, "GetUser");

    assertEquals(result.data?.user.name, "Alice");
  },
);

Deno.test(
  "createGraphQLClient - sets X-Glubean-Op header with operation name",
  async () => {
    const captures: CapturedPost[] = [];
    const mockHttp = createMockGqlHttp({ data: null }, captures);

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
    });

    await client.query("query ListUsers { users { id } }");

    const headers = captures[0].options.headers as Record<string, string>;
    assertEquals(headers["X-Glubean-Op"], "ListUsers");
  },
);

Deno.test(
  "createGraphQLClient - anonymous query uses 'anonymous' in header",
  async () => {
    const captures: CapturedPost[] = [];
    const mockHttp = createMockGqlHttp({ data: { health: "ok" } }, captures);

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
    });

    await client.query("{ health }");

    const headers = captures[0].options.headers as Record<string, string>;
    assertEquals(headers["X-Glubean-Op"], "anonymous");

    const body = captures[0].options.json as Record<string, unknown>;
    assertEquals(body.operationName, undefined);
  },
);

Deno.test(
  "createGraphQLClient - explicit operationName overrides parsed name",
  async () => {
    const captures: CapturedPost[] = [];
    const mockHttp = createMockGqlHttp({ data: null }, captures);

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
    });

    await client.query("query GetUser { user { id } }", {
      operationName: "OverrideName",
    });

    const headers = captures[0].options.headers as Record<string, string>;
    assertEquals(headers["X-Glubean-Op"], "OverrideName");

    const body = captures[0].options.json as Record<string, unknown>;
    assertEquals(body.operationName, "OverrideName");
  },
);

Deno.test("createGraphQLClient - default headers from options", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: null }, captures);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
    headers: {
      Authorization: "Bearer token-123",
      "X-Custom": "value",
    },
  });

  await client.query("{ health }");

  const headers = captures[0].options.headers as Record<string, string>;
  assertEquals(headers["Authorization"], "Bearer token-123");
  assertEquals(headers["X-Custom"], "value");
});

Deno.test(
  "createGraphQLClient - per-request headers override defaults",
  async () => {
    const captures: CapturedPost[] = [];
    const mockHttp = createMockGqlHttp({ data: null }, captures);

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
      headers: {
        Authorization: "Bearer default-token",
        "X-Shared": "shared",
      },
    });

    await client.query("{ health }", {
      headers: { Authorization: "Bearer override-token" },
    });

    const headers = captures[0].options.headers as Record<string, string>;
    assertEquals(headers["Authorization"], "Bearer override-token");
    assertEquals(headers["X-Shared"], "shared");
  },
);

Deno.test("createGraphQLClient - sets throwHttpErrors to false", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: null }, captures);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
  });

  await client.query("{ health }");

  assertEquals(captures[0].options.throwHttpErrors, false);
});

Deno.test(
  "createGraphQLClient - query without variables omits variables from body",
  async () => {
    const captures: CapturedPost[] = [];
    const mockHttp = createMockGqlHttp({ data: null }, captures);

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
    });

    await client.query("{ health }");

    const body = captures[0].options.json as Record<string, unknown>;
    assertEquals(body.variables, undefined);
  },
);

// =============================================================================
// createGraphQLClient - mutate
// =============================================================================

Deno.test(
  "createGraphQLClient - mutate sends POST identically to query",
  async () => {
    const captures: CapturedPost[] = [];
    const mockHttp = createMockGqlHttp(
      { data: { createUser: { id: "42" } } },
      captures,
    );

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
    });

    const result = await client.mutate<{ createUser: { id: string } }>(
      "mutation CreateUser($input: CreateUserInput!) { createUser(input: $input) { id } }",
      { variables: { input: { name: "Alice" } } },
    );

    assertEquals(captures.length, 1);
    assertEquals(captures[0].url, "https://api.example.com/graphql");

    const body = captures[0].options.json as Record<string, unknown>;
    assertEquals(
      body.query,
      "mutation CreateUser($input: CreateUserInput!) { createUser(input: $input) { id } }",
    );
    assertEquals(body.variables, { input: { name: "Alice" } });
    assertEquals(body.operationName, "CreateUser");

    const headers = captures[0].options.headers as Record<string, string>;
    assertEquals(headers["X-Glubean-Op"], "CreateUser");

    assertEquals(result.data?.createUser.id, "42");
  },
);

// =============================================================================
// createGraphQLClient - throwOnGraphQLErrors
// =============================================================================

Deno.test(
  "createGraphQLClient - throwOnGraphQLErrors: false returns errors in response",
  async () => {
    const gqlResponse: GraphQLResponse = {
      data: null,
      errors: [{ message: "Not found" }],
    };
    const mockHttp = createMockGqlHttp(gqlResponse);

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
      throwOnGraphQLErrors: false,
    });

    const result = await client.query("{ user { id } }");
    assertEquals(result.data, null);
    assertEquals(result.errors?.length, 1);
    assertEquals(result.errors?.[0].message, "Not found");
  },
);

Deno.test(
  "createGraphQLClient - default (no throwOnGraphQLErrors) returns errors",
  async () => {
    const gqlResponse: GraphQLResponse = {
      data: null,
      errors: [{ message: "Error" }],
    };
    const mockHttp = createMockGqlHttp(gqlResponse);

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
    });

    const result = await client.query("{ user { id } }");
    assertEquals(result.errors?.length, 1);
  },
);

Deno.test(
  "createGraphQLClient - throwOnGraphQLErrors: true throws GraphQLResponseError",
  async () => {
    const gqlResponse: GraphQLResponse = {
      data: null,
      errors: [{ message: "Not found" }, { message: "Forbidden" }],
    };
    const mockHttp = createMockGqlHttp(gqlResponse);

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
      throwOnGraphQLErrors: true,
    });

    await assertRejects(
      () => client.query("{ user { id } }"),
      GraphQLResponseError,
      "Not found; Forbidden",
    );
  },
);

Deno.test(
  "createGraphQLClient - throwOnGraphQLErrors: true does not throw on success",
  async () => {
    const gqlResponse: GraphQLResponse = {
      data: { user: { id: "1" } },
    };
    const mockHttp = createMockGqlHttp(gqlResponse);

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
      throwOnGraphQLErrors: true,
    });

    const result = await client.query("{ user { id } }");
    assertEquals(result.data, { user: { id: "1" } });
    assertEquals(result.errors, undefined);
  },
);

Deno.test(
  "createGraphQLClient - throwOnGraphQLErrors: true with empty errors array does not throw",
  async () => {
    const gqlResponse: GraphQLResponse = {
      data: { user: { id: "1" } },
      errors: [],
    };
    const mockHttp = createMockGqlHttp(gqlResponse);

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
      throwOnGraphQLErrors: true,
    });

    const result = await client.query("{ user { id } }");
    assertEquals(result.data, { user: { id: "1" } });
  },
);

// =============================================================================
// createGraphQLClient - response with extensions
// =============================================================================

Deno.test(
  "createGraphQLClient - response extensions are preserved",
  async () => {
    const gqlResponse: GraphQLResponse = {
      data: { user: { id: "1" } },
      extensions: { cost: 5, rateLimit: { remaining: 99 } },
    };
    const mockHttp = createMockGqlHttp(gqlResponse);

    const client = createGraphQLClient(mockHttp, {
      endpoint: "https://api.example.com/graphql",
    });

    const result = await client.query("{ user { id } }");
    assertEquals(result.extensions?.cost, 5);
  },
);

// =============================================================================
// graphql() plugin factory
// =============================================================================

Deno.test("graphql() - returns a PluginFactory with create method", () => {
  const factory = graphql({ endpoint: "https://api.example.com/graphql" });
  assertEquals(typeof factory.create, "function");
});

Deno.test("graphql() - create() produces a GraphQLClient", () => {
  const factory = graphql({ endpoint: "https://api.example.com/graphql" });
  const runtime = createMockRuntime();
  const client = factory.create(runtime);

  assertEquals(typeof client.query, "function");
  assertEquals(typeof client.mutate, "function");
});

Deno.test("graphql() - resolves endpoint templates", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: { ok: true } }, captures);
  const runtime = createMockRuntime(
    { graphql_url: "https://resolved.example.com/graphql" },
    {},
    mockHttp,
  );

  const factory = graphql({ endpoint: "{{graphql_url}}" });
  const client = factory.create(runtime);

  await client.query("{ health }");
  assertEquals(captures[0].url, "https://resolved.example.com/graphql");
});

Deno.test("graphql() - resolves header templates from secrets", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: null }, captures);
  const runtime = createMockRuntime(
    { graphql_url: "https://api.example.com/graphql" },
    { api_key: "secret-token-123" },
    mockHttp,
  );

  const factory = graphql({
    endpoint: "{{graphql_url}}",
    headers: { Authorization: "Bearer {{api_key}}" },
  });
  const client = factory.create(runtime);

  await client.query("{ health }");
  const headers = captures[0].options.headers as Record<string, string>;
  assertEquals(headers["Authorization"], "Bearer secret-token-123");
});

Deno.test("graphql() - preserves throwOnGraphQLErrors option", async () => {
  const mockHttp = createMockGqlHttp({
    data: null,
    errors: [{ message: "Fail" }],
  });
  const runtime = createMockRuntime(
    { graphql_url: "https://api.example.com/graphql" },
    {},
    mockHttp,
  );

  const factory = graphql({
    endpoint: "{{graphql_url}}",
    throwOnGraphQLErrors: true,
  });
  const client = factory.create(runtime);

  await assertRejects(
    () => client.query("{ health }"),
    GraphQLResponseError,
    "Fail",
  );
});
