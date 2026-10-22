// The bridge's tools. Every result is JSON text for the model, trimmed so it does not flood the context.
import { randomUUID } from "node:crypto";
import { ApiError, type ApiClient, type Export, type SessionRecord } from "../client/index.js";
import type { BridgeConfig } from "./config.js";
import { ToolInputError, type ToolDefinition } from "./mcp-server.js";
import type { TurnSnapshot, TurnTracker } from "./turns.js";

/** Marks sessions the bridge created, so people can tell them apart in the Web UI. */
export const BRIDGE_TITLE_PREFIX = "[Claude] ";

export const LIMITS = {
  reply: 8000,
  message: 2000,
  toolArgs: 500,
  defaultTail: 6,
  maxTail: 50,
  defaultSessions: 20,
  maxSessions: 100,
} as const;

export type BridgeToolsOptions = {
  api: ApiClient;
  config: BridgeConfig;
  turns: TurnTracker;
  newRequestId?: () => string;
};

export function createBridgeTools({ api, config, turns, newRequestId = () => `claude-bridge-${randomUUID()}` }: BridgeToolsOptions): ToolDefinition[] {
  let access: Promise<{ canRead: boolean; canWrite: boolean }> | null = null;
  const requireWrite = async () => {
    access ??= api.getAccess().catch((error: unknown) => { access = null; throw error; });
    if (!(await access).canWrite) throw new Error(`当前身份在 ${config.label} 上没有写权限，不能建会话或发消息`);
  };

  const projectAllowed = (projectId: string) => config.projects.length === 0 || config.projects.includes(projectId);
  const checkProject = (projectId: string) => {
    if (!projectAllowed(projectId)) throw new ToolInputError(`项目 ${projectId} 不在 PI_BRIDGE_PROJECTS 允许的范围内`);
  };
  const findSession = async (sessionId: string): Promise<SessionRecord> => {
    const session = (await api.listSessions()).find((s) => s.id === sessionId);
    if (!session) throw new ToolInputError(`找不到会话 ${sessionId}，或者当前身份看不到它`);
    checkProject(session.projectId);
    return session;
  };
  const webLink = (session: Pick<SessionRecord, "id" | "projectId">) =>
    config.webUrl ? `${config.webUrl}/p/${encodeURIComponent(session.projectId)}/s/${encodeURIComponent(session.id)}` : undefined;
  const describeTurn = (snapshot: TurnSnapshot) => {
    if (!snapshot.done) {
      return {
        status: snapshot.phase,
        requestId: snapshot.requestId,
        sessionId: snapshot.sessionId,
        ...(snapshot.queuePosition !== undefined ? { queuePosition: snapshot.queuePosition } : {}),
        toolCalls: snapshot.toolCalls,
        ...(snapshot.lastTool ? { lastTool: snapshot.lastTool } : {}),
        elapsedSeconds: Math.round(snapshot.elapsedMs / 1000),
        hint: "这一轮还没结束，Pi 会继续跑。稍后用 pi_wait 接着等，或用 pi_abort 中止。",
      };
    }
    return {
      status: snapshot.status,
      requestId: snapshot.requestId,
      sessionId: snapshot.sessionId,
      ...(snapshot.error ? { error: snapshot.error } : {}),
      reply: snapshot.reply === null ? null : clip(snapshot.reply, LIMITS.reply),
      toolCalls: snapshot.toolCalls,
      elapsedSeconds: Math.round(snapshot.elapsedMs / 1000),
    };
  };

  return [
    {
      name: "pi_list_projects",
      description: `列出 pi-agent-server（${config.label}）上的项目：id、名字、工作目录、能否建会话。`,
      inputSchema: objectSchema({}),
      annotations: { readOnlyHint: true },
      async run() {
        const projects = (await api.listProjects()).filter((p) => projectAllowed(p.id));
        return json(projects.map((p) => ({
          id: p.id, name: p.name, cwd: p.cwd, isDefault: p.isDefault,
          canCreateSession: p.canCreateSession ?? true,
        })));
      },
    },
    {
      name: "pi_list_models",
      description: `列出 pi-agent-server（${config.label}）可用的模型、思考档位和默认模型。模型写成 provider/modelId。`,
      inputSchema: objectSchema({ projectId: { type: "string", description: "按这个项目的设置给出默认档位" } }),
      annotations: { readOnlyHint: true },
      async run(args) {
        const projectId = optionalString(args, "projectId");
        if (projectId !== undefined) checkProject(projectId);
        const models = await api.listModels(projectId);
        return json({
          defaultModel: models.defaultModel ? modelKey(models.defaultModel) : null,
          defaultThinkingLevel: models.defaultThinkingLevel,
          thinkingLevels: models.thinkingLevels,
          models: models.models.map((m) => ({ model: modelKey(m), name: m.name })),
        });
      },
    },
    {
      name: "pi_list_sessions",
      description: `按最近更新列出 pi-agent-server（${config.label}）上的会话。bridgeCreated 表示是桥接建的会话。`,
      inputSchema: objectSchema({
        projectId: { type: "string", description: "只看这个项目" },
        limit: { type: "integer", minimum: 1, maximum: LIMITS.maxSessions, description: `最多几条，默认 ${LIMITS.defaultSessions}` },
      }),
      annotations: { readOnlyHint: true },
      async run(args) {
        const projectId = optionalString(args, "projectId");
        if (projectId !== undefined) checkProject(projectId);
        const limit = optionalInteger(args, "limit", 1, LIMITS.maxSessions) ?? LIMITS.defaultSessions;
        const sessions = projectId === undefined ? await api.listSessions() : await api.listSessionsByProject(projectId);
        return json(sessions
          .filter((s) => projectAllowed(s.projectId))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, limit)
          .map((s) => ({
            id: s.id,
            title: s.title || clip(s.firstPrompt ?? "", 80) || "(未命名)",
            projectId: s.projectId,
            model: s.modelProvider && s.modelId ? `${s.modelProvider}/${s.modelId}` : null,
            updatedAt: new Date(s.updatedAt).toISOString(),
            bridgeCreated: s.title.startsWith(BRIDGE_TITLE_PREFIX),
            ...(s.origin === "native" ? { native: true } : {}),
            ...(webLink(s) ? { webUrl: webLink(s) } : {}),
          })));
      },
    },
    {
      name: "pi_get_session",
      description: "读一个 Pi 会话的记录，只返回最后几条消息；工具调用默认只给名字和状态。",
      inputSchema: objectSchema({
        sessionId: { type: "string" },
        tail: { type: "integer", minimum: 1, maximum: LIMITS.maxTail, description: `返回最后几条消息，默认 ${LIMITS.defaultTail}` },
        includeTools: { type: "boolean", description: "附带工具调用的参数（截断）" },
      }, ["sessionId"]),
      annotations: { readOnlyHint: true },
      async run(args) {
        const session = await findSession(requiredString(args, "sessionId"));
        const tail = optionalInteger(args, "tail", 1, LIMITS.maxTail) ?? LIMITS.defaultTail;
        const exported = await api.exportSession(session.id);
        return json({
          id: session.id,
          title: session.title,
          model: session.modelProvider && session.modelId ? `${session.modelProvider}/${session.modelId}` : null,
          ...(webLink(session) ? { webUrl: webLink(session) } : {}),
          ...transcriptTail(exported, tail, optionalBoolean(args, "includeTools") ?? false),
        });
      },
    },
    {
      name: "pi_create_session",
      description: `在 pi-agent-server（${config.label}）上新建会话，标题前会自动加 "${BRIDGE_TITLE_PREFIX.trim()}"。可以指定模型（provider/modelId）和思考档位。`,
      inputSchema: objectSchema({
        title: { type: "string", description: "会话标题，说清楚委派的是什么" },
        projectId: { type: "string", description: "不填就用默认项目" },
        model: { type: "string", description: "provider/modelId，见 pi_list_models" },
        thinkingLevel: { type: "string", description: "见 pi_list_models 的 thinkingLevels" },
      }, ["title"]),
      async run(args) {
        await requireWrite();
        const title = requiredString(args, "title");
        const projectId = optionalString(args, "projectId");
        if (projectId !== undefined) checkProject(projectId);
        else if (config.projects.length > 0) throw new ToolInputError("PI_BRIDGE_PROJECTS 限定了项目，请指定 projectId");
        const model = optionalString(args, "model");
        const thinkingLevel = optionalString(args, "thinkingLevel");

        let sessionConfig: { modelProvider?: string; modelId?: string; thinkingLevel?: string } | undefined;
        if (model !== undefined || thinkingLevel !== undefined) {
          const models = await api.listModels(projectId);
          sessionConfig = {};
          if (model !== undefined) {
            const found = models.models.find((m) => modelKey(m) === model);
            if (!found) throw new ToolInputError(`没有这个模型：${model}，见 pi_list_models`);
            sessionConfig.modelProvider = found.provider;
            sessionConfig.modelId = found.id;
          }
          if (thinkingLevel !== undefined) {
            if (!models.thinkingLevels.includes(thinkingLevel)) throw new ToolInputError(`思考档位要是 ${models.thinkingLevels.join(" / ")} 之一`);
            sessionConfig.thinkingLevel = thinkingLevel;
          }
        }

        let session = await api.createSession(`${BRIDGE_TITLE_PREFIX}${title}`, projectId, newRequestId());
        if (sessionConfig) session = await api.updateSessionConfig(session.id, sessionConfig);
        return json({
          id: session.id,
          title: session.title,
          projectId: session.projectId,
          model: session.modelProvider && session.modelId ? `${session.modelProvider}/${session.modelId}` : null,
          thinkingLevel: session.thinkingLevel,
          ...(webLink(session) ? { webUrl: webLink(session) } : {}),
        });
      },
    },
    {
      name: "pi_send",
      description: `给 Pi 会话发一条消息。wait 为 true（默认）时最多等 ${Math.round(config.waitMs / 1000)} 秒：跑完了返回最后的回复；没跑完返回 status running 和 requestId，之后用 pi_wait 接着等。重试同一条消息时带上原来的 requestId，避免重复提交。`,
      inputSchema: objectSchema({
        sessionId: { type: "string" },
        prompt: { type: "string" },
        wait: { type: "boolean", description: "默认 true；false 时提交后立刻返回" },
        requestId: { type: "string", description: "重试时填上次返回的 requestId" },
      }, ["sessionId", "prompt"]),
      async run(args, { signal }) {
        await requireWrite();
        const session = await findSession(requiredString(args, "sessionId"));
        const prompt = requiredString(args, "prompt");
        const wait = optionalBoolean(args, "wait") ?? true;
        const requestId = optionalString(args, "requestId") ?? newRequestId();
        await turns.start(session.id, prompt, requestId);
        const snapshot = await turns.wait(requestId, wait ? config.waitMs : 0, signal);
        return json({
          ...describeTurn(snapshot),
          ...(session.title.startsWith(BRIDGE_TITLE_PREFIX) ? {} : { note: "这个会话不是桥接建的，消息会出现在用户自己的会话里" }),
          ...(webLink(session) ? { webUrl: webLink(session) } : {}),
        });
      },
    },
    {
      name: "pi_wait",
      description: `接着等 pi_send 返回 running 的那一轮，最多等 ${Math.round(config.waitMs / 1000)} 秒，返回规则同 pi_send。`,
      inputSchema: objectSchema({ requestId: { type: "string" } }, ["requestId"]),
      annotations: { readOnlyHint: true },
      async run(args, { signal }) {
        const snapshot = await turns.wait(requiredString(args, "requestId"), config.waitMs, signal);
        return json(describeTurn(snapshot));
      },
    },
    {
      name: "pi_steer",
      description: "给正在运行的 Pi 任务补一句引导，它会在下一步开始前读到。",
      inputSchema: objectSchema({ sessionId: { type: "string" }, text: { type: "string" } }, ["sessionId", "text"]),
      async run(args) {
        await requireWrite();
        const session = await findSession(requiredString(args, "sessionId"));
        try {
          await api.steer(session.id, requiredString(args, "text"));
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) throw new Error("这个会话现在没有正在运行的任务，直接用 pi_send 发新消息");
          throw error;
        }
        return json({ status: "sent", sessionId: session.id });
      },
    },
    {
      name: "pi_abort",
      description: "中止 Pi 会话里正在运行的那一轮。只中止 requestId 对应的这一轮，不会误停之后别人发起的任务。",
      inputSchema: objectSchema({ sessionId: { type: "string" }, requestId: { type: "string" } }, ["sessionId", "requestId"]),
      annotations: { destructiveHint: true },
      async run(args) {
        await requireWrite();
        const session = await findSession(requiredString(args, "sessionId"));
        const requestId = requiredString(args, "requestId");
        try {
          await api.abort(session.id, requestId);
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) throw new Error("这个会话当前运行的不是这一轮（可能已经结束），没有中止任何任务");
          throw error;
        }
        return json({ status: "abort_requested", sessionId: session.id, requestId });
      },
    },
  ];
}

