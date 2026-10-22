import { projectSubagents } from "./subagent-transcript.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ConversationDescriptor, ConversationReadContext, ConversationStorage } from "../application/ports/conversation-port.js";
import type { NativeSessionIndexPort } from "../application/native-session-service.js";
import { NativeSessionSource } from "./native-session-source.js";
import { NativeSessionFd, nativeEntries } from "./native-session-fd.js";
import { projectColdSessionSteps } from "./session-steps-projector.js";
import { projectExportSnapshot } from "./session-export.js";
import { projectExecutionSnapshot } from "./execution-metrics.js";
import { projectColdUsage } from "./cold-usage-snapshot.js";
import { firstUserPrompt } from "../client/session-title.js";
import { canonicalCwdIdentity } from "../core/native-session-policy.js";

export const NATIVE_METADATA_MAX_BYTES = 256 * 1024;
export const NATIVE_METADATA_TAIL_BYTES = 128 * 1024;
const METADATA_CACHE_MAX = 128;
const METADATA_NEGATIVE_TTL_MS = 2000;

// A tail name is authoritative only when all subsequent complete records were
// inspected. A missing name in a partial suffix is unknown, not known-empty.
function tailTitle(bytes: Buffer, partial: boolean): { title: string | null; known: boolean } {
  if (!bytes.length || bytes.at(-1) !== 10) return { title: null, known: false };
  const start = partial ? bytes.indexOf(10) + 1 : 0;
  if (partial && start === 0) return { title: null, known: false };
  try {
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start)).split("\n");
    lines.pop();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.trim()) continue;
      const entry = JSON.parse(lines[i]!);
      if (!entry || typeof entry.id !== "string" || (entry.type !== "session" && !(entry.parentId === null || typeof entry.parentId === "string"))) return { title: null, known: false };
      if (entry.type === "session_info") {
        if (typeof entry.name !== "string") return { title: null, known: false };
        return { title: entry.name.trim().slice(0, 512) || null, known: true };
      }
    }
    return { title: null, known: !partial };
  } catch { return { title: null, known: false }; }
}

function prefixPrompt(bytes: Buffer): string | null {
  // Only complete records, no SDK migration/history projection or invented
  // attachment/custom-message text. The first actual user counts even if empty.
  const end = bytes.lastIndexOf(10);
  if (end < 0) return null;
  try {
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)).split("\n");
    for (let i = 0; i < Math.min(lines.length, 1024); i++) {
      if (!lines[i]!.trim()) continue;
      if (Buffer.byteLength(lines[i]!) > 64 * 1024) return null;
      const entry = JSON.parse(lines[i]!);
      if (i === 0) {
        if (entry?.type !== "session" || entry.version !== 3) return null;
      } else if (!entry || typeof entry.id !== "string" || !(entry.parentId === null || typeof entry.parentId === "string")) return null;
      if (entry.type === "message" && entry.message?.role === "user") return firstUserPrompt([entry.message])?.slice(0, 512) ?? null;
    }
  } catch { /* An unavailable prefix is not evidence of an empty history. */ }
  return null;
}

/** Never shares managed allowroot rules or offers a filesystem cleanup plan. */
export class NativePiConversationStorage implements ConversationStorage {
  readonly agentKind = "pi";
  readonly conversationFormat = "pi-native-jsonl-v3";
  private readonly metadataCache = new Map<string, { fingerprint: string; title: string | null; prompt: string | null; expires: number }>();
  constructor(private readonly source: NativeSessionSource, private readonly index: NativeSessionIndexPort) {}

  private async binding(conversation: ConversationDescriptor, context: ConversationReadContext) {
    if (conversation.agentKind !== this.agentKind || conversation.conversationFormat !== this.conversationFormat) throw new Error("unsupported native reference");
    const binding = await this.index.binding(context.sessionId);
    if (!binding || binding.sourcePath !== conversation.conversationRef) throw new Error("native source unavailable");
    return binding;
  }

  async readExport(conversation: ConversationDescriptor, context: ConversationReadContext) {
    const binding = await this.binding(conversation, context);
    const fd = new NativeSessionFd(this.source, binding, false);
    try {
      const manager = SessionManager.inMemory(binding.cwd, undefined, nativeEntries(fd));
      const result = { ...projectExportSnapshot(manager.buildSessionContext().messages as unknown[], manager.getBranch()),
        usageSnapshot: { execution: projectExecutionSnapshot(manager.getEntries()), ...projectColdUsage(manager, context.usage) } };
      fd.check();
      return result;
    } finally { fd.close(); }
  }

