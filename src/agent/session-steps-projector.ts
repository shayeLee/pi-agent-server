import { randomUUID, createHash } from "node:crypto";
import type { SessionStep, SessionStepsSnapshot } from "../shared/session-steps.js";
import { sanitizeToolValue } from "./session-export.js";
import { notificationFromEntry } from "./subagent-notification.js";
import { EXPORT_IMAGE_BUDGET, createExportImageProjectionState, projectExportImagesForMessage } from "./image-input.js";

type Row = Record<string, any>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const providerSignatureKeys = new Set(["thinkingSignature", "textSignature", "thoughtSignature"]);
function safe(value: unknown): unknown {
  const projected = sanitizeToolValue(value);
  // Explicit SDK fields may occur in nestedCalls. A generic "signature" is
  // opaque provider data only at a content-block boundary, not in tool payloads.
  const work: { value: unknown; block?: boolean }[] = [{ value: projected }];
  while (work.length) {
    const { value: current, block } = work.pop()!;
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (providerSignatureKeys.has(key) || (block && key === "signature")) delete (current as Row)[key];
      else if (key === "content" && Array.isArray(child)) {
        for (const item of child) work.push({ value: item, block: typeof record(item).type === "string" });
      } else if (child && typeof child === "object") work.push({ value: child });
    }
  }
  return projected;
}
function body(content: unknown): unknown {
  if (!Array.isArray(content)) return safe(content);
  return content.map(value => {
    const block = record(value);
    if (block.type === "thinking") return { type: "thinking", thinking: typeof block.thinking === "string" ? block.thinking : "", ...(block.redacted === true ? { redacted: true } : {}) };
    if (block.type === "text") return { type: "text", text: safe(block.text) };
    if (block.type === "toolCall") return { type: "toolCall", id: block.id, name: block.name, arguments: safe(block.arguments) };
    // Opaque provider signatures are never public, even on unknown blocks.
    return safe(Object.fromEntries(Object.entries(block).filter(([key]) => key !== "signature" && !providerSignatureKeys.has(key))));
  });
}
function result(message: Row): unknown {
  return { content: body(message.content), ...(message.details !== undefined ? { details: safe(message.details) } : {}),
    ...(message.nestedCalls !== undefined ? { nestedCalls: safe(message.nestedCalls) } : {}) };
}
function applyImageBudget(steps: SessionStep[]): SessionStep[] {
  let total = 0;
  return steps.map(step => {
    if (!step.images) return step;
    const images = step.images.filter(image => {
      if (total + image.base64.length > EXPORT_IMAGE_BUDGET.maxTotalBase64Length) return false;
      total += image.base64.length; return true;
    });
    return images.length === step.images.length ? step : { ...step, images, omission: "Images omitted by existing export safety budget" };
  });
}
function projectMessage(message: Row, prefix: string, status: SessionStep["status"]): SessionStep[] {
  const base = { source: "observed" as const, status };
  const metadata = { ...(typeof message.parentToolCallId === "string" ? { parentToolCallId: message.parentToolCallId } : {}) };
  if (message.role === "custom" && message.display !== true) return [];
  if (message.role === "assistant") {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const steps: SessionStep[] = blocks.map((value: unknown, index: number) => {
      const block = record(value);
      const step: SessionStep = { ...base, ...metadata, id: `${prefix}:${index}`, kind: "custom", content: body([value]), label: typeof block.type === "string" ? block.type : "unknown_content", omission: "Unknown content represented safely" };
      if (block.type === "text") { step.kind = "assistant_text"; step.content = safe(block.text); delete step.omission; delete step.label; }
      if (block.type === "thinking") {
        step.kind = "thinking"; step.content = typeof block.thinking === "string" ? block.thinking : "";
        const omitted = Object.keys(block).some(key => key === "signature" || providerSignatureKeys.has(key));
        const reasons = [...(block.redacted === true ? ["Thinking redacted by source"] : []), ...(omitted ? ["Provider signature omitted"] : [])];
        if (reasons.length) step.omission = reasons.join("; "); else delete step.omission;
        delete step.label;
      }
      if (block.type === "toolCall") { step.kind = "tool_call"; step.content = safe(block.arguments); step.toolName = block.name; step.toolCallId = block.id; if (typeof block.parentToolCallId === "string") step.parentToolCallId = block.parentToolCallId; delete step.omission; delete step.label; }
      return step;
    });
    if (message.stopReason === "error" || message.stopReason === "aborted") steps.push({ ...base, id: `${prefix}:terminal`, kind: "error", content: safe(message.errorMessage ?? ""), status: message.stopReason, label: message.stopReason });
    if (!steps.length) steps.push({ ...base, id: `${prefix}:empty`, kind: "assistant_text", content: "", omission: "Source has no visible content blocks" });
    return steps;
  }
  if (message.role === "toolResult") return [{ ...base, ...metadata, id: prefix, kind: "tool_result", content: result(message), toolName: message.toolName, toolCallId: message.toolCallId, status: message.isError ? "error" : "completed" }];
  const images = message.role === "user" || message.role === "custom" ? projectExportImagesForMessage(message.content, createExportImageProjectionState()) : [];
  const known = ["user", "custom", "bashExecution", "system", "branchSummary", "compactionSummary"].includes(message.role);
  return [{ ...base, ...metadata, id: prefix, kind: message.role === "user" ? "user" : message.role === "compactionSummary" ? "compaction" : message.role === "custom" ? "custom" : "system_event",
    content: message.role === "user" || message.role === "custom" ? body(message.content) : message.role === "bashExecution" ? safe({ command: message.command, output: message.output, exitCode: message.exitCode, cancelled: message.cancelled, truncated: message.truncated }) : message.role === "system" ? safe({ content: body(message.content), sections: message.sections, toolsAdded: message.toolsAdded, toolsRemoved: message.toolsRemoved }) : message.summary !== undefined ? safe(message.summary) : body(message.content),
    ...(message.role !== "user" ? { label: message.customType ?? message.role ?? "unknown_message" } : {}), ...(images.length ? { images: images.map(image => ({ ...image })) } : {}), ...(!known ? { omission: "Unknown message role; only safe content is shown" } : message.role === "bashExecution" && message.truncated === true ? { omission: "Source output is truncated; fullOutputPath is not read" } : Array.isArray(message.content) && message.content.some((block: unknown) => record(block).type === "image") ? { omission: "Image binary omitted from content; only validated images are attached" } : {}) }];
}
function projectEntry(entry: Row, targets: ReadonlyMap<string, Row>): SessionStep[] {
  const notification = notificationFromEntry(entry);
  let steps: SessionStep[];
  if (notification) steps = [{ id: `entry:${entry.id}`, kind: "notification", content: safe(notification), status: "completed", source: "recorded" }];
  else if (entry.type === "context_edit") {
    const target = targets.get(entry.targetId);
    const message = target?.type === "message" ? record(target.message) : target?.type === "custom_message" ? { ...target, role: "custom" } : undefined;
    // Content edits cannot override the target's role or display policy. Fail closed
    // for internal extension entries, missing targets, and unknown message roles.
    if (!message || !["user", "assistant", "toolResult", "custom"].includes(message.role) || (message.role === "custom" && message.display !== true)) return [];
    steps = [{ id: `entry:${entry.id}`, kind: "system_event", label: "context_edit", content: {
      targetId: entry.targetId, replacement: entry.replacement === null ? null : { content: body(record(entry.replacement).content) },
    }, status: "completed", source: "recorded" }];
  } else if (entry.type === "custom") {
    // Only this existing public lifecycle marker is allowlisted. Extension state stays private.
    if (entry.customType !== "model-failback") return [];
    const data = record(entry.data);
    steps = [{ id: `entry:${entry.id}`, kind: "system_event", label: "model_failback", content: safe({ from: data.from, to: data.to, reason: data.reason }), status: "completed", source: "recorded" }];
  } else if (entry.type === "message") {
    const message = record(entry.message);
    steps = projectMessage(message, `entry:${entry.id}`, message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "completed");
  }
  else if (entry.type === "custom_message") steps = projectMessage({ ...entry, role: "custom" }, `entry:${entry.id}`, "completed");
  else if (["compaction", "branch_summary"].includes(entry.type)) steps = [{ id: `entry:${entry.id}`, kind: entry.type === "compaction" ? "compaction" : "system_event", label: entry.type,
    content: safe({ summary: entry.summary, ...(entry.type === "compaction" ? { tokensBefore: entry.tokensBefore, firstKeptEntryId: entry.firstKeptEntryId } : { fromId: entry.fromId }), ...(entry.fromHook !== undefined ? { fromHook: entry.fromHook } : {}) }),
    status: "completed", source: "recorded", ...(entry.details !== undefined || entry.systemMessage !== undefined ? { omission: "Extension details and system replay checkpoint are not public step content" } : {}) }];
  else if (["session", "usage"].includes(entry.type)) return [];
  else steps = [{ id: `entry:${entry.id}`, kind: "system_event", label: entry.type ?? "unknown_entry", content: safe(Object.fromEntries(Object.entries(entry).filter(([key]) => !["id", "parentId", "timestamp", "data"].includes(key)))), status: "completed", source: "recorded", omission: "Only public entry fields shown; extension state omitted" }];
  return steps.map(step => ({ ...step, source: "recorded", sourceEntryId: entry.id, ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}) }));
}

