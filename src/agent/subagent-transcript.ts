import type { TimelineItem, ToolCall } from "../client/types.js";
import { SUBAGENT_TRANSCRIPT, type SubagentConversation, type SubagentInput, type SubagentRun, type SubagentSnapshot } from "../shared/subagents.js";
import { EMPTY_USAGE_TOKENS, addUsageTokens, usageTokensOf, type SubagentUsage } from "../core/usage-snapshot.js";

type RecordValue = Record<string, any>;
const object = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
type RunState = { run: SubagentRun; messages: Map<string, { message: RecordValue; complete: boolean; order: number }>;
  tools: Map<string, { call: ToolCall; order: number }>; inputs: (SubagentInput & { order?: number })[] };
export type SubagentLive = { active: Set<string>; partials: Map<string, { key: number; message: unknown; revision?: number }> };

/** Custom entries never enter the parent model context. No truncation of durable messages. */
export function projectSubagents(sessionId: string, entries: readonly unknown[], live?: SubagentLive, selected?: string): SubagentSnapshot {
  const runs = new Map<string, RunState>();
  for (const raw of entries) {
    if (!object(raw) || raw.type !== "custom" || raw.customType !== SUBAGENT_TRANSCRIPT || !object(raw.data)) continue;
    const e = raw.data;
    if (e.version !== 1 || typeof e.id !== "string" || !Number.isSafeInteger(e.seq) || !object(e.payload)) continue;
    const p = e.payload;
    if (e.kind === "start" && !runs.has(e.id) && typeof p.agent === "string" && typeof p.task === "string") {
      runs.set(e.id, { run: { id: e.id, runId: String(p.runId), agent: p.agent, task: p.task,
        startedAt: p.startedAt, model: p.model, thinkingLevel: p.thinkingLevel, status: "unknown", revision: 0 }, messages: new Map(), tools: new Map(),
        inputs: [{ id: `${e.id}:initial`, text: p.task, kind: "initial", source: "host", order: e.seq, timestamp: e.timestamp, delivery: "submitted" }] });
    }
    const state = runs.get(e.id);
    if (!state || e.seq <= state.run.revision) continue;
    state.run.revision = e.seq;
    if (e.kind === "message" && object(p.message)) {
      const key = String(p.key), previous = state.messages.get(key);
      state.messages.set(key, { message: p.message, complete: p.complete === true, order: previous?.order ?? e.seq });
    } else if (e.kind === "tool_execution_start" && typeof p.toolCallId === "string") {
      state.tools.set(p.toolCallId, { order: e.seq, call: { toolCallId: p.toolCallId, toolName: String(p.toolName),
        args: p.args, partialResult: null, result: null, done: false, isError: false } });
    } else if (e.kind === "tool_execution_end" && typeof p.toolCallId === "string") {
      const tool = state.tools.get(p.toolCallId) ?? { order: e.seq, call: { toolCallId: p.toolCallId, toolName: String(p.toolName), args: {}, partialResult: null, result: null, done: false, isError: false } };
      Object.assign(tool.call, { done: true, result: p.result, isError: !!p.isError }); state.tools.set(p.toolCallId, tool);
    } else if (e.kind === "input" && typeof p.id === "string" && typeof p.text === "string") {
      state.inputs.push({ id: p.id, text: p.text, kind: "steer", source: p.source === "user" ? "user" : "host", order: e.seq, timestamp: e.timestamp, delivery: "submitted" });
    } else if (e.kind === "input_status") {
      const input = state.inputs.find(i => i.id === p.id);
      if (input && p.delivery === "failed") input.delivery = "failed";
    } else if (e.kind === "configuration" && typeof p.thinkingLevel === "string") {
      state.run.thinkingLevel = p.thinkingLevel;
    } else if (e.kind === "end") {
      state.run.status = ["completed", "failed", "stopped"].includes(p.status) ? p.status : "unknown";
      state.run.endedAt = p.endedAt; state.run.model = p.model ?? state.run.model;
      state.run.thinkingLevel = p.thinkingLevel ?? state.run.thinkingLevel;
    }
  }
  for (const state of runs.values()) {
    if (!state.run.endedAt && live?.active.has(state.run.id)) state.run.status = "running";
    const partial = live?.partials.get(state.run.id);
    if (partial && object(partial.message) && state.run.status === "running") {
      state.run.streamRevision = partial.revision;
      const key = String(partial.key), previous = state.messages.get(key);
      if (!previous?.complete) state.messages.set(key, { message: partial.message, complete: false, order: previous?.order ?? state.run.revision + 1 });
    }
  }
  // Old extensions stored full transcripts only in collected tool results. Recover
  // what actually exists; never invent messages from their summary prose.
  const legacyKeys = new Set<string>();
  for (const raw of entries) {
    if (!object(raw) || raw.type !== "message" || !object(raw.message)) continue;
    const m = raw.message;
    if (m.role !== "toolResult" || !["subagent", "subagent_wait"].includes(m.toolName) || !Array.isArray(m.details?.results)) continue;
    for (const [index, result] of m.details.results.entries()) {
      if (!object(result) || typeof result.agent !== "string" || typeof result.task !== "string" || !Array.isArray(result.messages)) continue;
      const key = JSON.stringify([result.runId, result.startedAt, result.agent, result.task]);
      if (legacyKeys.has(key) || [...runs.values()].some(s => !s.run.legacy && s.run.runId === result.runId && s.run.startedAt === result.startedAt)) continue;
      legacyKeys.add(key);
      const id = `legacy:${raw.id}:${index}`;
      runs.set(id, { run: { id, runId: String(result.runId ?? index + 1), agent: result.agent, task: result.task,
        startedAt: result.startedAt ?? 0, endedAt: result.endedAt, model: result.model, thinkingLevel: result.thinkingLevel, legacy: true, revision: result.messages.length,
        status: result.stopReason === "stopped" ? "stopped" : result.exitCode === 0 ? "completed" : result.exitCode > 0 ? "failed" : "unknown" },
        inputs: [{ id: `${id}:initial`, text: result.task, kind: "initial", source: "host", delivery: "unknown", timestamp: result.startedAt ?? 0 }],
        tools: new Map(), messages: new Map(result.messages.filter(object).map((message: RecordValue, i: number) => [String(i), { message, complete: true, order: i }])) });
    }
  }
  const state = selected ? runs.get(selected) : undefined;
  return { sessionId, runs: [...runs.values()].map(s => s.run), ...(state ? { conversation: conversation(state) } : {}) };
}

