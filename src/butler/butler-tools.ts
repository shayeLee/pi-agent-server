// The butler's read-only tools (docs/companion-butler.md §12.5). Every tool reads as the butler's
// owner through SessionService, so it sees exactly what that person sees in the Web UI, and returns
// titles, states and short excerpts only: no thinking, raw tool output or images.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionService } from "../application/session-service.js";
import type { ActivityService } from "../application/activity-service.js";
import type { UsagePeriod } from "../shared/usage-report.js";
import type { SessionStep } from "../shared/session-steps.js";

export const BUTLER_TOOL_NAMES = [
  "butler_list_projects",
  "butler_list_sessions",
  "butler_recent_runs",
  "butler_usage",
  "butler_session_brief",
  "butler_subagents",
] as const;

export const BUTLER_LIMITS = {
  /** Characters of one tool result. */
  result: 6000,
  /** Characters of one message excerpt. */
  excerpt: 400,
  defaultRows: 20,
  maxRows: 50,
  defaultSteps: 8,
  maxSteps: 20,
  /** Tool calls per butler session within `windowMs`; a loop stops here. */
  calls: 30,
  windowMs: 5 * 60_000,
} as const;

export type ButlerToolAccess = {
  readonly sessions: SessionService;
  readonly activity: ActivityService;
  /** Time zone for usage days; the server's own by default. */
  readonly timeZone?: string;
};

type Params = Record<string, unknown>;

