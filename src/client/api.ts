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
    /** The body's `code` field, when the server sent one (e.g. `invalid_credentials`). */
    readonly code?: string,
    /** Seconds from a `Retry-After` header, when present. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let code: string | undefined;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string") code = (body as { code: string }).code;
  } catch { /* not JSON */ }
  const retryHeader = res.headers?.get?.("retry-after");
  const retryAfter = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : undefined;
  return new ApiError(res.status, `HTTP ${res.status}${text ? `: ${text}` : ""}`, code, retryAfter);
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
    if (!res.ok) throw await errorFrom(res);
    if (res.status === 204 || response === "void") return undefined as T;
    return (await res.json()) as T;
  }

  /** Public: whether this server uses account login. */
  getAuthState(): Promise<import("../shared/auth.js").AuthState> {
    return this.request("GET", "/v1/auth/state");
  }

  /** Public: sets the session cookie. A wrong name or password is 401 `invalid_credentials`. */
  login(name: string, password: string): Promise<{ account: import("../shared/auth.js").AuthAccount }> {
    return this.request("POST", "/v1/auth/login", { name, password });
  }

  logout(): Promise<void> {
    return this.request("POST", "/v1/auth/logout", undefined, "void");
  }

  getAuthMe(): Promise<import("../shared/auth.js").AuthMe> {
    return this.request("GET", "/v1/auth/me");
  }

  /** Cookie login only. Ends every other login of this account and issues this browser a new one. */
  changePassword(current: string, next: string): Promise<void> {
    return this.request("PUT", "/v1/auth/password", { current, next }, "void");
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
    if (!response.ok) throw await errorFrom(response);
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

  /** 扩展命令正在等待回答的问题（对话框）；没有时 prompt 为 null。 */
  getCommandPrompt(sessionId: string): Promise<{ prompt: import("../shared/commands.js").CommandPrompt | null }> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/command-prompt`);
  }

  /** 先答先得；问题已经在别处回答、被取消或超时返回 409。 */
  answerCommandPrompt(sessionId: string, answer: import("../shared/commands.js").CommandPromptAnswer): Promise<void> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/command-prompt`, answer);
  }

  /** 模型登录（admin）：每个 provider 的登录方式和当前状态。 */
  listProviderAuth(): Promise<import("../shared/provider-auth.js").ProviderAuthList> {
    return this.request("GET", "/v1/provider-auth");
  }

  /** 发起登录；之后轮询 getProviderLogin，遇到 prompt 就 answerProviderLogin，直到 state 不再是 running。 */
  startProviderLogin(input: import("../shared/provider-auth.js").ProviderLoginStart): Promise<import("../shared/provider-auth.js").ProviderLogin> {
    return this.request("POST", "/v1/provider-auth/logins", input);
  }

  getProviderLogin(id: string): Promise<import("../shared/provider-auth.js").ProviderLogin> {
    return this.request("GET", `/v1/provider-auth/logins/${encodeURIComponent(id)}`);
  }

  answerProviderLogin(id: string, answer: import("../shared/provider-auth.js").ProviderLoginAnswer): Promise<import("../shared/provider-auth.js").ProviderLogin> {
    return this.request("POST", `/v1/provider-auth/logins/${encodeURIComponent(id)}/answer`, answer);
  }

  cancelProviderLogin(id: string): Promise<import("../shared/provider-auth.js").ProviderLogin> {
    return this.request("DELETE", `/v1/provider-auth/logins/${encodeURIComponent(id)}`);
  }

  /** 退出登录：删掉 auth.json 里这个 provider 的凭证（环境变量和 models.json 不变）。 */
  removeProviderCredential(provider: string): Promise<import("../shared/provider-auth.js").ProviderAuthList> {
    return this.request("DELETE", `/v1/provider-auth/credentials/${encodeURIComponent(provider)}`);
  }

  /**
   * Agent 设置（Pi 全局 settings.json 里的几个字段）；admin 另外拿到文件 hash 和读取错误。
   * 给了项目时，另外说明项目 .pi/settings.json 覆盖了哪几项。
   */
  getAgentSettings(projectId?: string): Promise<import("../shared/agent-settings.js").AgentSettings> {
    return this.request("GET", `/v1/settings${projectId === undefined ? "" : `?projectId=${encodeURIComponent(projectId)}`}`);
  }

  /** 项目是否受信任（Pi 的 trust.json），以及项目里有哪些受信任才加载的文件。 */
  getProjectTrust(projectId: string): Promise<import("../shared/project-trust.js").ProjectTrustView> {
    return this.request("GET", `/v1/projects/${encodeURIComponent(projectId)}/trust`);
  }

  /** 在 trust.json 里给项目记一条信任或不信任（admin）。 */
  saveProjectTrust(projectId: string, trusted: boolean): Promise<import("../shared/project-trust.js").ProjectTrustView> {
    return this.request("PUT", `/v1/projects/${encodeURIComponent(projectId)}/trust`, { trusted });
  }

  /** 只改给出的项（admin）；hash 对不上时 409，说明文件在别处被改过。 */
  saveAgentSettings(input: import("../shared/agent-settings.js").AgentSettingsInput): Promise<import("../shared/agent-settings.js").AgentSettings> {
    return this.request("PUT", "/v1/settings", input);
  }

  /**
   * 调用者对需要用户授权的 MCP server 的连接状态。给了项目时还有这个项目（受信任时）.pi/mcp.json 里的 server，
   * 它们的授权按项目分开；下面两个方法同理。
   */
  listMcpConnections(projectId?: string): Promise<{ servers: import("../shared/project-mcp.js").McpConnection[] }> {
    return this.request("GET", `/v1/mcp/connections${projectId === undefined ? "" : `?projectId=${encodeURIComponent(projectId)}`}`);
  }

  /** 发起授权；页面随后整页跳转到返回的 authorizationUrl，完成后回到 Web 首页并带上 mcp_oauth 结果。 */
  startMcpOAuth(name: string, projectId?: string): Promise<{ authorizationUrl: string }> {
    return this.request("POST", `/v1/mcp/servers/${encodeURIComponent(name)}/oauth/start${projectId === undefined ? "" : `?projectId=${encodeURIComponent(projectId)}`}`);
  }

  disconnectMcp(name: string, projectId?: string): Promise<void> {
    return this.request("DELETE", `/v1/mcp/servers/${encodeURIComponent(name)}/connection${projectId === undefined ? "" : `?projectId=${encodeURIComponent(projectId)}`}`, undefined, "void");
  }

  /** 给了项目时，modelThinkingLevels 叠加这个项目（受信任时）的 .pi/settings.json，即该项目新会话实际用的档位。 */
  listModels(projectId?: string): Promise<{
    models: ModelInfo[];
    thinkingLevels: string[];
    defaultModel: ModelInfo | null;
    defaultThinkingLevel: string;
    /** 按模型的默认思考档位，键是 `provider/modelId`；新会话没选档位时先用它，再用 defaultThinkingLevel。 */
    modelThinkingLevels: Record<string, string>;
  }> {
    return this.request("GET", `/v1/models${projectId === undefined ? "" : `?projectId=${encodeURIComponent(projectId)}`}`);
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

  /** With `requestId`, the server aborts only that turn and answers 409 when another one is running. */
  abort(sessionId: string, requestId?: string): Promise<void> {
    return this.request("POST", `/v1/sessions/${sessionId}/abort`, requestId === undefined ? undefined : { requestId });
  }

  getSystemPrompt(id: string): Promise<import("../shared/system-prompt.js").SessionSystemPrompt> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}/system-prompt`);
  }

  getSubagents(id: string, runId?: string): Promise<import("../shared/subagents.js").SubagentSnapshot> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}/subagents${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`);
  }

  /** A person's steer for a running child; resolves once its control channel took it, not on delivery. */
  steerSubagent(id: string, runId: string, text: string): Promise<void> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(id)}/subagents/${encodeURIComponent(runId)}/steer`, { text }, "void");
  }

  getSessionSteps(id: string): Promise<import("../shared/session-steps.js").SessionStepsSnapshot> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}/steps`);
  }

  /** Billed tokens of the caller's sessions per model and day, week or month of `timeZone`. */
  /** Runs across every session the caller can see (docs/companion-butler.md §4.2). */
  getActivity(): Promise<import("../shared/activity.js").ActivitySnapshot> {
    return this.request("GET", "/v1/activity");
  }

  getUsage(query: { period: import("../shared/usage-report.js").UsagePeriod; timeZone: string; from?: string; to?: string }): Promise<import("../shared/usage-report.js").UsageReport> {
    const params = new URLSearchParams({ period: query.period, timeZone: query.timeZone });
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    return this.request("GET", `/v1/usage?${params}`);
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

  /** The caller's butler session, or null before the first one; 403 for non-admins, 404 without butlers (docs/companion-butler.md §12). */
  getButler(): Promise<{ session: SessionRecord | null }> {
    return this.request("GET", "/v1/butler");
  }

  /** The caller's butler, made on first use; `reset` starts a new conversation. */
  ensureButler(options: { reset?: boolean } = {}): Promise<{ session: SessionRecord }> {
    return this.request("POST", "/v1/butler", options.reset ? { reset: true } : {});
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