  private subagentCache = new Map<string, { fingerprint: string; branch: import("@earendil-works/pi-coding-agent").SessionEntry[] }>();
  async readSubagents(conversation: ConversationDescriptor, context: ConversationReadContext, runId?: string) {
    const binding = await this.binding(conversation, context);
    const fd = new NativeSessionFd(this.source, binding, false);
    try {
      const stat = fd.verifiedMetadata();
      const fingerprint = `${stat.sourceDev}:${stat.sourceIno}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      let cached = this.subagentCache.get(binding.sourcePath);
      if (cached?.fingerprint !== fingerprint) {
        const manager = SessionManager.inMemory(binding.cwd, undefined, nativeEntries(fd));
        // Only retain transcript/custom records and legacy subagent results, not the entire parent history.
        cached = { fingerprint, branch: manager.getBranch().filter(e => (e.type === "custom" && e.customType === "agent-team:transcript") || (e.type === "message" && e.message.role === "toolResult" && ["subagent", "subagent_wait"].includes(e.message.toolName))) };
        if (this.subagentCache.size >= 8) this.subagentCache.delete(this.subagentCache.keys().next().value!);
        this.subagentCache.set(binding.sourcePath, cached);
      }
      fd.check();
      return projectSubagents(context.sessionId, cached.branch, undefined, runId);
    } finally { fd.close(); }
  }

  async readSteps(conversation: ConversationDescriptor, context: ConversationReadContext) {
    const binding = await this.binding(conversation, context);
    const fd = new NativeSessionFd(this.source, binding, false);
    try {
      const manager = SessionManager.inMemory(binding.cwd, undefined, nativeEntries(fd));
      const branch = manager.getBranch();
      fd.check();
      return projectColdSessionSteps(context.sessionId, branch);
    } finally { fd.close(); }
  }

  private async metadata(conversation: ConversationDescriptor, context: ConversationReadContext) {
    const binding = await this.binding(conversation, context);
    this.source.validate(binding);
    const fd = new NativeSessionFd(this.source, binding, false);
    try {
      // Cache identity and both windows belong to the same verified descriptor.
      const stat = fd.verifiedMetadata();
      const fingerprint = `${stat.sourceDev}:${stat.sourceIno}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cached = this.metadataCache.get(binding.sourcePath);
      if (cached?.fingerprint === fingerprint && cached.expires > Date.now()) {
        fd.check();
        return cached;
      }
      const prefix = fd.readRange(0, NATIVE_METADATA_MAX_BYTES);
      // Revalidate the header from this same snapshot: a same-inode edit between
      // source.validate and descriptor open must not adopt a different session.
      const newline = prefix.indexOf(10);
      if (newline < 0) throw new Error("native header unavailable");
      const header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(prefix.subarray(0, newline)));
      const cwd = canonicalCwdIdentity(header.cwd);
      if (header.type !== "session" || header.version !== 3 || header.id !== binding.sourceId ||
          cwd.cwd !== binding.cwd || cwd.dev !== binding.dev || cwd.ino !== binding.ino) throw new Error("native header changed");
      const tailStart = Math.max(0, stat.size - NATIVE_METADATA_TAIL_BYTES);
      const tail = tailStart < prefix.length && stat.size <= prefix.length
        ? prefix : fd.readRange(tailStart, NATIVE_METADATA_TAIL_BYTES);
      const name = tailTitle(tail, tail !== prefix && tailStart > 0);
      const prompt = prefixPrompt(prefix);
      const metadata = { fingerprint, title: name.title, prompt,
        expires: !name.known || prompt === null ? Date.now() + METADATA_NEGATIVE_TTL_MS : Infinity };
      fd.check();
      this.metadataCache.delete(binding.sourcePath);
      if (this.metadataCache.size >= METADATA_CACHE_MAX) this.metadataCache.delete(this.metadataCache.keys().next().value!);
      this.metadataCache.set(binding.sourcePath, metadata);
      return metadata;
    } finally { fd.close(); }
  }

  async readTitle(conversation: ConversationDescriptor, context: ConversationReadContext): Promise<string | null> {
    try { return (await this.metadata(conversation, context)).title; } catch { return null; }
  }
  async readFirstPrompt(conversation: ConversationDescriptor, context: ConversationReadContext): Promise<string | null> {
    try { return (await this.metadata(conversation, context)).prompt; } catch { return null; }
  }
  planCleanup(): null { return null; }
}
