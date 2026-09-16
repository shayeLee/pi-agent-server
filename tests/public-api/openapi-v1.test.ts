import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import {
  openapiV1,
  PUBLIC_API_AUTOMATIC_HEAD_OPERATIONS,
  PUBLIC_API_OPERATIONS,
} from "../../src/public-api/openapi-v1.js";
import { SSE_EVENT_TYPES } from "../../src/public-api/contract.js";
import { ROUTE_PERMISSIONS } from "../../src/server/route-rbac.js";
import { DEFAULT_PROJECT_ID, type SessionStorePort } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../helpers/ip-access.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { FailbackLifecycleEvent } from "../../src/agent/failback-lifecycle.js";

const document = openapiV1 as unknown as {
  openapi: string;
  paths: Record<string, Record<string, { operationId: string; [key: string]: unknown }>>;
  components: { schemas: Record<string, Record<string, unknown>> };
};

const ROLE_IP = "10.0.0.9";

class FailbackExportAdapter extends MockAgentAdapter {
  private readonly failbackListeners = new Set<(event: FailbackLifecycleEvent) => void>();
  private startResolve!: () => void;
  private readonly started = new Promise<void>((resolve) => { this.startResolve = resolve; });
  private releaseResolve!: () => void;
  private readonly release = new Promise<void>((resolve) => { this.releaseResolve = resolve; });

  constructor() {
    super();
    this.exportData = {
      messages: [],
      timeline: [{ id: "system-event:failback-1", type: "system_event", event: "model_failback", from: "primary/model", to: "fallback/model", reason: "rate_limit", order: 0 }],
    };
  }

  subscribeFailbackLifecycle(listener: (event: FailbackLifecycleEvent) => void): () => void {
    this.failbackListeners.add(listener);
    return () => this.failbackListeners.delete(listener);
  }

  override async prompt(text: string): Promise<void> {
    await super.prompt(text);
    for (const listener of this.failbackListeners) listener({ version: 1, sessionId: "failback-session", phase: "start", attemptId: "failback-1" });
    this.startResolve();
    await this.release;
  }

  waitForStart(): Promise<void> { return this.started; }

  finish(): void {
    for (const listener of this.failbackListeners) listener({ version: 1, sessionId: "failback-session", phase: "end", attemptId: "failback-1", outcome: "cancelled" });
    this.releaseResolve();
  }
}

/** 直接向存储播种会话：SSE 路由需要记录存在，测试无需经 HTTP 创建。 */
function seedSession(sessions: SessionStorePort, id: string): Promise<void> {
  return sessions.create({
    id,
    ownerKey: identityKey({ kind: "ip", ip: "10.0.0.1" }),
    projectId: DEFAULT_PROJECT_ID,
    title: "contract events",
    createdAt: 1,
    updatedAt: 1,
    agentKind: "pi",
    conversationFormat: "pi-jsonl-v3",
    conversationRef: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    systemPrompt: null,
    capabilityVersions: null,
  });
}

async function makeApp(role?: "admin" | "user" | "viewer" | "operator") {
  const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/public-api" });
  return buildApp({
    sessions,
    projects,
    defaultProjectCwd: "/tmp/public-api",
    defaultModel: null,
    modelCatalog: { getAvailable: async () => [], isAvailable: async () => false },
    ipAccess: makeTestIpAccess(role === undefined ? {} : { policy: makePolicy([{ ip: ROLE_IP, role }]) }),
    createAdapter: async () => new MockAgentAdapter(),
  });
}