/** Independent projection: observed completion order is never rebuilt from persisted tool order. */
export class SessionStepsProjector {
  private projectionId = randomUUID();
  private revision = 0;
  private steps: SessionStep[] = [];
  private branchIds: string[] = [];
  private entries = new Set<string>();
  private pending = new Map<object, string[]>();
  private ordinal = 0;
  private active: string | undefined;
  private calls = new Map<string, { scope: string; resultId?: string; parentId?: string; parentScope?: string }>();
  private currentCalls = new Map<string, string>();
  private observedAt = new Map<string, string>();
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  dispose(): void { this.disposed = true; this.pending.clear(); this.listeners.clear(); }
  /** Called whenever the revision or projection identity moves, from any source (event, reconcile or reset). */
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(): void { for (const listener of this.listeners) listener(); }
  /** Current position without copying the steps. */
  position(): { projectionId: string; revision: number } { return { projectionId: this.projectionId, revision: this.revision }; }

  constructor(private readonly getBranch: () => readonly unknown[]) { this.reconcile(); }
  private change(next: SessionStep[]): void {
    if (next.length !== this.steps.length || next.some((step, index) =>
      step !== this.steps[index] && JSON.stringify(step) !== JSON.stringify(this.steps[index]))) {
      this.steps = next; this.revision++;
      this.notify();
    }
  }
  reset(): void {
    this.projectionId = randomUUID(); this.steps = []; this.branchIds = []; this.entries.clear(); this.pending.clear(); this.calls.clear(); this.currentCalls.clear(); this.observedAt.clear(); this.active = undefined; this.ordinal = 0; this.revision = 0;
    this.reconcile();
    // An empty branch projects nothing, so reconcile did not signal the new projection identity.
    if (this.revision === 0) this.notify();
  }
  reconcile(): void {
    if (this.disposed) return;
    const branch = this.getBranch().map(record);
    const ids = branch.map(entry => entry.id as string);
    if (this.branchIds.some((id, index) => ids[index] !== id)) { this.reset(); return; }
    let next = [...this.steps];
    const targets = new Map<string, Row>();
    for (const entry of branch) {
      targets.set(entry.id, entry);
      if (this.entries.has(entry.id)) continue;
      const pendingIds = this.pending.get(entry.message);
      if (pendingIds) {
        const selected = new Set(pendingIds);
        next = next.map(step => selected.has(step.id) ? { ...step, sourceEntryId: entry.id } : step);
        this.pending.delete(entry.message);
      } else {
        next.push(...projectEntry(entry, targets));
      }
      this.entries.add(entry.id);
    }
    this.branchIds = ids;
    this.change(next);
  }
  observe(event: unknown): void {
    this.reconcile();
    const e = record(event), message = record(e.message);
    if (["message_start", "message_update", "message_end"].includes(e.type)) {
      // SDK transforms custom messages into custom_message entries (no final-message ref).
      // They are non-streaming: publish their recorded branch entry, never guess by text.
      if (message.role === "custom") {
        if (e.type === "message_end") queueMicrotask(() => this.reconcile());
        return;
      }
      if (message.role === "toolResult") {
        const owner = this.calls.get(this.callKey(message.toolCallId, message.parentToolCallId));
        if (owner?.resultId) {
          const projected = projectMessage(message, owner.resultId, "completed")[0]!;
          this.change(this.steps.map(step => step.id === owner.resultId ? {
            ...step, ...projected, timestamp: step.timestamp, sourceEntryId: step.sourceEntryId,
            ...(projected.parentToolCallId === undefined && step.parentToolCallId !== undefined ? { parentToolCallId: step.parentToolCallId } : {}),
          } : step));
          if (e.type === "message_end") this.pending.set(e.message, [owner.resultId]);
        } else if (e.type === "message_end") {
          const prefix = `observed:${++this.ordinal}`;
          this.change([...this.steps, ...this.stamp(projectMessage(message, prefix, "completed"))]);
          this.pending.set(e.message, [prefix]);
        }
      } else {
        if (e.type === "message_start" || !this.active) this.active = `observed:${++this.ordinal}`;
        const prefix = this.active;
        const projected = this.stamp(projectMessage(message, prefix, e.type === "message_end" ? message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed" : "streaming"));
        const existing = new Map(this.steps.map(step => [step.id, step]));
        for (const step of projected) {
          if (step.kind === "tool_call" && step.toolCallId) {
            const owner = this.calls.get(step.toolCallId);
            if (!owner || owner.scope !== prefix) this.calls.set(step.toolCallId, { scope: prefix });
            this.currentCalls.set(step.toolCallId, step.toolCallId);
          }
          existing.set(step.id, step);
        }
        // Remove the initial empty placeholder once real blocks arrive.
        if (!projected.some(step => step.id === `${prefix}:empty`)) existing.delete(`${prefix}:empty`);
        if (e.type === "message_end" && message.role === "assistant") {
          // Replace only this assistant's blocks at their original position. Tool
          // results sharing its scope are independent observed completions.
          const isBlock = (step: SessionStep) => step.id.startsWith(`${prefix}:`) && step.kind !== "tool_result";
          const first = this.steps.findIndex(isBlock);
          const next = this.steps.filter(step => !isBlock(step));
          next.splice(first < 0 ? next.length : first, 0, ...projected);
          this.change(next);
          this.pending.set(e.message, projected.map(step => step.id)); this.active = undefined;
        } else {
          this.change([...existing.values()]);
          if (e.type === "message_end") {
            this.pending.set(e.message, projected.map(step => step.id)); this.active = undefined;
          }
        }
      }
      if (e.type === "message_end") queueMicrotask(() => this.reconcile());
    } else if (e.type === "tool_execution_start") {
      const key = this.callKey(e.toolCallId, e.parentToolCallId, true);
      if (!this.calls.has(key) || this.calls.get(key)?.resultId) {
        const scope = `execution:${++this.ordinal}`;
        const parentKey = this.currentCalls.get(e.parentToolCallId);
        this.calls.set(key, { scope, parentId: e.parentToolCallId, parentScope: parentKey === undefined ? undefined : this.calls.get(parentKey)?.scope });
        this.change([...this.steps, ...this.stamp([{ id: `${scope}:call:${e.toolCallId}`, kind: "tool_call", content: safe(e.args), source: "observed", status: "completed", toolName: e.toolName, toolCallId: e.toolCallId, ...(typeof e.parentToolCallId === "string" ? { parentToolCallId: e.parentToolCallId } : {}) }])]);
      }
      this.currentCalls.set(e.toolCallId, key);
    } else if (e.type === "tool_execution_end") {
      const key = this.callKey(e.toolCallId, e.parentToolCallId);
      let owner = this.calls.get(key);
      if (!owner) { owner = { scope: `orphan:${++this.ordinal}`, parentId: e.parentToolCallId }; this.calls.set(key, owner); }
      this.currentCalls.set(e.toolCallId, key);
      if (owner.resultId) return;
      const id = `${owner.scope}:result:${e.toolCallId}`;
      owner.resultId = id;
      const r = record(e.result);
      this.change([...this.steps, ...this.stamp([{ id, kind: "tool_result", content: e.result !== null && typeof e.result === "object" ? result(r) : safe(e.result), source: "observed", status: e.isError ? "error" : "completed", toolName: e.toolName, toolCallId: e.toolCallId, ...(typeof e.parentToolCallId === "string" ? { parentToolCallId: e.parentToolCallId } : {}) }])]);
    } else if (["compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end"].includes(e.type)) {
      const { type, reason, result: output, aborted, willRetry, errorMessage, attempt, maxAttempts, success } = e;
      this.change([...this.steps, ...this.stamp([{ id: `lifecycle:${++this.ordinal}`, kind: errorMessage !== undefined ? "error" : "system_event", label: type, content: safe({ reason, result: output, aborted, willRetry, errorMessage, attempt, maxAttempts, success }), source: "observed", status: aborted ? "aborted" : errorMessage !== undefined ? "error" : "completed" }])]);
    }
  }
  private currentParent(id: string, seen = new Set<string>()): { scope: string } | undefined {
    if (seen.has(id)) return undefined;
    seen.add(id);
    const key = this.currentCalls.get(id);
    const owner = key === undefined ? undefined : this.calls.get(key);
    if (!owner || owner.resultId) return undefined;
    if (owner.parentId !== undefined && owner.parentScope !== undefined && this.currentParent(owner.parentId, seen)?.scope !== owner.parentScope) return undefined;
    return owner;
  }
  private callKey(id: string, parentId?: string, starting = false): string {
    if (typeof parentId !== "string") return id;
    // SDK assigns <parent id>/<n>, recursively, per actual invocation. Resolve
    // nested parents through the current index rather than the raw-id root map.
    const parent = this.currentParent(parentId);
    if (parent) return JSON.stringify([parent.scope, parentId, id]);
    const root = this.calls.get(id);
    if (root?.scope.startsWith("observed:") && (!starting || !root.resultId)) return id;
    const currentKey = this.currentCalls.get(id);
    const current = currentKey === undefined ? undefined : this.calls.get(currentKey);
    if (!starting && current?.parentId === parentId) return currentKey!;
    // Missing/completed parents cannot bind a new start to historical children.
    return JSON.stringify([`unobserved-parent:${++this.ordinal}`, parentId, id]);
  }
  private stamp(steps: SessionStep[]): SessionStep[] {
    return steps.map(step => {
      if (!this.observedAt.has(step.id)) this.observedAt.set(step.id, new Date().toISOString());
      return { ...step, timestamp: this.observedAt.get(step.id)! };
    });
  }
  snapshot(sessionId: string): SessionStepsSnapshot {
    this.reconcile();
    return structuredClone({ sessionId, projectionId: this.projectionId, revision: this.revision, steps: applyImageBudget(this.steps) });
  }
}

// A cold session clock retains only branch identity and a safe-content fingerprint, not
// transcript bodies. Polls are stable; appends advance revision without resetting UI state.
const coldClocks = new Map<string, { ids: unknown[]; digest: string; projectionId: string; revision: number }>();
export function projectColdSessionSteps(sessionId: string, branch: readonly unknown[]): SessionStepsSnapshot {
  const targets = new Map<string, Row>();
  const steps = applyImageBudget(branch.flatMap(value => {
    const entry = record(value);
    targets.set(entry.id, entry);
    return projectEntry(entry, targets);
  }));
  const ids = branch.map(entry => record(entry).id);
  const digest = createHash("sha256").update(JSON.stringify(steps)).digest("hex");
  const previous = coldClocks.get(sessionId);
  const sameGeneration = previous && previous.ids.every((id, index) => ids[index] === id);
  const clock = { ids, digest, projectionId: sameGeneration ? previous.projectionId : `recorded:${randomUUID()}`,
    revision: sameGeneration ? previous.revision + (previous.digest === digest ? 0 : 1) : 1 };
  coldClocks.set(sessionId, clock);
  return { sessionId, projectionId: clock.projectionId, revision: clock.revision, steps };
}