/** ISO time recorded on an SDK message, if any; rows without it simply show no time. */
function messageTime(m: RecordValue): { timestamp?: string } {
  return typeof m.timestamp === "number" && Number.isFinite(m.timestamp) && m.timestamp > 0 ? { timestamp: new Date(m.timestamp).toISOString() } : {};
}

function conversation(state: RunState): SubagentConversation {
  const rows: Array<{ order: number; item: TimelineItem }> = [];
  const tools = new Map<string, { call: ToolCall; order: number; timestamp?: string }>(state.tools);
  let userCount = 0;
  for (const [key, { message: m, complete, order }] of state.messages) {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    const text = content.filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("\n");
    if (m.role === "user") {
      const input = userCount++ === 0 ? state.inputs[0] : state.inputs.find(i => i.kind === "steer" && i.delivery === "submitted" && (i.order ?? -1) < order && i.text === text);
      if (input) input.delivery = "delivered";
      rows.push({ order, item: { kind: "message", id: `child:${key}`, role: "user", text, streaming: false, ...messageTime(m),
        images: content.filter((p: any) => p.type === "image" && typeof p.data === "string").map((p: any) => ({ mediaType: p.mimeType, base64: p.data })),
        ...(input?.source === "host" ? { hostInput: input.kind } : input?.kind === "steer" ? { userInput: "steer" as const } : {}),
        sourceLabel: input ? `${input.source === "user" ? "你" : "主代理"} · ${input.kind === "initial" ? "初始任务" : "steer"} · 已送达` : "用户消息" } });
    } else if (m.role === "assistant") {
      content.forEach((p: any, index: number) => {
        const id = `child:${key}:${index}`, position = order + index / (content.length + 1);
        if (p.type === "text" || p.type === "thinking") rows.push({ order: position, item: p.type === "text"
          ? { kind: "message", id, role: "assistant", text: String(p.text ?? ""), streaming: !complete && state.run.status === "running", ...messageTime(m) }
          : { kind: "thinking", id, text: String(p.thinking ?? ""), streaming: !complete && state.run.status === "running", ...messageTime(m) } });
        if (p.type === "toolCall" && typeof p.id === "string") {
          const existing = tools.get(p.id);
          tools.set(p.id, { order: position, ...messageTime(m), call: { toolCallId: p.id, toolName: String(p.name), args: p.arguments,
            partialResult: null, result: null, done: false, isError: false, ...existing?.call } });
        }
      });
      if (typeof m.model === "string") state.run.model = m.provider ? `${m.provider}/${m.model}` : m.model;
    } else if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      const old = tools.get(m.toolCallId);
      tools.set(m.toolCallId, { order: old?.order ?? order, ...(old?.timestamp ? { timestamp: old.timestamp } : messageTime(m)), call: { toolCallId: m.toolCallId, toolName: m.toolName ?? old?.call.toolName ?? "tool",
        args: old?.call.args ?? {}, partialResult: null, result: m, done: true, isError: !!m.isError } });
    }
  }
  for (const [id, { order, call, timestamp }] of tools) {
    if (!call.done && state.run.status !== "running") {
      call.result = { content: [{ type: "text", text: "工具结果未记录；任务已结束或运行状态未知。" }] };
      call.done = true; call.isError = true;
    }
    rows.push({ order, item: { kind: "tool", id: `child-tool:${id}`, call, ...(timestamp ? { timestamp } : {}) } });
  }
  for (const input of state.inputs) if (input.delivery === "submitted" && state.run.status !== "running") input.delivery = "unknown";
  return { run: state.run, timeline: rows.sort((a, b) => a.order - b.order).map(r => r.item), inputs: state.inputs,
    messages: [...state.messages.values()].map(m => m.message) };
}

/**
 * Child model usage on a branch: each completed assistant message counts once (its last stored
 * version). Child runs are separate sessions, so none of this is in the parent's session totals.
 */
export function subagentUsage(entries: readonly unknown[]): SubagentUsage | null {
  const runs = new Set<string>();
  const messages = new Map<string, unknown>();
  for (const raw of entries) {
    if (!object(raw) || raw.type !== "custom" || raw.customType !== SUBAGENT_TRANSCRIPT || !object(raw.data)) continue;
    const e = raw.data;
    if (e.version !== 1 || typeof e.id !== "string" || !object(e.payload)) continue;
    if (e.kind === "start") runs.add(e.id);
    else if (e.kind === "message" && object(e.payload.message)) {
      const key = `${e.id}\u0000${String(e.payload.key)}`;
      if (e.payload.complete === true && e.payload.message.role === "assistant") messages.set(key, e.payload.message.usage);
      else messages.delete(key);
    }
  }
  if (!runs.size) return null;
  let tokens = EMPTY_USAGE_TOKENS;
  for (const usage of messages.values()) tokens = addUsageTokens(tokens, usageTokensOf(usage));
  return { ...tokens, runs: runs.size, calls: messages.size };
}