function schemaMatches(value: unknown, schema: Record<string, unknown>): boolean {
  if (typeof schema.$ref === "string") {
    return schemaMatches(value, document.components.schemas[schema.$ref.split("/").at(-1)!]!);
  }
  if (Array.isArray(schema.oneOf)) return schema.oneOf.some((item) => schemaMatches(value, item as Record<string, unknown>));
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((item) => schemaMatches(value, item as Record<string, unknown>));
  if (schema.const !== undefined && value !== schema.const) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types[0] !== undefined) {
    const valid = types.some((type) =>
      type === "object" ? typeof value === "object" && value !== null && !Array.isArray(value)
        : type === "array" ? Array.isArray(value)
          : type === "string" ? typeof value === "string"
            : type === "number" ? typeof value === "number"
              : type === "integer" ? typeof value === "number" && Number.isInteger(value)
                : type === "boolean" ? typeof value === "boolean"
                  : type === "null" ? value === null : true,
    );
    if (!valid) return false;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(schema.required) && schema.required.some((key) => !(key as string in record))) return false;
    const properties = typeof schema.properties === "object" && schema.properties !== null
      ? schema.properties as Record<string, Record<string, unknown>> : undefined;
    if (schema.additionalProperties === false && properties !== undefined &&
      Object.keys(record).some((key) => !(key in properties))) return false;
    if (properties !== undefined) {
      for (const [key, property] of Object.entries(properties)) {
        if (key in record && !schemaMatches(record[key], property)) return false;
      }
    }
  }
  if (Array.isArray(value) && typeof schema.items === "object" && schema.items !== null) {
    return value.every((item) => schemaMatches(item, schema.items as Record<string, unknown>));
  }
  return true;
}

/**
 * Parse `app.printRoutes({ commonPrefix: false })` into the real `(path, method)` set.
 * The tree indents children by four characters and terminates each segment with its method
 * list in parentheses; `:param` placeholders are normalized to the OpenAPI `{param}` form.
 */
function parsePrintedRoutes(printed: string): Array<[string, string]> {
  const stack: string[] = [];
  const routes: Array<[string, string]> = [];
  for (const line of printed.split("\n")) {
    const match = /^([\u2502 ]*)[\u251c\u2514]\u2500\u2500 (.*)$/.exec(line);
    if (match === null) continue;
    const depth = match[1]!.length / 4;
    const label = match[2]!;
    const methods = / \(([A-Z, ]+)\)$/.exec(label);
    const segment = methods === null ? label : label.slice(0, -methods[0].length);
    stack[depth] = segment;
    stack.length = depth + 1;
    if (methods === null) continue;
    const path = stack.join("").replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}");
    for (const method of methods[1]!.split(", ")) routes.push([path, method.toLowerCase()]);
  }
  return routes;
}