const schema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required, additionalProperties: false }) as unknown as ToolDefinition["parameters"];

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
const link = (projectId: string, sessionId: string) => `/p/${encodeURIComponent(projectId)}/s/${encodeURIComponent(sessionId)}`;
const iso = (ms: number) => new Date(ms).toISOString();
const rows = (value: unknown, fallback: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;

class ButlerToolError extends Error {}

function reply(value: unknown) {
  const text = JSON.stringify(value);
  return { content: [{ type: "text" as const, text: text.length > BUTLER_LIMITS.result ? `${text.slice(0, BUTLER_LIMITS.result)}…（结果太长，已截断）` : text }], details: undefined };
}

/** The visible text of a step's content: plain text, or the text blocks of a message. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(block => block && typeof block === "object" && (block as { type?: unknown }).type === "text"
      ? String((block as { text?: unknown }).text ?? "") : "").filter(Boolean).join("\n");
  }
  return "";
}

/** One step as the butler may report it; thinking, tool results and images are left out. */
function briefStep(step: SessionStep): Record<string, unknown> | null {
  const at = step.timestamp ? { at: step.timestamp } : {};
  switch (step.kind) {
    case "user": return { role: "user", text: clip(textOf(step.content), BUTLER_LIMITS.excerpt), ...at };
    case "assistant_text": {
      const text = textOf(step.content);
      return text ? { role: "assistant", text: clip(text, BUTLER_LIMITS.excerpt), ...at } : null;
    }
    case "tool_call": return { role: "tool", tool: step.toolName ?? "unknown", status: step.status, ...at };
    case "error": return { role: "error", text: clip(textOf(step.content), BUTLER_LIMITS.excerpt), ...at };
    default: return null;
  }
}

/** The butler's tools for one owner. `access` is read when a tool runs, so it may be bound after startup. */
export function createButlerTools(access: () => ButlerToolAccess | undefined, ownerKey: string): ToolDefinition[] {
  const calls: number[] = [];
  const run = (name: string, description: string, parameters: ToolDefinition["parameters"],
    execute: (params: Params, service: ButlerToolAccess) => Promise<unknown>): ToolDefinition => ({
    name, label: name, description, parameters,
    async execute(_toolCallId, params) {
      const now = Date.now();
      while (calls.length > 0 && now - calls[0]! > BUTLER_LIMITS.windowMs) calls.shift();
      if (calls.length >= BUTLER_LIMITS.calls) return reply({ error: "查询太频繁了，先根据已有结果回答" });
      calls.push(now);
      const service = access();
      if (!service) return reply({ error: "服务还没准备好，稍后再试" });
      try {
        return reply(await execute((params ?? {}) as Params, service));
      } catch (error) {
        // Only messages written here reach the model; anything else is a fixed line.
        return reply({ error: error instanceof ButlerToolError ? error.message : "查询失败" });
      }
    },
  });

  const ownSession = async (service: ButlerToolAccess, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) throw new ButlerToolError("需要 sessionId");
    const found = (await service.sessions.listForButler(ownerKey)).sessions.find(session => session.id === sessionId);
    if (!found) throw new ButlerToolError("看不到这个会话：不存在，或者不是主人的");
    return found;
  };

  return [
    run("butler_list_projects", "列出主人能看到的项目：id、名字、会话数。", schema({}), async (_params, service) => {
      const { projects, sessions } = await service.sessions.listForButler(ownerKey);
      return { projects: projects.map(project => ({
        id: project.id, name: project.name, isDefault: project.isDefault,
        sessions: sessions.filter(session => session.projectId === project.id).length,
      })) };
    }),

    run("butler_list_sessions", "列出主人的会话，最近更新的在前：标题、所在项目、更新时间、是否正在跑、链接。可按项目筛选。",
      schema({
        projectId: { type: "string", description: "只看这个项目" },
        limit: { type: "integer", minimum: 1, maximum: BUTLER_LIMITS.maxRows },
      }), async (params, service) => {
        const [{ projects, sessions }, snapshot] = await Promise.all([service.sessions.listForButler(ownerKey), service.activity.snapshot(ownerKey)]);
        const running = new Set(snapshot.running.map(run => run.sessionId));
        const names = new Map(projects.map(project => [project.id, project.name]));
        const picked = sessions
          .filter(session => typeof params.projectId !== "string" || session.projectId === params.projectId)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        const limit = rows(params.limit, BUTLER_LIMITS.defaultRows, BUTLER_LIMITS.maxRows);
        return {
          total: picked.length,
          sessions: picked.slice(0, limit).map(session => ({
            id: session.id, title: clip(session.title || (session as { firstPrompt?: string | null }).firstPrompt || "未命名会话", 80),
            project: names.get(session.projectId) ?? session.projectId, updatedAt: iso(session.updatedAt),
            running: running.has(session.id), link: link(session.projectId, session.id),
          })),
        };
      }),

    run("butler_recent_runs", "正在跑的会话和最近结束的运行（完成、失败、中止），只记得本次服务启动后、24 小时以内的。",
      schema({ limit: { type: "integer", minimum: 1, maximum: BUTLER_LIMITS.maxRows } }), async (params, service) => {
        const snapshot = await service.activity.snapshot(ownerKey);
        const since = Date.now() - 24 * 3600_000;
        const limit = rows(params.limit, BUTLER_LIMITS.defaultRows, BUTLER_LIMITS.maxRows);
        return {
          running: snapshot.running.slice(0, limit).map(run => ({ title: run.title || "未命名会话", startedAt: iso(run.startedAt), link: link(run.projectId, run.sessionId) })),
          recent: snapshot.recent.filter(event => event.at >= since).slice(0, limit).map(event => ({
            title: event.title || "未命名会话", outcome: event.kind, at: iso(event.at),
            ...("durationMs" in event ? { seconds: Math.round(event.durationMs / 1000) } : {}),
            ...("message" in event && event.message ? { message: clip(event.message, BUTLER_LIMITS.excerpt) } : {}),
            link: link(event.projectId, event.sessionId),
          })),
          note: "更早的运行这里没有记录",
        };
      }),

    run("butler_usage", "主人的用量：按天、周或月统计的 token 与估算花费，分模型；含管家自己的花费。",
      schema({
        period: { enum: ["day", "week", "month"] },
        from: { type: "string", description: "起始日期 YYYY-MM-DD" },
        to: { type: "string", description: "结束日期 YYYY-MM-DD" },
      }), async (params, service) => {
        const period: UsagePeriod = params.period === "week" || params.period === "month" ? params.period : "day";
        const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
        const timeZone = service.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        const report = await service.sessions.usageReport(ownerKey, { period, timeZone, from: date(params.from), to: date(params.to) });
        if (!report) throw new ButlerToolError("日期范围无效或太长");
        const totals = (value: typeof report.totals) => ({ tokens: value.totalTokens, costUsd: Math.round(value.costUsdEstimate * 100) / 100, calls: value.calls });
        return {
          period, timeZone, from: report.from, to: report.to, totals: totals(report.totals),
          ...(report.butler ? { butler: totals(report.butler) } : {}),
          models: report.models.slice(0, 10).map(model => ({ model: `${model.provider}/${model.model}`, ...totals(model) })),
          periods: report.buckets.filter(bucket => bucket.totals.calls > 0).slice(-31).map(bucket => ({ start: bucket.start, ...totals(bucket.totals) })),
          ...(report.unreadSessions > 0 ? { unreadSessions: report.unreadSessions } : {}),
        };
      }),

    run("butler_session_brief", "一个会话最近几步的摘要：用户说了什么、助手答了什么（截断）、调用了哪些工具、出了什么错。不含思考和工具输出。",
      schema({
        sessionId: { type: "string" },
        steps: { type: "integer", minimum: 1, maximum: BUTLER_LIMITS.maxSteps },
      }, ["sessionId"]), async (params, service) => {
        const session = await ownSession(service, params.sessionId);
        const snapshot = await service.sessions.getSessionSteps(ownerKey, session.id);
        if (!snapshot) throw new ButlerToolError("读不到这个会话的记录");
        const brief = snapshot.steps.map(briefStep).filter(step => step !== null);
        const limit = rows(params.steps, BUTLER_LIMITS.defaultSteps, BUTLER_LIMITS.maxSteps);
        return { title: session.title || "未命名会话", link: link(session.projectId, session.id), steps: brief.slice(-limit), totalSteps: brief.length };
      }),

    run("butler_subagents", "一个会话派出的子代理：做什么、状态、开始和结束时间。",
      schema({ sessionId: { type: "string" } }, ["sessionId"]), async (params, service) => {
        const session = await ownSession(service, params.sessionId);
        const snapshot = await service.sessions.getSubagents(ownerKey, session.id);
        if (!snapshot) throw new ButlerToolError("读不到这个会话的子代理");
        return {
          title: session.title || "未命名会话", link: link(session.projectId, session.id),
          subagents: snapshot.runs.slice(-BUTLER_LIMITS.maxRows).map(run => ({
            agent: run.agent, task: clip(run.task, BUTLER_LIMITS.excerpt), status: run.status, startedAt: iso(run.startedAt),
            ...(run.endedAt ? { endedAt: iso(run.endedAt) } : {}),
          })),
        };
      }),
  ];
}
