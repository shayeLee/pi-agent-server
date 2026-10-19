// pi-agent-server HTTP API client. Uses only the Fetch API and can be adapted per host.

import type { Export } from "../public-api/contract.js";
import type { AccessCapabilities, ModelInfo, Project, SessionRecord } from "./types.js";
import { defaultFetch, hasHeader, resolveHeaders } from "./transport.js";
import type { AuthToken, FetchLike, HeadersProvider } from "./transport.js";

export type UploadedFile = {
  fileId: string;
  name: string;
  mediaType: string;
  size: number;
  status: "ready";
  agentPath: string;
};

export type SendMessageInput = {
  requestId: string;
  prompt: string;
  parentId?: string;
  images?: { mediaType: string; base64: string }[];
  /** Server-verified non-image upload IDs, in the order referenced by this message. */
  fileIds?: string[];
};

/** Fetch implementation and host-specific request resolution options. */
export type ApiClientDependencies = {
  fetch?: FetchLike;
  headers?: HeadersProvider;
  /** Resolve an API path to a complete URL (for proxies, native transports, or custom routing). */
  resolveUrl?: (path: string) => string;
};

/** Options form for constructing ApiClient without browser globals or fixed credentials. */
export type ApiClientOptions = ApiClientDependencies & {
  baseUrl?: string;
  /** Static token or a provider evaluated for each request. */
  token?: AuthToken;
};