describe("public host API v1 contract", () => {
  it("declares exactly the routes Fastify really registers, so a new undeclared route fails", async () => {
    // Reverse check: parse the live route table instead of trusting the exported lists. The
    // implementation set (business operations + Fastify's automatic HEAD derivatives) must equal
    // the documented operation set; adding a route without documenting it turns this red.
    const app = await makeApp();
    try {
      await app.ready();
      const realRoutes = parsePrintedRoutes(app.printRoutes({ commonPrefix: false }));
      const documentedRoutes = Object.entries(document.paths).flatMap(([path, item]) =>
        Object.entries(item).map(([method]) => [path, method] as [string, string]),
      );
      const normalize = (routes: Array<[string, string]>) =>
        routes.map(([path, method]) => `${method.toUpperCase()} ${path}`).sort();
      expect(normalize(realRoutes)).toEqual(normalize(documentedRoutes));
      // The parsed set is not vacuous: it is exactly the exported business + automatic HEAD lists.
      expect(normalize(realRoutes)).toEqual(
        normalize([...PUBLIC_API_OPERATIONS, ...PUBLIC_API_AUTOMATIC_HEAD_OPERATIONS]
          .map(([path, method]) => [path, method] as [string, string])),
      );
    } finally {
      await app.close();
    }
  });

  it("is OpenAPI 3.1.1 with unique fixed operations, no capabilities, and eleven SSE data variants", () => {
    expect(document.openapi).toBe("3.1.1");
    const operations = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item).map(([method, operation]) => ({ path, method, operation })),
    );
    const businessOperations = operations.filter(({ method }) => method !== "head");
    const automaticHeadOperations = operations.filter(({ method }) => method === "head");
    // The public collection intentionally excludes Fastify-generated HEAD routes:
    // they are transport derivatives, not separately registered business operations.
    expect(businessOperations.map(({ operation }) => operation.operationId)).toHaveLength(PUBLIC_API_OPERATIONS.length);
    expect(automaticHeadOperations.map(({ operation }) => operation.operationId)).toHaveLength(PUBLIC_API_AUTOMATIC_HEAD_OPERATIONS.length);
    expect(automaticHeadOperations.map(({ path, method, operation }) => [
      path,
      method,
      (operation["x-pi-rbac"] as { permission?: string } | undefined)?.permission,
    ])).toEqual(PUBLIC_API_AUTOMATIC_HEAD_OPERATIONS);
    expect(new Set(operations.map(({ operation }) => operation.operationId)).size).toBe(operations.length);
    for (const { operation } of automaticHeadOperations) {
      const responses = operation.responses as Record<string, Record<string, unknown>>;
      expect(Object.values(responses).every((response) => response.content === undefined)).toBe(true);
    }
    expect(Object.keys(document.paths)).not.toContain("/v1/capabilities");
    expect(JSON.stringify(document)).not.toContain("/v1/capabilities");
    expect(SSE_EVENT_TYPES).toHaveLength(12);
    expect(document.components.schemas.SseEvent!.oneOf).toHaveLength(12);
  });

  it("maps every documented fixed operation to Fastify and its central RBAC permission", async () => {
    const app = await makeApp();
    try {
      await app.ready();
      for (const [path, method, permission] of PUBLIC_API_OPERATIONS) {
        const fastifyPath = path.replaceAll("{id}", ":id");
        expect(app.hasRoute({ method: method.toUpperCase(), url: fastifyPath })).toBe(true);
        const documented = document.paths[path]![method]!;
        expect(documented["x-pi-rbac"]).toEqual({ permission, roles: ROUTE_PERMISSIONS[permission] });
      }
      // `printRoutes()` confirms this exact GET-derived set; `hasRoute()` makes the
      // assertion insensitive to printRoutes' tree formatting.
      const printedRoutes = app.printRoutes({ commonPrefix: false });
      expect(printedRoutes).toContain("/health (GET, HEAD)");
      for (const [path, method, permission] of PUBLIC_API_AUTOMATIC_HEAD_OPERATIONS) {
        const fastifyPath = path.replaceAll("{id}", ":id");
        expect(app.hasRoute({ method: method.toUpperCase(), url: fastifyPath })).toBe(true);
        const documented = document.paths[path]![method]!;
        expect(documented["x-pi-rbac"]).toEqual({ permission, roles: ROUTE_PERMISSIONS[permission] });
      }
      // These GET routes opt out at registration and therefore are not contract HEAD operations.
      expect(app.hasRoute({ method: "HEAD", url: "/readyz" })).toBe(false);
      expect(app.hasRoute({ method: "HEAD", url: "/metrics" })).toBe(false);
      expect(app.hasRoute({ method: "HEAD", url: "/v1/sessions/:id/events" })).toBe(false);
      expect(app.hasRoute({ method: "GET", url: "/v1/capabilities" })).toBe(false);
    } finally {
      await app.close();
    }
    // Dispatch verifies Fastify's route-level permission, not only the exported matrix.
    for (const role of ["admin", "user", "viewer", "operator"] as const) {
      const roleApp = await makeApp(role);
      try {
        for (const operations of [PUBLIC_API_OPERATIONS, PUBLIC_API_AUTOMATIC_HEAD_OPERATIONS] as const) {
          for (const [path, method, permission] of operations) {
            const response = await roleApp.inject({
              method: method.toUpperCase() as never,
              url: path.replaceAll("{id}", "missing"),
              remoteAddress: ROLE_IP,
            });
            expect(response.statusCode === 403).toBe(!ROUTE_PERMISSIONS[permission].includes(role));
          }
        }
      } finally {
        await roleApp.close();
      }
    }
  });

  it("rejects events HEAD before quota/runtime/adapter/DB work, including a missing session", async () => {
    const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/public-api-events-head" });
    let adapterCreations = 0;
    let socketCreations = 0;
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/public-api-events-head",
      defaultModel: null,
      modelCatalog: { getAvailable: async () => [], isAvailable: async () => false },
      ipAccess: makeTestIpAccess(),
      createAdapter: async () => { adapterCreations++; return new MockAgentAdapter(); },
      sseSocketFactory: () => {
        socketCreations++;
        throw new Error("HEAD must not create an SSE socket");
      },
    });
    try {
      const created = await app.inject({
        method: "POST", url: "/v1/sessions", remoteAddress: "10.0.0.1",
        headers: { "content-type": "application/json" }, payload: "{}",
      });
      const id = created.json().id as string;
      const before = await sessions.get(id);

      for (const target of [id, "no-such-session"]) {
        const response = await app.inject({ method: "HEAD", url: `/v1/sessions/${target}/events`, remoteAddress: "10.0.0.1" });
        expect(response.statusCode).toBe(404);
      }
      expect(adapterCreations).toBe(0);
      expect(socketCreations).toBe(0);
      // Existing sessions retain their null conversation ref; a missing session is not materialized.
      expect(await sessions.get(id)).toEqual(before);
      expect(await sessions.get("no-such-session")).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("declares coercion + silent-strip as the request validation semantics and still honors them", async () => {
    // The document must say what the implementation really does. Fastify's AJV baseline coerces
    // declared scalar types and strips undeclared fields, so a request with a wrong scalar type or
    // an unknown field succeeds. These assertions pin the declared semantics without changing it.
    expect((document as unknown as { "x-pi-request-validation": unknown })["x-pi-request-validation"])
      .toEqual({ coerceTypes: true, removeAdditional: "silent-strip" });
    const bodyOperations = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, operation]) => operation.requestBody !== undefined)
        .map(([method, operation]) => [`${method.toUpperCase()} ${path}`, operation] as const),
    );
    // Abort is the one documented exception: a hand-written strict parser, not AJV.
    const ajvBodyOperations = bodyOperations.filter(([label]) => label !== "POST /v1/sessions/{id}/abort");
    expect(ajvBodyOperations.map(([label]) => label).sort()).toEqual([
      "PATCH /v1/sessions/{id}",
      "PATCH /v1/sessions/{id}/config",
      "POST /v1/projects",
      "POST /v1/sessions",
      "POST /v1/sessions/{id}/follow-ups",
      "POST /v1/sessions/{id}/messages",
      "POST /v1/sessions/{id}/steer",
    ]);
    for (const [label, operation] of ajvBodyOperations) {
      expect(operation["x-pi-request-validation"], label)
        .toEqual({ coerceTypes: true, removeAdditional: "silent-strip" });
      expect(typeof operation.description, label).toBe("string");
      expect(operation.description as string, label).toContain("coerceTypes");
      expect(operation.description as string, label).toContain("silently stripped");
    }
    // Abort must not claim coercion/silent-strip; its description states the strict behavior.
    const abort = document.paths["/v1/sessions/{id}/abort"]!.post!;
    expect(abort["x-pi-request-validation"]).toBeUndefined();
    expect(abort.description as string).toContain("hand-written strict validator");

    const app = await makeApp();
    try {
      const post = (url: string, payload: unknown) => app.inject({
        method: "POST",
        url,
        remoteAddress: "10.0.0.1",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(payload),
      });
      // Numeric + unknown field: both are accepted, the number is coerced and the unknown stripped.
      const project = await post("/v1/projects", { name: 123, cwd: "/tmp/p", unknownField: "x" });
      expect(project.statusCode).toBe(201);
      expect(project.json()).toMatchObject({ name: "123", cwd: "/tmp/p" });
      expect(project.json()).not.toHaveProperty("unknownField");

      const created = await post("/v1/sessions", { title: 99, unknownField: true });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ title: "99" });
      const sessionId = created.json().id as string;

      const renamed = await app.inject({
        method: "PATCH",
        url: `/v1/sessions/${sessionId}`,
        remoteAddress: "10.0.0.1",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ title: 42, unknownField: true }),
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ title: "42" });

      // A missing required field is still a declared 400; that is the only rejection here.
      const missing = await post("/v1/projects", { name: 123 });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ code: "FST_ERR_VALIDATION" });

      // Abort is the documented exception: its hand-written parser rejects unknown fields and
      // non-string values instead of coercing/stripping them.
      const abortUnknown = await post(`/v1/sessions/${sessionId}/abort`, { requestId: "r", unknownField: 1 });
      expect(abortUnknown.statusCode).toBe(400);
      const abortNonString = await post(`/v1/sessions/${sessionId}/abort`, { requestId: 7 });
      expect(abortNonString.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("keeps checked JSON byte-for-byte generated and key inject responses within their schemas/statuses", async () => {
    expect(await readFile("openapi/v1.json", "utf8")).toBe(`${JSON.stringify(openapiV1, null, 2)}\n`);
    const app = await makeApp();
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(schemaMatches(health.json(), document.components.schemas.Health!)).toBe(true);

      const access = await app.inject({ method: "GET", url: "/v1/access", remoteAddress: "10.0.0.1" });
      expect(access.statusCode).toBe(200);
      expect(schemaMatches(access.json(), document.components.schemas.Access!)).toBe(true);

      const project = await app.inject({ method: "POST", url: "/v1/projects", remoteAddress: "10.0.0.1", headers: { "content-type": "application/json" }, payload: JSON.stringify({ name: "p", cwd: "/tmp/p" }) });
      expect(project.statusCode).toBe(201);
      expect(schemaMatches(project.json(), document.components.schemas.Project!)).toBe(true);

      const session = await app.inject({ method: "POST", url: "/v1/sessions", remoteAddress: "10.0.0.1", headers: { "content-type": "application/json" }, payload: "{}" });
      expect(session.statusCode).toBe(201);
      expect(schemaMatches(session.json(), document.components.schemas.Session!)).toBe(true);

      const invalid = await app.inject({ method: "POST", url: "/v1/projects", remoteAddress: "10.0.0.1", headers: { "content-type": "application/json" }, payload: "{}" });
      expect(invalid.statusCode).toBe(400);
      expect(schemaMatches(invalid.json(), document.components.schemas.ApiError!)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("validates real failback conflicts and exports against their response schemas, rejecting unknown timeline types", async () => {
    const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/public-api-failback-contract" });
    let adapter: FailbackExportAdapter | undefined;
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/public-api-failback-contract",
      defaultModel: null,
      modelCatalog: { getAvailable: async () => [], isAvailable: async () => false },
      ipAccess: makeTestIpAccess(),
      createAdapter: async () => (adapter = new FailbackExportAdapter()),
    });
    try {
      const created = await app.inject({ method: "POST", url: "/v1/sessions", remoteAddress: "10.0.0.1", headers: { "content-type": "application/json" }, payload: "{}" });
      const sessionId = created.json().id as string;
      const submitted = await app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/messages`, remoteAddress: "10.0.0.1", headers: { "content-type": "application/json" }, payload: JSON.stringify({ requestId: "failback-request", prompt: "trigger" }) });
      expect(submitted.statusCode).toBe(202);
      await adapter!.waitForStart();

      const conflict = await app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/abort`, remoteAddress: "10.0.0.1", headers: { "content-type": "application/json" }, payload: JSON.stringify({ requestId: "failback-request" }) });
      expect(conflict.statusCode).toBe(409);
      const abort409 = document.paths["/v1/sessions/{id}/abort"]!.post!.responses as Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }>;
      expect(schemaMatches(conflict.json(), abort409["409"]!.content["application/json"].schema)).toBe(true);

      const exported = await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}/export`, remoteAddress: "10.0.0.1" });
      expect(exported.statusCode).toBe(200);
      expect(schemaMatches(exported.json(), document.components.schemas.Export!)).toBe(true);
      const timeline = document.components.schemas.TimelineItem!;
      expect(schemaMatches(exported.json().timeline[0], timeline)).toBe(true);
      expect(schemaMatches({ id: "unknown", type: "system_event", event: "unexpected", from: "a", to: "b", reason: "x", order: 0 }, timeline)).toBe(false);
      expect(schemaMatches({ id: "unknown", type: "unknown", order: 0 }, timeline)).toBe(false);
      adapter!.finish();
    } finally {
      adapter?.finish();
      await app.close();
    }
  });

  it("documents session events 500 ApiError and returns it when the session lookup fails", async () => {
    // Contract: the pre-stream failure path (session lookup throws) is a documented 500, not an
    // undeclared framework fallback; the JSON artifact must carry the same response set.
    const events = (openapiV1 as unknown as {
      paths: { "/v1/sessions/{id}/events": { get: { responses: Record<string, unknown> } } };
    }).paths["/v1/sessions/{id}/events"].get;
    expect(Object.keys(events.responses)).toEqual(["200", "204", "401", "403", "404", "429", "500", "503"]);
    expect(events.responses["500"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
    });

    const { sessions: inner, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/public-api-events-500" });
    await seedSession(inner, "stable");
    let throwOnce = true;
    const sessions: SessionStorePort = {
      create: (record) => inner.create(record),
      get: async (id) => {
        if (throwOnce && id === "boom") {
          throwOnce = false;
          throw new Error("store-boom: SQLITE_ERROR no such table secret_table at /Users/mz/secret/data.db");
        }
        return inner.get(id);
      },
      listByOwner: (ownerKey) => inner.listByOwner(ownerKey),
      listByProject: (ownerKey, projectId) => inner.listByProject(ownerKey, projectId),
      backfillSystemPrompt: (sessionId) => inner.backfillSystemPrompt(sessionId),
      update: (id, patch) => inner.update(id, patch),
      reserveConversation: (id, reservation) => inner.reserveConversation(id, reservation),
      commitConversationReservation: (id, expectedRef, actualRef) => inner.commitConversationReservation(id, expectedRef, actualRef),
      releaseConversationReservation: (id, expectedRef) => inner.releaseConversationReservation(id, expectedRef),
      delete: (id) => inner.delete(id),
    };
    let adapterCreations = 0;
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/public-api-events-500",
      defaultModel: null,
      modelCatalog: { getAvailable: async () => [], isAvailable: async () => false },
      ipAccess: makeTestIpAccess(),
      maxSsePerUser: 1,
      createAdapter: async () => { adapterCreations++; return new MockAgentAdapter(); },
    });
    try {
      const failed = await app.inject({ method: "GET", url: "/v1/sessions/boom/events", remoteAddress: "10.0.0.1" });
      expect(failed.statusCode).toBe(500);
      expect(failed.headers["content-type"]).toContain("application/json");
      expect(failed.json()).toMatchObject({ statusCode: 500, error: "Internal Server Error" });
      expect(schemaMatches(failed.json(), document.components.schemas.ApiError!)).toBe(true);
      // The 500 body itself must be sanitized (not just the follow-up 404): fixed message only,
      // no injected marker, no storage detail, no absolute path.
      expect(failed.json().message).toBe("会话事件启动失败");
      const failedBody = JSON.stringify(failed.json());
      expect(failedBody).not.toContain("store-boom");
      expect(failedBody).not.toContain("secret_table");
      expect(failedBody).not.toContain("/Users/mz/secret");
      expect(adapterCreations).toBe(0);
      // The failed request released its pre-stream slot: a second request still reaches the
      // session lookup (404) instead of being rejected by the per-user limit (429).
      const afterBoom = await app.inject({ method: "GET", url: "/v1/sessions/no-such-session/events", remoteAddress: "10.0.0.1" });
      expect(afterBoom.statusCode).toBe(404);
      expect(JSON.stringify(afterBoom.json())).not.toContain("store-boom");
      expect(adapterCreations).toBe(0);
    } finally {
      await app.close();
    }
  });
});
