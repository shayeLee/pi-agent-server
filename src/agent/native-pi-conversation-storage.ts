import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ConversationDescriptor, ConversationReadContext, ConversationStorage } from "../application/ports/conversation-port.js";
import type { NativeSessionIndexPort } from "../application/native-session-service.js";
import { NativeSessionSource, nativePathSnapshot } from "./native-session-source.js";
import { NativeSessionFd, nativeEntries } from "./native-session-fd.js";
import { projectExportSnapshot } from "./session-export.js";
import { projectExecutionSnapshot } from "./execution-metrics.js";
import { firstUserPrompt } from "../client/session-title.js";

export const NATIVE_METADATA_MAX_BYTES = 1024 * 1024;
const METADATA_CACHE_MAX = 128;

/** Never shares managed allowroot rules or offers a filesystem cleanup plan. */
export class NativePiConversationStorage implements ConversationStorage {
  readonly agentKind = "pi";
  readonly conversationFormat = "pi-native-jsonl-v3";
  private readonly metadataCache = new Map<string, { fingerprint: string; title: string | null; prompt: string | null }>();
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
        usageSnapshot: { execution: projectExecutionSnapshot(manager.getEntries()) } };
      fd.check();
      return result;
    } finally { fd.close(); }
  }

  private async metadata(conversation: ConversationDescriptor, context: ConversationReadContext) {
    const binding = await this.binding(conversation, context);
    const candidate = this.source.validate(binding);
    // Stat-only cache key; authorization is still rechecked on every access.
    const stat = nativePathSnapshot(this.source.root, binding.sourcePath).at(-1)!.stat;
    const fingerprint = `${candidate.binding.sourceDev}:${candidate.binding.sourceIno}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = this.metadataCache.get(binding.sourcePath);
    if (cached?.fingerprint === fingerprint) return cached;
    const fd = new NativeSessionFd(this.source, binding, false);
    try {
      // A bounded complete snapshot, never a truncated prefix advertised as latest name.
      const entries = nativeEntries(fd, NATIVE_METADATA_MAX_BYTES);
      let title: string | null = null;
      for (const entry of entries) {
        if (entry.type === "session_info") title = entry.name?.trim().slice(0, 512) || null;
      }
      const messages = entries.flatMap(entry => entry.type === "message" ? [entry.message] : []);
      const metadata = { fingerprint, title, prompt: firstUserPrompt(messages)?.slice(0, 512) ?? null };
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