/** 携带 HTTP 状态码的错误：便于区分「服务端明确拒绝」（如 409 已接受）与网络传输失败。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private readonly options: ApiClientOptions;

  /** Legacy Web-compatible form: new ApiClient(baseUrl, token, dependencies?). */
  constructor(baseUrl: string, token: string, dependencies?: ApiClientDependencies);
  /** Reusable options form with injected URL, authentication, and fetch behavior. */
  constructor(options?: ApiClientOptions);
  constructor(
    baseUrlOrOptions: string | ApiClientOptions = "",
    token = "",
    dependencies: ApiClientDependencies = {},
  ) {
    this.options =
      typeof baseUrlOrOptions === "string"
        ? { ...dependencies, baseUrl: baseUrlOrOptions, token }
        : baseUrlOrOptions;
  }

  private async request<T>(method: string, path: string, body?: unknown, response: "json" | "void" = "json"): Promise<T> {
    const headers = await resolveHeaders(this.options.headers);
    if (body !== undefined && !hasHeader(headers, "content-type")) {
      headers["content-type"] = "application/json";
    }

    const token =
      typeof this.options.token === "function" ? await this.options.token() : this.options.token;
    // token 为空时（内网免登录）不带 authorization header
    if (token) headers.authorization = `Bearer ${token}`;

    const url = this.options.resolveUrl
      ? this.options.resolveUrl(path)
      : `${this.options.baseUrl ?? ""}${path}`;
    const fetcher = this.options.fetch ?? defaultFetch;
    const res = await fetcher(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, `HTTP ${res.status}${text ? `: ${text}` : ""}`);
    }
    if (res.status === 204 || response === "void") return undefined as T;
    return (await res.json()) as T;
  }

  createSession(title?: string, projectId?: string, createRequestId?: string): Promise<SessionRecord> {
    return this.request("POST", "/v1/sessions", { title, projectId, createRequestId });
  }

  /** Upload exact non-image bytes before a session exists. The caller retains only IDs in unsent UI state. */
  async uploadFile(input: {
    projectId: string;
    uploadKey: string;
    name: string;
    mediaType: string;
    kind: "text" | "code" | "csv" | "json" | "pdf" | "docx" | "xlsx" | "pptx";
    bytes: Uint8Array;
  }): Promise<UploadedFile> {
    const headers = await resolveHeaders(this.options.headers);
    const token = typeof this.options.token === "function" ? await this.options.token() : this.options.token;
    if (token) headers.authorization = `Bearer ${token}`;
    headers["content-type"] = "application/octet-stream";
    headers["x-upload-project-id"] = input.projectId;
    headers["x-upload-key"] = input.uploadKey;
    headers["x-upload-name"] = encodeURIComponent(input.name);
    headers["x-upload-type"] = input.mediaType;
    headers["x-upload-kind"] = input.kind;
    const url = this.options.resolveUrl ? this.options.resolveUrl("/v1/files") : `${this.options.baseUrl ?? ""}/v1/files`;
    const response = await (this.options.fetch ?? defaultFetch)(url, {
      method: "POST", headers, body: new Blob([new Uint8Array(input.bytes)]),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new ApiError(response.status, `HTTP ${response.status}${message ? `: ${message}` : ""}`);
    }
    return (await response.json()) as UploadedFile;
  }

  listSessions(): Promise<SessionRecord[]> {
    return this.request("GET", "/v1/sessions");
  }

  listSessionsByProject(projectId: string): Promise<SessionRecord[]> {
    return this.request("GET", `/v1/sessions?projectId=${encodeURIComponent(projectId)}`);
  }

  listProjects(): Promise<Project[]> {
    return this.request("GET", "/v1/projects");
  }

  createProject(name: string, cwd: string): Promise<Project> {
    return this.request("POST", "/v1/projects", { name, cwd });
  }

  deleteProject(id: string): Promise<void> {
    return this.request("DELETE", `/v1/projects/${id}`);
  }

  /** 项目的 MCP server 设置；configured 始终为 true。 */
  getProjectMcp(projectId: string): Promise<import("../shared/project-mcp.js").ProjectMcpSettings> {
    return this.request("GET", `/v1/projects/${encodeURIComponent(projectId)}/mcp`);
  }

  /** 修改只影响之后创建或恢复的会话。 */
  saveProjectMcpServer(projectId: string, name: string, input: import("../shared/project-mcp.js").ProjectMcpServerInput): Promise<{ server: import("../shared/project-mcp.js").ProjectMcpServer }> {
    return this.request("PUT", `/v1/projects/${encodeURIComponent(projectId)}/mcp/servers/${encodeURIComponent(name)}`, input);
  }

  /** 共享 MCP（Pi 的全局 mcp.json）；admin 另外拿到打码后的表单、文件 hash 和读取错误。 */
  getSharedMcp(): Promise<import("../shared/shared-mcp.js").SharedMcpList> {
    return this.request("GET", "/v1/mcp/shared");
  }

  /** 新增或修改一项（admin）；hash 对不上时 409，说明文件在别处被改过。 */
  saveSharedMcpServer(name: string, input: import("../shared/shared-mcp.js").SharedMcpServerInput): Promise<import("../shared/shared-mcp.js").SharedMcpList> {
    return this.request("PUT", `/v1/mcp/shared/${encodeURIComponent(name)}`, input);
  }

  removeSharedMcpServer(name: string, hash: string): Promise<import("../shared/shared-mcp.js").SharedMcpList> {
    return this.request("DELETE", `/v1/mcp/shared/${encodeURIComponent(name)}?hash=${encodeURIComponent(hash)}`);
  }

  /** 调用者对需要用户授权的 MCP server 的连接状态。 */
  listMcpConnections(): Promise<{ servers: import("../shared/project-mcp.js").McpConnection[] }> {
    return this.request("GET", "/v1/mcp/connections");
  }

  /** 发起授权；页面随后整页跳转到返回的 authorizationUrl，完成后回到 Web 首页并带上 mcp_oauth 结果。 */
  startMcpOAuth(name: string): Promise<{ authorizationUrl: string }> {
    return this.request("POST", `/v1/mcp/servers/${encodeURIComponent(name)}/oauth/start`);
  }

  disconnectMcp(name: string): Promise<void> {
    return this.request("DELETE", `/v1/mcp/servers/${encodeURIComponent(name)}/connection`, undefined, "void");
  }

  listModels(): Promise<{
    models: ModelInfo[];
    thinkingLevels: string[];
    defaultModel: ModelInfo | null;
    defaultThinkingLevel: string;
  }> {
    return this.request("GET", "/v1/models");
  }

  /** 宿主访问能力投影：由服务端中央矩阵派生；用于隐藏无写权限的操作入口。 */
  getAccess(): Promise<AccessCapabilities> {
    return this.request("GET", "/v1/access");
  }

  updateSessionConfig(
    id: string,
    config: { modelProvider?: string; modelId?: string; thinkingLevel?: string },
  ): Promise<SessionRecord> {
    return this.request("PATCH", `/v1/sessions/${id}/config`, config);
  }

  deleteSession(id: string): Promise<void> {
    return this.request("DELETE", `/v1/sessions/${id}`);
  }

  renameSession(id: string, title: string): Promise<SessionRecord> {
    return this.request("PATCH", `/v1/sessions/${id}`, { title });
  }

  sendMessage(sessionId: string, input: SendMessageInput): Promise<unknown> {
    return this.request("POST", `/v1/sessions/${sessionId}/messages`, input);
  }

  steer(sessionId: string, text: string, input?: import("../shared/steering.js").SteeringInput): Promise<void> {
    return this.request("POST", `/v1/sessions/${sessionId}/steer`, { text, ...input }, "void");
  }

  followUp(sessionId: string, text: string, input?: import("../shared/steering.js").SteeringInput): Promise<void> {
    return this.request("POST", `/v1/sessions/${sessionId}/follow-ups`, { text, ...input }, "void");
  }

  getControlQueue(sessionId: string): Promise<import("../shared/control-queue.js").ControlQueueSnapshot> {
    return this.request("GET", `/v1/sessions/${sessionId}/control-queue`);
  }

  deleteControl(sessionId: string, controlId: string, identity: { requestId: string; acknowledgementId: string }): Promise<import("../shared/control-queue.js").ControlQueueSnapshot> {
    return this.request("DELETE", `/v1/sessions/${sessionId}/control-queue/${encodeURIComponent(controlId)}`, identity);
  }

  promoteControl(sessionId: string, controlId: string, identity: { requestId: string; acknowledgementId: string }): Promise<import("../shared/control-queue.js").ControlQueueSnapshot> {
    return this.request("POST", `/v1/sessions/${sessionId}/control-queue/${encodeURIComponent(controlId)}/promote`, identity);
  }

  abort(sessionId: string): Promise<void> {
    return this.request("POST", `/v1/sessions/${sessionId}/abort`);
  }

  getSystemPrompt(id: string): Promise<import("../shared/system-prompt.js").SessionSystemPrompt> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}/system-prompt`);
  }

  getSubagents(id: string, runId?: string): Promise<import("../shared/subagents.js").SubagentSnapshot> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}/subagents${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`);
  }

  getSessionSteps(id: string): Promise<import("../shared/session-steps.js").SessionStepsSnapshot> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}/steps`);
  }

  exportSession(id: string): Promise<Export> {
    return this.request("GET", `/v1/sessions/${id}/export`);
  }

  searchSessionFiles(id: string, query: string): Promise<import("../shared/commands.js").ProjectFileSearch> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}/files?query=${encodeURIComponent(query)}`);
  }

  listSessionCommands(id: string): Promise<import("../shared/commands.js").SessionCommandList> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}/commands`);
  }

  /** `@` suggestions for a draft in this project, before its session exists. */
  searchProjectFiles(projectId: string, query: string): Promise<import("../shared/commands.js").ProjectFileSearch> {
    return this.request("GET", `/v1/projects/${encodeURIComponent(projectId)}/files?query=${encodeURIComponent(query)}`);
  }

  /** Prompt templates and skills a draft in this project can start with (no host commands). */
  listProjectCommands(projectId: string): Promise<import("../shared/commands.js").SessionCommandList> {
    return this.request("GET", `/v1/projects/${encodeURIComponent(projectId)}/commands`);
  }

  /** The blank-session companion's model-written opening line; 503 means "use your own". */
  companionGreeting(projectId: string, input: import("../shared/companion.js").CompanionGreetingInput): Promise<import("../shared/companion.js").CompanionGreeting> {
    return this.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/companion/greeting`, input);
  }

  companionPersona(): Promise<{ persona: import("../shared/companion.js").CompanionPersonaRecord | null }> {
    return this.request("GET", "/v1/companion/persona");
  }

  saveCompanionPersona(persona: import("../shared/companion.js").CompanionPersonaRecord): Promise<{ persona: import("../shared/companion.js").CompanionPersonaRecord }> {
    return this.request("PUT", "/v1/companion/persona", persona);
  }

  runSessionCommand(id: string, input: import("../shared/commands.js").SessionCommandInput): Promise<import("../shared/commands.js").SessionCommandResult> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(id)}/commands`, input);
  }
}
