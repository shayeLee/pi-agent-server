// pi-agent-server HTTP API 客户端（对应 needs.md §4.2 与知识库能力接口）。
// token 只保存在内存（needs.md §7：不 localStorage 存凭证）。

import type { ModelInfo, Project, SessionRecord } from "../types.js";

export type SendMessageInput = {
  requestId: string;
  prompt: string;
  parentId?: string;
  images?: { mediaType: string; base64: string }[];
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
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    };
    // token 为空时（内网免登录）不带 authorization header
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, `HTTP ${res.status}${text ? `: ${text}` : ""}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  createSession(title?: string, projectId?: string): Promise<SessionRecord> {
    return this.request("POST", "/v1/sessions", { title, projectId });
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

  listModels(): Promise<{
    models: ModelInfo[];
    thinkingLevels: string[];
    defaultModel: ModelInfo | null;
    defaultThinkingLevel: string;
  }> {
    return this.request("GET", "/v1/models");
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

  steer(sessionId: string, text: string): Promise<void> {
    return this.request("POST", `/v1/sessions/${sessionId}/steer`, { text });
  }

  followUp(sessionId: string, text: string): Promise<void> {
    return this.request("POST", `/v1/sessions/${sessionId}/follow-ups`, { text });
  }

  abort(sessionId: string): Promise<void> {
    return this.request("POST", `/v1/sessions/${sessionId}/abort`);
  }

  exportSession(id: string): Promise<unknown> {
    return this.request("GET", `/v1/sessions/${id}/export`);
  }
}