/** The last `tail` messages, with the tool calls between them. */
export function transcriptTail(exported: Export, tail: number, includeTools: boolean) {
  type Entry =
    | { role: "user" | "assistant"; text: string; stopReason?: "aborted" }
    | { tool: string; status: string; args?: string; error?: true };
  const entries: Entry[] = [];
  const failed = new Set(exported.timeline.flatMap((item) => (item.type === "tool_result" && item.isError ? [item.toolCallId] : [])));
  for (const item of exported.timeline) {
    if (item.type === "message") {
      entries.push({ role: item.role, text: clip(item.text, LIMITS.message), ...(item.stopReason ? { stopReason: item.stopReason } : {}) });
    } else if (item.type === "tool_call") {
      entries.push({
        tool: item.toolName,
        status: item.status,
        ...(includeTools ? { args: clip(typeof item.args === "string" ? item.args : JSON.stringify(item.args) ?? "", LIMITS.toolArgs) } : {}),
        ...(failed.has(item.toolCallId) ? { error: true as const } : {}),
      });
    }
  }
  let seen = 0;
  let start = entries.length;
  while (start > 0 && seen < tail) {
    start -= 1;
    if ("role" in entries[start]!) seen += 1;
  }
  const totalMessages = entries.filter((e) => "role" in e).length;
  return { totalMessages, omittedMessages: totalMessages - seen, entries: entries.slice(start) };
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断，原文共 ${text.length} 字，完整内容请在 Web UI 查看）`;
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = optionalString(args, name);
  if (value === undefined) throw new ToolInputError(`缺少参数 ${name}`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolInputError(`参数 ${name} 要是字符串`);
  const trimmed = value.trim();
  if (!trimmed) throw new ToolInputError(`参数 ${name} 不能为空`);
  return name === "prompt" || name === "text" ? value : trimmed;
}

function optionalInteger(args: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolInputError(`参数 ${name} 要是 ${min}–${max} 的整数`);
  }
  return value;
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ToolInputError(`参数 ${name} 要是 true 或 false`);
  return value;
}
