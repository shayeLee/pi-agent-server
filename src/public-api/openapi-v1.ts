// Checked-in OpenAPI source for the fixed host API only. Plugin capability routes are
// intentionally excluded: they are dynamically supplied by trusted in-process plugins.

export const OPENAPI_V1_VERSION = "1.0.0";

const measurementNumber = { type: ["number", "null"], minimum: 0 } as const;
const usageTokenProperties = {
  input: measurementNumber, output: measurementNumber, cacheRead: measurementNumber,
  cacheWrite: measurementNumber, totalTokens: measurementNumber,
  costUsdEstimate: { ...measurementNumber, description: "SDK model-price estimate in USD, not an invoice; zero does not establish free service." },
} as const;
const snapshotProperties = {
  execution: { oneOf: [{ $ref: "#/components/schemas/ExecutionSnapshot" }, { type: "null" }] },
  lastResponse: { oneOf: [{ $ref: "#/components/schemas/LastResponseUsage" }, { type: "null" }] },
  sessionTotals: { oneOf: [{ $ref: "#/components/schemas/SessionUsageTotals" }, { type: "null" }] },
  context: { oneOf: [{ $ref: "#/components/schemas/ContextUsage" }, { type: "null" }] },
  currentPrompt: { oneOf: [{ $ref: "#/components/schemas/PromptUsage" }, { type: "null" }] },
  subagentTotals: { oneOf: [{ $ref: "#/components/schemas/SubagentUsage" }, { type: "null" }] },
} as const;

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
  ["/v1/files", "post", "files:upload"],
  ["/v1/sessions", "get", "sessions:list"],
  ["/v1/sessions", "post", "sessions:create"],
  ["/v1/sessions/{id}", "delete", "sessions:delete"],
  ["/v1/sessions/{id}", "patch", "sessions:update"],
  ["/v1/sessions/{id}/config", "patch", "sessions:update-config"],
  ["/v1/sessions/{id}/messages", "post", "sessions:send-message"],
  ["/v1/sessions/{id}/export", "get", "sessions:export"],
  ["/v1/sessions/{id}/subagents", "get", "sessions:export"],
  ["/v1/sessions/{id}/steps", "get", "sessions:export"],
  ["/v1/sessions/{id}/system-prompt", "get", "sessions:export"],
  ["/v1/sessions/{id}/file-preview", "get", "sessions:file-preview"],
  ["/v1/sessions/{id}/files", "get", "sessions:file-preview"],
  ["/v1/sessions/{id}/commands", "get", "sessions:export"],
  ["/v1/sessions/{id}/commands", "post", "sessions:control"],
  ["/v1/sessions/{id}/control-queue", "get", "sessions:export"],
  ["/v1/sessions/{id}/control-queue/{controlId}", "delete", "sessions:control"],
  ["/v1/sessions/{id}/control-queue/{controlId}/promote", "post", "sessions:control"],
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
  ["/v1/sessions/{id}/subagents", "head", "sessions:export"],
  ["/v1/sessions/{id}/steps", "head", "sessions:export"],
  ["/v1/sessions/{id}/system-prompt", "head", "sessions:export"],
  ["/v1/sessions/{id}/control-queue", "head", "sessions:export"],
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
  "files:upload": ["admin", "user"],
  "sessions:list": ["admin", "user", "viewer"],
  "sessions:create": ["admin", "user"],
  "sessions:delete": ["admin", "user"],
  "sessions:update": ["admin", "user"],
  "sessions:update-config": ["admin", "user"],
  "sessions:send-message": ["admin", "user"],
  "sessions:control": ["admin", "user"],
  "sessions:export": ["admin", "user", "viewer"],
  "sessions:file-preview": ["admin", "user", "viewer"],
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
const nativeScanHeaders = { "X-Pi-Native-Scan-Warnings": {
  description: "Optional comma-separated fixed warning codes: native-source-unavailable, native-source-skipped, native-scan-truncated; no paths or content.",
  schema: { type: "string", maxLength: 100 },
} };

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
      get: operation("getAccess", "access:read", {
        "200": {
          description: "Access projection.",
          ...json(ref("Access")),
          // 响应依赖调用方身份（当前仅来自来源 IP）：绝不能被共享缓存跨来源复用。
          headers: { "Cache-Control": { required: true, schema: { type: "string", const: "private, no-store" } } },
        },
      }),
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
        "400": error(400, "Invalid project input or unavailable cwd."),
        "409": error(409, "Canonical project cwd already registered, including the default project."),
      }, { requestBody: request(ref("CreateProject")), ...requestValidation }),
    },
    "/v1/projects/{id}": {
      delete: operation("deleteProject", "projects:delete", {
        "204": noContent,
        "400": error(400, "The default project cannot be deleted."),
        "404": error(404, "Project not found."),
      }, { parameters: [id] }),
    },
    "/v1/files": {
      post: operation("uploadFile", "files:upload", {
        "201": { description: "Validated original stored; a repeated upload key returns the same file.", ...json(ref("UploadedFile")) },
        "400": error(400, "Invalid name, type, bytes, or upload metadata."),
        "404": error(404, "Project not found or not owned."),
        "409": error(409, "Upload key reused for different bytes."),
        "413": error(413, "File exceeds 20 MiB."),
        "503": error(503, "Storage is not configured or available."),
        "507": error(507, "Configured owner or global upload storage budget reached."),
      }, { parameters: [
        { name: "x-upload-project-id", in: "header", required: true, schema: { type: "string" } },
        { name: "x-upload-key", in: "header", required: true, schema: { type: "string" } },
        { name: "x-upload-name", in: "header", required: true, schema: { type: "string" }, description: "URI-encoded display basename." },
        { name: "x-upload-kind", in: "header", required: true, schema: { enum: ["text", "code", "csv", "json", "pdf", "docx", "xlsx", "pptx"] } },
        { name: "x-upload-type", in: "header", schema: { type: "string" }, description: "Claimed MIME; actual bytes are checked separately." },
      ], requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } } }),
    },
    "/v1/sessions": {
      get: operation("listSessions", "sessions:list", { "200": { description: "Sessions.", headers: nativeScanHeaders, ...json({ type: "array", items: ref("Session") }) } }, {
        parameters: [{ name: "projectId", in: "query", schema: { type: "string" } }],
      }),
      head: automaticHeadOperation("listSessionsHead", "sessions:list", { "200": { ...headJson("Sessions; the GET response body is suppressed."), headers: { ...headJsonHeaders, ...nativeScanHeaders } } }, {
        parameters: [{ name: "projectId", in: "query", schema: { type: "string" } }],
      }),
      post: operation("createSession", "sessions:create", {
        "201": { description: "Created.", ...json(ref("Session")) },
        "200": { description: "Idempotent creation-key replay.", ...json(ref("Session")) },
        "409": error(409, "Creation key reused for different session configuration."),
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
        "400": error(400, "Invalid message or file count/size."), "404": error(404, "Session or file not found."), "409": error(409, "Session/file conflict, payload mismatch, or REQUEST_STATUS_UNKNOWN reservation (do not resubmit automatically)."), "429": error(429, "Queue limit reached."), "503": error(503, "Uploaded bytes could not be verified."),
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
    "/v1/sessions/{id}/subagents": {
      get: operation("getSubagents", "sessions:export", {
        "200": { description: "Session-owned child runs. Optional runId includes the full read-only conversation. Does not create a runtime; unavailable live state is unknown.", ...json(ref("SubagentSnapshot")) },
        "404": error(404, "Session not found or access revoked."),
      }, { parameters: [...sessionParameters, { name: "runId", in: "query", required: false, schema: { type: "string" }, description: "Stable child execution ID from runs[].id, not the ephemeral agent-team runId." }] }),
      head: automaticHeadOperation("getSubagentsHead", "sessions:export", {
        "200": headJson("Child runs; body suppressed."), "404": headJson("Session not found."),
      }, { parameters: sessionParameters }),
    },
    "/v1/sessions/{id}/steps": {
      get: operation("getSessionSteps", "sessions:export", {
        "200": { description: "Complete authoritative steps snapshot, including active unsaved blocks. Recorded history follows selected branch order; observed tool results follow actual completion order. No runtime is created.", ...json(ref("SessionStepsSnapshot")) },
        "404": error(404, "Session not found or source access revoked."),
      }, { parameters: sessionParameters }),
      head: automaticHeadOperation("getSessionStepsHead", "sessions:export", {
        "200": headJson("Steps snapshot; body suppressed."), "404": headJson("Session not found."),
      }, { parameters: sessionParameters }),
    },
    "/v1/sessions/{id}/system-prompt": {
      get: operation("getSystemPrompt", "sessions:export", {
        "200": { description: "Full prompt with explicit provenance. live_effective may not yet have been sent to a model. No runtime is created; unproven history falls back to creation_snapshot or unavailable.", ...json(ref("SessionSystemPrompt")) },
        "404": error(404, "Session not found or source access revoked."),
      }, { parameters: sessionParameters }),
      head: automaticHeadOperation("getSystemPromptHead", "sessions:export", {
        "200": headJson("Prompt snapshot; body suppressed."), "404": headJson("Session not found."),
      }, { parameters: sessionParameters }),
    },
    "/v1/sessions/{id}/file-preview": {
      get: operation("previewSessionFile", "sessions:file-preview", {
        "200": { description: "Read-only, bounded UTF-8 text preview under the session project root.", ...json(ref("FilePreview")) },
        "400": error(400, "The path is invalid, sensitive, outside the project, not regular UTF-8 text, too large, or line is out of range."),
        "404": error(404, "Session or file not found."),
      }, { parameters: [...sessionParameters, { name: "path", in: "query", required: true, schema: { type: "string", minLength: 1 }, description: "Project-relative file path; absolute paths and traversal are rejected." }, { name: "line", in: "query", required: false, schema: { type: "integer", minimum: 1 }, description: "Optional 1-based line for a client-side scroll target." }] }),
    },
    "/v1/sessions/{id}/files": {
      get: operation("searchSessionFiles", "sessions:file-preview", {
        "200": { description: "At most 20 project-relative path suggestions for `@` references (names only, never contents). Git projects list tracked and non-ignored files; others use a bounded walk without .git and node_modules. Sensitive names are omitted. An empty query lists the project root.", ...json(ref("ProjectFileSearch")) },
        "400": error(400, "The query is invalid or the project root is no longer the session's frozen root."),
        "404": error(404, "Session not found."),
      }, { parameters: [...sessionParameters, { name: "query", in: "query", required: false, schema: { type: "string", maxLength: 256 }, description: "Fuzzy path query; a leading @ is ignored." }] }),
    },
    "/v1/sessions/{id}/commands": {
      get: operation("listSessionCommands", "sessions:export", {
        "200": { description: "Commands the composer offers after `/`: host commands (compact, reload), prompt templates and skill:<name>, discovered from the session project and the service agentDir. Read from disk without creating a runtime; templates and skills apply to a running session after /reload.", ...json(ref("SessionCommandList")) },
        "404": error(404, "Session not found."),
      }, { parameters: sessionParameters }),
      post: operation("runSessionCommand", "sessions:control", {
        "200": { description: "Command finished. compact publishes compaction_start/compaction_end and then completed/aborted/error SSE events under its own requestId; reload publishes no events.", ...json(ref("SessionCommandResult")) },
        "400": error(400, "Invalid command body."),
        "404": error(404, "Session not found."),
        "409": error(409, "The session is busy, or the compaction was cancelled (code COMMAND_ABORTED)."),
        "422": error(422, "The command failed, for example nothing to compact."),
        "501": error(501, "The session agent does not support host commands."),
      }, { parameters: sessionParameters, requestBody: request(ref("SessionCommandInput")), ...requestValidation }),
    },
    "/v1/sessions/{id}/control-queue": {
      get: operation("getControlQueue", "sessions:export", { "200": { description: "Authoritative resident SDK queue. Public event reconciliation has propagation delay, not atomic realtime drain notification. No pending input-extension work or custom SDK messages.", ...json(ref("ControlQueueSnapshot")) }, "404": error(404, "Session not found.") }, { parameters: sessionParameters }),
      head: automaticHeadOperation("getControlQueueHead", "sessions:export", { "200": headJson("Authoritative queue; body suppressed."), "404": headJson("Session not found.") }, { parameters: sessionParameters }),
    },
    "/v1/sessions/{id}/control-queue/{controlId}": {
      delete: operation("deleteControl", "sessions:control", { "200": { description: "Resident object withdrawn (or idempotent deletion). Late input enqueue is fenced.", ...json(ref("ControlQueueSnapshot")) }, "400": error(400, "Malformed identity."), "404": error(404, "Session not found."), "409": error(409, "Unknown identity, actor/run mismatch or already dequeued.") }, { parameters: [...sessionParameters, { name: "controlId", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 128 } }], requestBody: request(ref("ControlMutationInput")), ...requestValidation }),
    },
    "/v1/sessions/{id}/control-queue/{controlId}/promote": {
      post: operation("promoteControl", "sessions:control", { "200": { description: "Original follow-up object moved to steer without replaying input processing; resident repeats are idempotent.", ...json(ref("ControlQueueSnapshot")) }, "400": error(400, "Malformed identity."), "404": error(404, "Session not found."), "409": error(409, "Unknown identity, actor/run mismatch, not follow-up or already dequeued.") }, { parameters: [...sessionParameters, { name: "controlId", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 128 } }], requestBody: request(ref("ControlMutationInput")), ...requestValidation }),
    },
    "/v1/sessions/{id}/steer": {
      post: operation("steerSession", "sessions:control", { "202": { description: "Correlated control admitted, empty body. Not consumption: only steering_consumed SSE with the exact session/controlId/requestId/acknowledgementId confirms it; the primary task stays active." }, "204": { description: "Legacy text-only control admitted, empty body; no consumption acknowledgement." }, "400": error(400, "Invalid or incomplete steering identity or images."), "404": error(404, "Session not found."), "409": error(409, "No active task, primary request mismatch, or conflicting control identity/payload/actor.") }, { parameters: sessionParameters, requestBody: request(ref("SteeringInput")), ...requestValidation }),
    },
    "/v1/sessions/{id}/follow-ups": {
      post: operation("followUpSession", "sessions:control", { "202": { description: "Correlated follow-up admitted; empty body. Queue removal and exact consumption acknowledgement are independent." }, "204": noContent, "400": error(400, "Invalid or incomplete identity or images."), "404": error(404, "Session not found."), "409": error(409, "No active task or identity/payload/actor conflict.") }, { parameters: sessionParameters, requestBody: request(ref("SteeringInput")), ...requestValidation }),
    },
    "/v1/sessions/{id}/abort": {
      post: operation("abortSession", "sessions:control", { "204": noContent, "400": error(400, "Invalid abort input."), "404": error(404, "Session not found."), "409": { description: "No active task, requestId mismatch, or model-failback continuation.", content: { "application/json": { schema: { anyOf: [ref("ApiError"), { type: "object", required: ["statusCode", "error", "code", "message"], properties: { statusCode: { const: 409 }, error: { const: "Conflict" }, code: { const: "MODEL_FAILBACK_IN_PROGRESS", description: "A model-failback continuation owns this request; retry abort after its end event." }, message: { type: "string" } }, additionalProperties: false }] } } } } }, {
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
      Project: { type: "object", required: ["id", "name", "cwd", "isDefault"], properties: { id: { type: "string" }, name: { type: "string" }, cwd: { type: "string" }, isDefault: { type: "boolean" }, canDelete: { type: "boolean", description: "Current actor owns this non-default project; shared automatic projects are system-administered." }, canCreateSession: { type: "boolean", description: "Current route RBAC and project access allow creating an actor-owned private session; does not grant project mutation or access to other actors' private resources." } }, additionalProperties: false },
      SessionStep: { type: "object", additionalProperties: false, required: ["id", "kind", "content", "status", "source"], properties: {
        id: { type: "string" }, kind: { type: "string", enum: ["user", "thinking", "assistant_text", "tool_call", "tool_result", "notification", "system_event", "error", "compaction", "custom"] }, content: {},
        status: { type: "string", enum: ["streaming", "completed", "error", "aborted", "unknown"] }, source: { type: "string", enum: ["recorded", "observed"] },
        timestamp: { type: "string" }, sourceEntryId: { type: "string" }, requestId: { type: "string" }, toolName: { type: "string" }, toolCallId: { type: "string" }, parentToolCallId: { type: "string" }, label: { type: "string" }, omission: { type: "string" },
        images: { type: "array", items: { type: "object", additionalProperties: false, required: ["mediaType", "base64"], properties: { mediaType: { type: "string" }, base64: { type: "string" } } } },
      } },
      SubagentRun: { type: "object", required: ["id", "runId", "agent", "task", "startedAt", "status", "revision"], properties: {
        id: { type: "string" }, runId: { type: "string" }, agent: { type: "string" }, task: { type: "string" }, startedAt: { type: "number" }, endedAt: { type: "number" },
        status: { type: "string", enum: ["running", "completed", "failed", "stopped", "unknown"] }, model: { type: "string" }, thinkingLevel: { type: "string" }, revision: { type: "integer" }, streamRevision: { type: "integer" }, legacy: { type: "boolean" },
      }, additionalProperties: false },
      SubagentSnapshot: { type: "object", required: ["sessionId", "runs"], properties: {
        sessionId: { type: "string" }, runs: { type: "array", items: ref("SubagentRun") },
        conversation: { type: "object", required: ["run", "timeline", "inputs", "messages"], properties: {
          run: ref("SubagentRun"), timeline: { type: "array", items: { type: "object", description: "Client TimelineItem: message, thinking or tool, with the SDK message time as an ISO timestamp when recorded; sourceLabel records user provenance and hostInput (initial | steer) marks the host agent's turns." } },
          messages: { type: "array", items: {}, description: "Original SDK messages, without transcript truncation." },
          inputs: { type: "array", items: { type: "object", required: ["id", "text", "timestamp", "kind", "delivery"], properties: {
            id: { type: "string" }, text: { type: "string" }, timestamp: { type: "number" }, kind: { type: "string", enum: ["initial", "steer"] },
            delivery: { type: "string", enum: ["submitted", "delivered", "failed", "unknown"] },
          }, additionalProperties: false } },
        }, additionalProperties: false },
      }, additionalProperties: false },
      SessionStepsSnapshot: { type: "object", additionalProperties: false, required: ["sessionId", "projectionId", "revision", "steps"], properties: { sessionId: { type: "string" }, projectionId: { type: "string" }, revision: { type: "integer", minimum: 0 }, steps: { type: "array", items: ref("SessionStep") } } },
      SessionSystemPrompt: { oneOf: [
        { type: "object", additionalProperties: false, required: ["source", "prompt"], properties: { source: { type: "string", enum: ["live_effective", "creation_snapshot"] }, prompt: { type: "string" } } },
        { type: "object", additionalProperties: false, required: ["source", "prompt"], properties: { source: { type: "string", enum: ["unavailable"] }, prompt: { type: "null" } } },
      ], description: "Only current effective or creation snapshot provenance is reported. Historical structured records do not prove the forced prompt sent to a model. Empty strings are valid prompts." },
      Session: { type: "object", required: ["id", "ownerKey", "projectId", "title", "createdAt", "updatedAt", "modelProvider", "modelId", "thinkingLevel", "systemPrompt", "capabilityVersions"], properties: { id: { type: "string" }, ownerKey: { type: "string" }, visibility: { type: "string", enum: ["private", "shared"], description: "Native shared sessions are available to admitted users subject to RBAC and cwd exclusions; absent means private." }, origin: { type: "string", enum: ["managed", "native"], description: "Absent means managed." }, projectId: { type: "string" }, title: { type: "string" }, firstPrompt: { type: ["string", "null"], description: "Read-only first persisted user prompt for display; never a rename payload." }, createdAt: { type: "number" }, updatedAt: { type: "number" }, modelProvider: { type: ["string", "null"] }, modelId: { type: ["string", "null"] }, thinkingLevel: { type: ["string", "null"] }, systemPrompt: { type: ["string", "null"] }, capabilityVersions: { type: ["string", "null"] } }, additionalProperties: false },
      CreateProject: { type: "object", required: ["name", "cwd"], properties: { name: { type: "string" }, cwd: { type: "string" } }, additionalProperties: false },
      UploadedFile: { type: "object", required: ["fileId", "name", "mediaType", "size", "status", "agentPath"], properties: { fileId: { type: "string" }, name: { type: "string" }, mediaType: { type: "string" }, size: { type: "integer" }, status: { const: "ready" }, agentPath: { type: "string" } }, additionalProperties: false },
      CreateSession: { type: "object", properties: { createRequestId: { type: "string", minLength: 1, maxLength: 128 }, title: { type: "string" }, projectId: { type: "string" }, modelProvider: { type: "string", minLength: 1 }, modelId: { type: "string", minLength: 1 }, thinkingLevel: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] } }, dependentRequired: { modelProvider: ["modelId"], modelId: ["modelProvider"] }, additionalProperties: false },
      RenameSession: { type: "object", required: ["title"], properties: { title: { type: "string" } }, additionalProperties: false },
      SessionConfig: { type: "object", properties: { modelProvider: { type: "string", minLength: 1 }, modelId: { type: "string", minLength: 1 }, thinkingLevel: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] } }, additionalProperties: false },
      ImageInput: { type: "object", required: ["mediaType", "base64"], properties: { mediaType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] }, base64: { type: "string", maxLength: 5592408 } }, additionalProperties: false },
      MessageInput: { type: "object", required: ["requestId", "prompt"], properties: { requestId: { type: "string", maxLength: 128 }, prompt: { type: "string", maxLength: 32768 }, parentId: { type: "string" }, images: { type: "array", maxItems: 4, items: ref("ImageInput") }, fileIds: { type: "array", maxItems: 5, items: { type: "string" } } }, additionalProperties: false },
      SubmitResult: { oneOf: [{ type: "object", required: ["status"], properties: { status: { const: "accepted" } }, additionalProperties: false }, { type: "object", required: ["status"], properties: { status: { const: "queued" }, position: { type: "integer" } }, additionalProperties: false }] },
      FilePreview: { type: "object", required: ["path", "content", "lineCount"], properties: { path: { type: "string", description: "Normalized project-relative path." }, content: { type: "string", description: "Complete UTF-8 content; maximum 262144 bytes." }, lineCount: { type: "integer", minimum: 1 }, requestedLine: { type: "integer", minimum: 1 } }, additionalProperties: false },
      ProjectFileSearch: { type: "object", required: ["entries", "truncated"], properties: { entries: { type: "array", maxItems: 20, items: { type: "object", required: ["path", "kind"], properties: { path: { type: "string", description: "Project-relative path with / separators." }, kind: { enum: ["file", "directory"] } }, additionalProperties: false } }, truncated: { type: "boolean", description: "The project listing hit its file cap; some paths cannot be suggested." } }, additionalProperties: false },
      SessionCommandList: { type: "object", required: ["commands"], properties: { commands: { type: "array", items: { type: "object", required: ["name", "source", "description"], properties: { name: { type: "string", description: "Typed after /." }, source: { enum: ["builtin", "prompt", "skill"] }, description: { type: "string" }, argumentHint: { type: "string" } }, additionalProperties: false } } }, additionalProperties: false },
      SessionCommandInput: { type: "object", required: ["command"], properties: { command: { enum: ["compact", "reload"] }, args: { type: "string", maxLength: 4000, description: "compact: optional summary instructions." } }, additionalProperties: false },
      SessionCommandResult: { oneOf: [
        { type: "object", required: ["command", "tokensBefore"], properties: { command: { const: "compact" }, tokensBefore: { type: "number", minimum: 0 }, tokensAfter: { type: "number", minimum: 0 } }, additionalProperties: false },
        { type: "object", required: ["command", "contextFiles", "promptTemplates", "skills", "extensions"], properties: { command: { const: "reload" }, contextFiles: { type: "integer", minimum: 0 }, promptTemplates: { type: "integer", minimum: 0 }, skills: { type: "integer", minimum: 0 }, extensions: { type: "integer", minimum: 0 } }, additionalProperties: false },
      ] },
      ExportMessage: { type: "object", required: ["role", "text"], properties: { id: { type: "string", description: "Preserved legacy host message id, if any." }, sourceId: { type: "string", description: "Pi JSONL message-entry id. When present, exactly matches timeline.messageId; image-only messages have one too." }, role: { enum: ["user", "assistant"] }, text: { type: "string" }, images: { type: "array", items: ref("ImageInput") } }, additionalProperties: false },
      ExecutionSnapshot: { type: "object", required: ["scope", "coverage", "totalLoops", "totalTurns", "recordedLoops", "recordedTurns"], properties: {
        scope: { const: "allEntries" }, coverage: { enum: ["complete", "recorded", "unknown"] },
        totalLoops: { type: ["integer", "null"], minimum: 0 }, totalTurns: { type: ["integer", "null"], minimum: 0 },
        recordedLoops: { type: ["integer", "null"], minimum: 0 }, recordedTurns: { type: ["integer", "null"], minimum: 0 },
      }, additionalProperties: false, description: "Durable host-task loops and real SDK turns, deduplicated across all entries. Partial legacy histories have null totals and recorded-only counts." },
      UsageSnapshot: { type: "object", properties: snapshotProperties, additionalProperties: false },
      LastResponseUsage: { type: "object", required: [...Object.keys(usageTokenProperties), "ordinal", "cacheHitPercent", "speed"], properties: {
        ...usageTokenProperties, ordinal: { type: ["integer", "null"], minimum: 1 }, cacheHitPercent: measurementNumber,
        speed: { type: "object", required: ["outputTokens", "generationDurationMs", "tokensPerSecond"], properties: {
          outputTokens: measurementNumber, generationDurationMs: measurementNumber,
          tokensPerSecond: { ...measurementNumber, description: "SDK output / first nonempty text, thinking or toolcall delta to message_end seconds; null below 10ms. No clamp." },
        }, additionalProperties: false },
      }, additionalProperties: false },
      SessionUsageTotals: { type: "object", required: [...Object.keys(usageTokenProperties), "scope"], properties: { ...usageTokenProperties, scope: { const: "allEntries" } }, additionalProperties: false },
      PromptUsage: { type: "object", description: "Every model call of the current host prompt, summed; a field is null once any call lacks it. Null when this process did not run the prompt.", required: [...Object.keys(usageTokenProperties), "calls"], properties: { ...usageTokenProperties, calls: { type: "integer", minimum: 0 } }, additionalProperties: false },
      SubagentUsage: { type: "object", description: "Child agent model calls on the current branch (completed assistant messages), summed. Not included in sessionTotals.", required: [...Object.keys(usageTokenProperties), "runs", "calls"], properties: { ...usageTokenProperties, runs: { type: "integer", minimum: 1 }, calls: { type: "integer", minimum: 0 } }, additionalProperties: false },
      ContextUsage: { type: "object", required: ["tokens", "window", "percent", "estimate"], properties: { tokens: measurementNumber, window: { type: ["number", "null"], exclusiveMinimum: 0 }, percent: measurementNumber, estimate: { const: true } }, additionalProperties: false },
      Export: { type: "object", required: ["messages", "timeline", "lastEventId"], properties: { messages: { type: "array", items: ref("ExportMessage"), description: "Legacy message projection. Pi transcripts include sourceId; no text-based timeline association is permitted." }, timeline: { type: "array", items: ref("TimelineItem"), description: "Current-branch, block-ordered history. Thinking content is preserved verbatim; tool text/JSON is not host-truncated." }, lastEventId: { type: "integer", minimum: 0 }, usageSnapshot: ref("UsageSnapshot"), compaction: ref("CompactionState") }, additionalProperties: false },
      CompactionState: { type: "object", required: ["status", "reason"], properties: {
        status: { enum: ["running", "succeeded", "failed", "aborted", "unknown"] }, reason: { enum: ["manual", "threshold", "overflow"] },
        requestId: { type: "string" }, tokensBefore: { type: "number", minimum: 0 }, tokensAfter: { type: "number", minimum: 0 }, willRetry: { type: "boolean" },
      }, additionalProperties: false, description: "Ephemeral runtime metadata at lastEventId; absent without an observed live compaction and cleared once the owning task or command ends (completed/error/aborted), so a finished compaction is never replayed. Restore running as unknown until live confirmation. No summary or SDK error." },
      TimelineItem: { oneOf: [
        { type: "object", required: ["id", "type", "version", "notificationId", "runIds", "text", "entryId", "timestamp", "order"], properties: { id: { type: "string" }, type: { const: "notification" }, version: { const: 1 }, notificationId: { type: "string", format: "uuid" }, runIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, text: { type: "string" }, entryId: { type: "string" }, timestamp: { type: "string" }, order: { type: "integer", minimum: 0 } }, additionalProperties: false },
        { type: "object", required: ["id", "type", "role", "messageId", "turnId", "text", "order"], properties: { id: { type: "string" }, type: { const: "message" }, role: { enum: ["user", "assistant"] }, messageId: { type: "string" }, turnId: { type: ["string", "null"] }, text: { type: "string" }, order: { type: "integer", minimum: 0 }, timestamp: { type: "string" }, stopReason: { const: "aborted", description: "Explicitly interrupted assistant text; omitted when unavailable, never inferred from partial text." } }, additionalProperties: false },
        { type: "object", required: ["id", "type", "messageId", "turnId", "text", "order"], properties: { id: { type: "string" }, type: { const: "thinking" }, messageId: { type: "string" }, turnId: { type: ["string", "null"] }, text: { type: "string", description: "Exact persisted assistant thinking text; no summary substitution." }, order: { type: "integer", minimum: 0 }, timestamp: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["id", "type", "messageId", "turnId", "callId", "toolCallId", "toolName", "args", "status", "order"], properties: { id: { type: "string" }, type: { const: "tool_call" }, messageId: { type: "string" }, turnId: { type: ["string", "null"] }, callId: { type: "string", description: "SDK tool-call id; use as the SSE deduplication key." }, toolCallId: { type: "string" }, toolName: { type: "string" }, args: {}, status: { enum: ["completed", "error", "no_result"] }, order: { type: "integer", minimum: 0 }, timestamp: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["id", "type", "messageId", "turnId", "callId", "toolCallId", "toolName", "result", "isError", "order"], properties: { id: { type: "string" }, type: { const: "tool_result" }, messageId: { type: ["string", "null"] }, turnId: { type: ["string", "null"] }, callId: { type: "string" }, toolCallId: { type: "string" }, toolName: { type: "string" }, result: {}, isError: { type: "boolean" }, durationMs: { type: ["number", "null"], minimum: 0 }, order: { type: "integer", minimum: 0 }, timestamp: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["id", "type", "event", "from", "to", "reason", "order"], properties: { id: { type: "string" }, type: { const: "system_event" }, event: { const: "model_failback" }, from: { type: "string" }, to: { type: "string" }, reason: { type: "string" }, order: { type: "integer", minimum: 0 }, timestamp: { type: "string" } }, additionalProperties: false },
      ] },
      SteeringIdentity: { type: "object", required: ["controlId", "acknowledgementId", "requestId"], properties: { controlId: { type: "string", minLength: 1, maxLength: 128 }, acknowledgementId: { type: "string", minLength: 1, maxLength: 128 }, requestId: { type: "string", maxLength: 128 } }, additionalProperties: false },
      SteeringInput: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 32768 }, controlId: { type: "string", minLength: 1, maxLength: 128 }, acknowledgementId: { type: "string", minLength: 1, maxLength: 128 }, requestId: { type: "string", maxLength: 128 }, images: { type: "array", maxItems: 4, items: ref("ImageInput") } }, anyOf: [{ required: ["controlId", "acknowledgementId", "requestId"] }, { not: { anyOf: [{ required: ["controlId"] }, { required: ["acknowledgementId"] }, { required: ["requestId"] }, { required: ["images"] }] } }], additionalProperties: false, description: "Legacy text-only or complete correlated identity, optionally with images. File attachments are not supported. Admission is not consumption." },
      SteeringConsumed: { type: "object", required: ["type", "controlId", "acknowledgementId", "requestId"], properties: { type: { const: "steering_consumed" }, controlId: { type: "string" }, acknowledgementId: { type: "string" }, requestId: { type: "string" }, message: { type: "object", required: ["sourceId", "text"], properties: { sourceId: { type: "string", minLength: 1 }, text: { type: "string" }, images: { type: "array", maxItems: 4, items: ref("ImageInput") } }, additionalProperties: false } }, additionalProperties: false, description: "Exact queued SDK user-message object was consumed once. Optional message projects its persisted user entry, before subsequent assistant deltas; sourceId deduplicates live/replay/export history. Missing message never implies a visible user bubble. Nonterminal; never acknowledge by matching text." },
      ControlMutationInput: { type: "object", required: ["requestId", "acknowledgementId"], properties: { requestId: { type: "string", minLength: 1, maxLength: 128 }, acknowledgementId: { type: "string", minLength: 1, maxLength: 128 } }, additionalProperties: false },
      ControlQueueItem: { type: "object", required: ["id", "kind", "text", "hasImages", "status", "acknowledgementId"], properties: { id: { type: "string" }, kind: { enum: ["steer", "followUp"] }, text: { type: "string" }, hasImages: { type: "boolean" }, status: { const: "queued" }, acknowledgementId: { type: "string" } }, additionalProperties: false },
      ControlQueueSnapshot: { type: "object", required: ["requestId", "revision", "items"], properties: { requestId: { type: ["string", "null"] }, revision: { type: "integer", minimum: 0 }, items: { type: "array", items: ref("ControlQueueItem") } }, additionalProperties: false },
      ControlQueueEvent: { type: "object", required: ["type", "requestId", "revision", "items"], properties: { type: { const: "control_queue" }, requestId: { type: ["string", "null"] }, revision: { type: "integer", minimum: 0 }, items: { type: "array", items: ref("ControlQueueItem") } }, additionalProperties: false },
      TextInput: { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
      AbortInput: { type: "object", required: ["requestId"], properties: { requestId: { type: "string", maxLength: 128 } }, additionalProperties: false },
      SseEvent: { oneOf: [
        { type: "object", required: ["type", "reason"], properties: { type: { const: "compaction_start" }, reason: { enum: ["manual", "threshold", "overflow"] }, requestId: { type: "string" }, replay: { type: "boolean" } }, additionalProperties: false },
        { type: "object", required: ["type", "reason", "outcome", "willRetry"], properties: { type: { const: "compaction_end" }, reason: { enum: ["manual", "threshold", "overflow"] }, outcome: { enum: ["succeeded", "failed", "aborted"] }, willRetry: { type: "boolean" }, tokensBefore: { type: "number", minimum: 0 }, tokensAfter: { type: "number", minimum: 0 }, requestId: { type: "string" }, replay: { type: "boolean" } }, additionalProperties: false },
        ref("SteeringConsumed"),
        ref("ControlQueueEvent"),
        { type: "object", required: ["type", "projectionId", "revision"], properties: { type: { const: "steps_changed" }, projectionId: { type: "string" }, revision: { type: "integer", minimum: 0 } }, additionalProperties: false,
          description: "The session-steps projection moved, from any source (live events, persisted reconciliation, branch change, idle-time entries). Coalesced to at most one per 250 ms with the final position always sent. Carries no step content: read GET /v1/sessions/{id}/steps; a new projectionId replaces the snapshot. Session-level, never request-owned." },
        { type: "object", required: ["type", "revision"], properties: { type: { const: "subagents_changed" }, revision: { type: "integer", minimum: 0 } }, additionalProperties: false,
          description: "Subagent records or live output moved: a transcript entry (start, message, steer, end), a live partial, or a legacy collected-log tool result. Coalesced to at most one per 250 ms with the final change always sent; also sent while the parent is idle and children run in the background. Carries no run data: read GET /v1/sessions/{id}/subagents. Session-level, never request-owned." },
        { type: "object", required: ["type", "version", "notificationId", "runIds", "text", "entryId", "timestamp"], properties: { type: { const: "notification" }, version: { const: 1 }, notificationId: { type: "string", format: "uuid" }, runIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, text: { type: "string" }, entryId: { type: "string" }, timestamp: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "text"], properties: { type: { const: "text_delta" }, text: { type: "string" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "text"], properties: { type: { const: "thinking_delta" }, text: { type: "string" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "ordinal", "phase", "tokensPerSecondEstimate", "includesThinking"], properties: {
          type: { const: "model_output_progress" }, ordinal: { type: "integer", minimum: 1 },
          phase: { enum: ["start", "delta", "end"] }, tokensPerSecondEstimate: { type: ["number", "null"], minimum: 0 },
          includesThinking: { type: "boolean" }, activityAgeMs: { type: "number", minimum: 0 }, replay: { type: "boolean" }, requestId: { type: "string" },
          promptTokens: { type: ["number", "null"], minimum: 0, description: "Total tokens of this prompt's completed model calls so far." },
        }, additionalProperties: false },
        { type: "object", required: ["type", "toolCallId", "toolName", "args"], properties: { type: { const: "tool_start" }, toolCallId: { type: "string" }, toolName: { type: "string" }, args: {}, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "toolCallId", "toolName", "partialResult"], properties: { type: { const: "tool_update" }, toolCallId: { type: "string" }, toolName: { type: "string" }, partialResult: {}, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "toolCallId", "toolName", "result", "isError"], properties: { type: { const: "tool_end" }, toolCallId: { type: "string" }, toolName: { type: "string" }, result: {}, isError: { type: "boolean" }, durationMs: { type: ["number", "null"], minimum: 0 }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "phase"], properties: { type: { const: "status" }, phase: { type: "string", enum: ["agent_start", "turn_start"] }, execution: snapshotProperties.execution, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type"], properties: { type: { const: "queued" }, position: { type: "integer" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "promptTokens", "completionTokens", "totalTokens", "durationMs", "ttftMs"], properties: { ...snapshotProperties, type: { const: "usage" }, promptTokens: { type: ["number", "null"], description: "SDK input (excluding cache); null when unavailable, zero when measured." }, completionTokens: { type: ["number", "null"] }, totalTokens: { type: ["number", "null"], description: "SDK totalTokens, not a locally reconstructed sum." }, durationMs: { type: "number" }, ttftMs: { type: "number" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "phase", "attemptId"], properties: { type: { const: "model_failback" }, phase: { type: "string", enum: ["start", "end"] }, attemptId: { type: "string" }, outcome: { type: "string", enum: ["switched", "no-target", "failed", "cancelled"] }, from: { type: "string" }, to: { type: "string" }, reason: { type: "string" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type", "message"], properties: { type: { const: "error" }, message: { type: "string" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type"], properties: { type: { const: "completed" }, requestId: { type: "string" } }, additionalProperties: false },
        { type: "object", required: ["type"], properties: { type: { const: "aborted" }, requestId: { type: "string" } }, additionalProperties: false },
      ] },
    },
  },
} as const;
