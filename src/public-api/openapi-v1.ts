// Checked-in OpenAPI source for the fixed host API only. Plugin capability routes are
// intentionally excluded: they are dynamically supplied by trusted in-process plugins.

export const OPENAPI_V1_VERSION = "1.0.0";

// Explicit application operations registered by the host. Fastify exposes the GET
// operations listed in PUBLIC_API_AUTOMATIC_HEAD_OPERATIONS below as HEAD routes too.
export const PUBLIC_API_OPERATIONS = [
  ["/health", "get", "probe:health"],
  ["/readyz", "get", "probe:readyz"],
  ["/metrics", "get", "probe:metrics"],
  ["/v1/access", "get", "access:read"],
  ["/v1/models", "get", "models:list"],
  ["/v1/projects", "get", "projects:list"],
  ["/v1/projects", "post", "projects:create"],
  ["/v1/projects/{id}", "delete", "projects:delete"],
  ["/v1/sessions", "get", "sessions:list"],
  ["/v1/sessions", "post", "sessions:create"],
  ["/v1/sessions/{id}", "delete", "sessions:delete"],
  ["/v1/sessions/{id}", "patch", "sessions:update"],
  ["/v1/sessions/{id}/config", "patch", "sessions:update-config"],
  ["/v1/sessions/{id}/messages", "post", "sessions:send-message"],
  ["/v1/sessions/{id}/export", "get", "sessions:export"],
  ["/v1/sessions/{id}/steer", "post", "sessions:control"],
  ["/v1/sessions/{id}/follow-ups", "post", "sessions:control"],
  ["/v1/sessions/{id}/abort", "post", "sessions:control"],
  ["/v1/sessions/{id}/events", "get", "sessions:events"],
] as const;

// These are not independently registered business operations. They are Fastify's
// default `exposeHeadRoute` routes, verified against `app.printRoutes()` and inject.
// /readyz, /metrics, and SSE events opt out with `exposeHeadRoute: false` and are intentionally absent.
export const PUBLIC_API_AUTOMATIC_HEAD_OPERATIONS = [
  ["/health", "head", "probe:health"],
  ["/v1/access", "head", "access:read"],
  ["/v1/models", "head", "models:list"],
  ["/v1/projects", "head", "projects:list"],
  ["/v1/sessions", "head", "sessions:list"],
  ["/v1/sessions/{id}/export", "head", "sessions:export"],
] as const;

type Permission = (typeof PUBLIC_API_OPERATIONS)[number][2];

// Fastify validates request bodies/params with its AJV baseline, not with the strict
// `additionalProperties: false` reading of the schemas below. Two consequences are part of
// the observable v1 behavior and must be declared rather than implied:
//   - `coerceTypes: 'array'` coerces a scalar or single-element array into the declared type
//     (a numeric `title` is accepted and becomes `"5"`), so a 400 does not mean "wrong type";
//   - `removeAdditional: true` silently strips undeclared fields instead of rejecting them,
//     so a 400 never means "unknown field was sent".
// `removeAdditional: "silent-strip"` names that second behavior; it is not an AJV literal.
export const PUBLIC_API_REQUEST_VALIDATION = {
  coerceTypes: true,
  removeAdditional: "silent-strip",
} as const;

const REQUEST_VALIDATION_DESCRIPTION =
  "Request bodies use Fastify's AJV baseline: declared types are coerced (`coerceTypes: 'array'`,\n" +
  "so numbers, booleans, and single-element arrays are accepted where a string is declared) and\n" +
  "undeclared fields are silently stripped (`removeAdditional: true` combined with\n" +
  "`additionalProperties: false`) instead of returning 400. A 400 therefore reports a missing\n" +
  "required field or a value that cannot be coerced/constrained, never a wrong scalar type or an\n" +
  "unknown field.";

// Applied to every operation that declares a requestBody, alongside the description above.
const requestValidation = {
  "x-pi-request-validation": PUBLIC_API_REQUEST_VALIDATION,
  description: REQUEST_VALIDATION_DESCRIPTION,
} as const;

const json = (schema: object) => ({ content: { "application/json": { schema } } });
const ref = (name: string) => ({ "$ref": `#/components/schemas/${name}` });
const error = (status: number, description: string) => ({ description, ...json(ref("ApiError")) });
const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
const request = (schema: object, required = true) => ({ required, content: { "application/json": { schema } } });

// IP admission is always mandatory. Bearer is conditionally mandatory only when
// the admitted IP profile has tokenRequired=true; OpenAPI's alternatives express
// this conditional extension without claiming every caller needs a token.
const ipOnlySecurity = [{ IpAdmission: [] }];
const conditionalBearerSecurity = [{ IpAdmission: [] }, { IpAdmission: [], BearerAuth: [] }];
const roles: Record<Permission, readonly string[]> = {
  "probe:health": ["admin", "user", "viewer", "operator"],
  "probe:readyz": ["admin", "user", "viewer", "operator"],
  "probe:metrics": ["admin", "operator"],
  "access:read": ["admin", "user", "viewer"],
  "models:list": ["admin", "user", "viewer"],
  "projects:list": ["admin", "user", "viewer"],
  "projects:create": ["admin", "user"],
  "projects:delete": ["admin", "user"],
  "sessions:list": ["admin", "user", "viewer"],
  "sessions:create": ["admin", "user"],
  "sessions:delete": ["admin", "user"],
  "sessions:update": ["admin", "user"],
  "sessions:update-config": ["admin", "user"],
  "sessions:send-message": ["admin", "user"],
  "sessions:control": ["admin", "user"],
  "sessions:export": ["admin", "user", "viewer"],
  "sessions:events": ["admin", "user", "viewer"],
};

function operation(
  operationId: string,
  permission: Permission,
  responses: Record<string, object>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const isProbe = permission === "probe:health" || permission === "probe:readyz";
  return {
    operationId,
    security: isProbe ? ipOnlySecurity : conditionalBearerSecurity,
    "x-pi-rbac": { permission, roles: roles[permission] },
    responses: { ...(isProbe ? {} : { "401": error(401, "Bearer token required for this admitted IP profile.") }), "403": error(403, "IP admission or RBAC denied."), ...responses },
    ...extra,
  };
}

const noContent = { description: "Completed without a response body." };
// Fastify's automatic HEAD implementation executes the corresponding GET handler,
// suppresses its response body, and retains the JSON response headers.
const headJsonHeaders = {
  "Content-Type": { required: true, schema: { type: "string", const: "application/json; charset=utf-8" } },
  "Content-Length": { required: true, schema: { type: "string", pattern: "^[0-9]+$" } },
};
const headJson = (description: string) => ({ description, headers: headJsonHeaders });
const headUnauthorized = {
  description: "Bearer token required for this admitted IP profile.",
  headers: { ...headJsonHeaders, "WWW-Authenticate": { required: true, schema: { type: "string", const: "Bearer" } } },
};
const headForbidden = { description: "IP admission or RBAC denied.", headers: headJsonHeaders };
const sseHeaders = {
  "Content-Type": { required: true, schema: { type: "string", const: "text/event-stream" } },
  "Cache-Control": { schema: { type: "string", const: "no-cache" } },
  Connection: { schema: { type: "string", const: "keep-alive" } },
  "X-Server-Epoch": { schema: { type: "string" }, description: "Present when the server epoch is configured." },
};
function automaticHeadOperation(
  operationId: string,
  permission: Permission,
  responses: Record<string, object>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const isProbe = permission === "probe:health" || permission === "probe:readyz";
  return {
    operationId,
    security: isProbe ? ipOnlySecurity : conditionalBearerSecurity,
    "x-pi-rbac": { permission, roles: roles[permission] },
    responses: { ...(isProbe ? {} : { "401": headUnauthorized }), "403": headForbidden, ...responses },
    ...extra,
  };
}
const sessionParameters = [id];

export const openapiV1 = {
  openapi: "3.1.1",
  info: {
    title: "pi-agent-server host API",
    version: OPENAPI_V1_VERSION,
    description:
      "Fixed host API contract v1. Dynamic plugin routes are not part of this document.\n" +
      "Request validation semantics: " +
      REQUEST_VALIDATION_DESCRIPTION,
  },
  "x-pi-request-validation": PUBLIC_API_REQUEST_VALIDATION,
  security: conditionalBearerSecurity,
  paths: {
    "/health": {
      get: operation("health", "probe:health", { "200": { description: "Live.", ...json(ref("Health")) } }),
      head: automaticHeadOperation("healthHead", "probe:health", { "200": headJson("Live; the GET response body is suppressed.") }),
    },
    "/readyz": {
      get: operation("readyz", "probe:readyz", {
        "200": { description: "Ready.", ...json(ref("Ready")) },
        "503": { description: "Not ready.", ...json(ref("Ready")) },
      }),
    },
    "/metrics": {
      get: operation("metrics", "probe:metrics", {
        "200": { description: "Prometheus text exposition.", content: { "text/plain": { schema: { type: "string" } } } },
        "503": { description: "Metrics unavailable.", content: { "text/plain": { schema: { type: "string" } } } },
      }),
    },
    "/v1/access": {
      get: operation("getAccess", "access:read", { "200": { description: "Access projection.", ...json(ref("Access")) } }),
      head: automaticHeadOperation("getAccessHead", "access:read", { "200": headJson("Access projection; the GET response body is suppressed.") }),
    },
    "/v1/models": {
      get: operation("listModels", "models:list", { "200": { description: "Available models.", ...json(ref("ModelList")) } }),
      head: automaticHeadOperation("listModelsHead", "models:list", { "200": headJson("Available models; the GET response body is suppressed.") }),
    },
    "/v1/projects": {
      get: operation("listProjects", "projects:list", { "200": { description: "Projects.", ...json({ type: "array", items: ref("Project") }) } }),
      head: automaticHeadOperation("listProjectsHead", "projects:list", { "200": headJson("Projects; the GET response body is suppressed.") }),
      post: operation("createProject", "projects:create", {
        "201": { description: "Created.", ...json(ref("Project")) },
        "400": error(400, "Invalid project input."),
      }, { requestBody: request(ref("CreateProject")), ...requestValidation }),
    },
    "/v1/projects/{id}": {
      delete: operation("deleteProject", "projects:delete", {
        "204": noContent,
        "400": error(400, "The default project cannot be deleted."),
        "404": error(404, "Project not found."),
      }, { parameters: [id] }),
    },
    "/v1/sessions": {
      get: operation("listSessions", "sessions:list", { "200": { description: "Sessions.", ...json({ type: "array", items: ref("Session") }) } }, {
        parameters: [{ name: "projectId", in: "query", schema: { type: "string" } }],
      }),
      head: automaticHeadOperation("listSessionsHead", "sessions:list", { "200": headJson("Sessions; the GET response body is suppressed.") }, {
        parameters: [{ name: "projectId", in: "query", schema: { type: "string" } }],
      }),
      post: operation("createSession", "sessions:create", {
        "201": { description: "Created.", ...json(ref("Session")) },
        "400": error(400, "Invalid model or thinking level."),
        "404": error(404, "Project not found."),
        "503": error(503, "Model availability check failed."),
      }, { requestBody: request(ref("CreateSession")), ...requestValidation }),
    },
    "/v1/sessions/{id}": {
      delete: operation("deleteSession", "sessions:delete", { "204": noContent, "404": error(404, "Session not found.") }, { parameters: sessionParameters }),
      patch: operation("renameSession", "sessions:update", {
        "200": { description: "Updated.", ...json(ref("Session")) }, "404": error(404, "Session not found."),
      }, { parameters: sessionParameters, requestBody: request(ref("RenameSession")), ...requestValidation }),
    },
    "/v1/sessions/{id}/config": {
      patch: operation("configureSession", "sessions:update-config", {
        "200": { description: "Updated.", ...json(ref("Session")) }, "400": error(400, "Invalid configuration."), "404": error(404, "Session not found."), "503": error(503, "Model availability check failed."),
      }, { parameters: sessionParameters, requestBody: request(ref("SessionConfig")), ...requestValidation }),
    },
    "/v1/sessions/{id}/messages": {
      post: operation("submitMessage", "sessions:send-message", {
        "200": { description: "Idempotent terminal result.", ...json({}) },
        "202": { description: "Accepted or queued.", ...json(ref("SubmitResult")) },
        "400": error(400, "Invalid message input."), "404": error(404, "Session not found."), "409": error(409, "Session conflict or requestId payload mismatch."), "429": error(429, "Queue limit reached."),
      }, { parameters: sessionParameters, requestBody: request(ref("MessageInput")), ...requestValidation }),
    },
    "/v1/sessions/{id}/export": {
      get: operation("exportSession", "sessions:export", {
        "200": { description: "Read-only snapshot.", ...json(ref("Export")) },
        "404": error(404, "Session not found."),
        "500": error(500, "Session export could not be read."),
      }, { parameters: sessionParameters }),
      head: automaticHeadOperation("exportSessionHead", "sessions:export", {
        "200": headJson("Read-only snapshot; the GET response body is suppressed."),
        "404": headJson("Session not found; the GET response body is suppressed."),
        "500": headJson("Session export could not be read; the GET response body is suppressed."),
      }, { parameters: sessionParameters }),
    },
    "/v1/sessions/{id}/steer": {
      post: operation("steerSession", "sessions:control", { "204": noContent, "404": error(404, "Session not found."), "409": error(409, "No active task.") }, { parameters: sessionParameters, requestBody: request(ref("TextInput")), ...requestValidation }),
    },
    "/v1/sessions/{id}/follow-ups": {
      post: operation("followUpSession", "sessions:control", { "204": noContent, "404": error(404, "Session not found."), "409": error(409, "No active task.") }, { parameters: sessionParameters, requestBody: request(ref("TextInput")), ...requestValidation }),
    },
    "/v1/sessions/{id}/abort": {
      post: operation("abortSession", "sessions:control", { "204": noContent, "400": error(400, "Invalid abort input."), "404": error(404, "Session not found."), "409": error(409, "No active task or requestId mismatch.") }, {
        parameters: sessionParameters,
        requestBody: request(ref("AbortInput"), false),
        // Deliberately no `x-pi-request-validation`: this body is parsed by a hand-written strict
        // validator, not by AJV, so the coercion/silent-strip statement would be false here.
        description:
          "The abort body is parsed by a hand-written strict validator, not by AJV: an absent body is\n" +
          "accepted, but a supplied body must contain exactly the `requestId` field with a string value.\n" +
          "Unknown fields and non-string values are rejected with 400 (no type coercion, no silent\n" +
          "stripping).",
      }),
    },
    "/v1/sessions/{id}/events": {
      get: operation("sessionEvents", "sessions:events", {
        "200": {
          description: "SSE stream. Each `data:` line is a SseEvent JSON value.",
          headers: sseHeaders,
          content: { "text/event-stream": { schema: ref("SseEvent") } },
        },
        "204": { description: "Viewer may receive this when the owned session has no live runtime; no stream is created." },
        "404": error(404, "Session not found."), "429": error(429, "SSE connection limit reached."),
        // Raised before any stream is created when resolving the session fails (store read error);
        // the pre-stream quota slot is released exactly once on this path.
        "500": error(500, "Session events could not be started."),
        "503": error(503, "Server is closing."),
      }, {
        parameters: [...sessionParameters, { name: "Last-Event-ID", in: "header", schema: { type: "string" } }, { name: "X-Client-Epoch", in: "header", schema: { type: "string" } }],
      }),
    },
  },
  components: {
    securitySchemes: {
      IpAdmission: { type: "http", scheme: "ip-admission", description: "Mandatory direct-peer CIDR/IP admission. This is evaluated by the host, not supplied by a client.", "x-pi-ip-admission": true },
      BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "Required only when the admitted IP profile has tokenRequired=true." },
    },
    schemas: {
      ApiError: { type: "object", required: ["statusCode", "error", "message"], properties: { statusCode: { type: "integer" }, code: { type: "string", description: "Fastify validation error code when applicable." }, error: { type: "string" }, message: { type: "string" } }, additionalProperties: false },
      Health: { type: "object", required: ["status"], properties: { status: { type: "string", const: "ok" } }, additionalProperties: false },
      Ready: { type: "object", required: ["ready", "migrationGate", "schema"], properties: { ready: { type: "boolean" }, migrationGate: { type: "string", enum: ["off", "verify"] }, schema: { type: "string", enum: ["rc-bootstrap", "migration-head", "not-verified", "unknown"] } }, additionalProperties: false },
      Access: { type: "object", required: ["canRead", "canWrite"], properties: { canRead: { type: "boolean" }, canWrite: { type: "boolean" } }, additionalProperties: false },
      Model: { type: "object", required: ["provider", "id", "name"], properties: { provider: { type: "string" }, id: { type: "string" }, name: { type: "string" } }, additionalProperties: false },
      ModelList: { type: "object", required: ["models", "thinkingLevels", "defaultModel", "defaultThinkingLevel"], properties: { models: { type: "array", items: ref("Model") }, thinkingLevels: { type: "array", items: { type: "string" } }, defaultModel: { anyOf: [ref("Model"), { type: "null" }] }, defaultThinkingLevel: { type: "string" } }, additionalProperties: false },
      Project: { type: "object", required: ["id", "name", "cwd", "isDefault"], properties: { id: { type: "string" }, name: { type: "string" }, cwd: { type: "string" }, isDefault: { type: "boolean" } }, additionalProperties: false },
      Session: { type: "object", required: ["id", "ownerKey", "projectId", "title", "createdAt", "updatedAt", "modelProvider", "modelId", "thinkingLevel", "systemPrompt", "capabilityVersions"], properties: { id: { type: "string" }, ownerKey: { type: "string" }, projectId: { type: "string" }, title: { type: "string" }, createdAt: { type: "number" }, updatedAt: { type: "number" }, modelProvider: { type: ["string", "null"] }, modelId: { type: ["string", "null"] }, thinkingLevel: { type: ["string", "null"] }, systemPrompt: { type: ["string", "null"] }, capabilityVersions: { type: ["string", "null"] } }, additionalProperties: false },
      CreateProject: { type: "object", required: ["name", "cwd"], properties: { name: { type: "string" }, cwd: { type: "string" } }, additionalProperties: false },
      CreateSession: { type: "object", properties: { title: { type: "string" }, projectId: { type: "string" }, modelProvider: { type: "string", minLength: 1 }, modelId: { type: "string", minLength: 1 }, thinkingLevel: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] } }, dependentRequired: { modelProvider: ["modelId"], modelId: ["modelProvider"] }, additionalProperties: false },
      RenameSession: { type: "object", required: ["title"], properties: { title: { type: "string" } }, additionalProperties: false },
      SessionConfig: { type: "object", properties: { modelProvider: { type: "string", minLength: 1 }, modelId: { type: "string", minLength: 1 }, thinkingLevel: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] } }, additionalProperties: false },
      ImageInput: { type: "object", required: ["mediaType", "base64"], properties: { mediaType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] }, base64: { type: "string", maxLength: 5592408 } }, additionalProperties: false },
      MessageInput: { type: "object", required: ["requestId", "prompt"], properties: { requestId: { type: "string", maxLength: 128 }, prompt: { type: "string", maxLength: 32768 }, parentId: { type: "string" }, images: { type: "array", maxItems: 4, items: ref("ImageInput") } }, additionalProperties: false },
      SubmitResult: { oneOf: [{ type: "object", required: ["status"], properties: { status: { const: "accepted" } }, additionalProperties: false }, { type: "object", required: ["status"], properties: { status: { const: "queued" }, position: { type: "integer" } }, additionalProperties: false }] },
      Export: { type: "object", required: ["messages", "lastEventId"], properties: { messages: {}, lastEventId: { type: "integer", minimum: 0 } }, additionalProperties: false },
      TextInput: { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
      AbortInput: { type: "object", required: ["requestId"], properties: { requestId: { type: "string", maxLength: 128 } }, additionalProperties: false },
      SseEvent: { oneOf: [
        { type: "object", required: ["type", "text"], properties: { type: { const: "text_delta" }, text: { type: "string" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "text"], properties: { type: { const: "thinking_delta" }, text: { type: "string" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "toolCallId", "toolName", "args"], properties: { type: { const: "tool_start" }, toolCallId: { type: "string" }, toolName: { type: "string" }, args: {}, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "toolCallId", "toolName", "partialResult"], properties: { type: { const: "tool_update" }, toolCallId: { type: "string" }, toolName: { type: "string" }, partialResult: {}, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "toolCallId", "toolName", "result", "isError"], properties: { type: { const: "tool_end" }, toolCallId: { type: "string" }, toolName: { type: "string" }, result: {}, isError: { type: "boolean" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "phase"], properties: { type: { const: "status" }, phase: { type: "string", enum: ["agent_start", "turn_start"] }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type"], properties: { type: { const: "queued" }, position: { type: "integer" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "promptTokens", "completionTokens", "totalTokens", "durationMs", "ttftMs"], properties: { type: { const: "usage" }, promptTokens: { type: "number" }, completionTokens: { type: "number" }, totalTokens: { type: "number" }, durationMs: { type: "number" }, ttftMs: { type: "number" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "message"], properties: { type: { const: "error" }, message: { type: "string" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type"], properties: { type: { const: "completed" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type"], properties: { type: { const: "aborted" }, requestId: { type: "string" } }, additionalProperties: false },
      ] },
    },
  },
} as const;
