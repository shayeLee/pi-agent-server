import { projectSubagents } from "./subagent-transcript.js";
// Pi 专属会话存储：Pi Session 的 JSONL v3 恢复、只读导出、引用清理和 DB-only 引用校验。
// 通用层只通过 ConversationStorage 访问本模块，不解释 conversationRef。

import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, statSync, type Stats } from "node:fs";
import { open, readFile, type FileHandle } from "node:fs/promises";
import { firstUserPrompt } from "../client/session-title.js";
import path from "node:path";
import {
  parseSessionEntries,
  SessionManager,
  type NewSessionOptions,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { projectExecutionSnapshot } from "./execution-metrics.js";
import { projectColdUsage, type ColdUsageOptions } from "./cold-usage-snapshot.js";
import { projectColdSessionSteps } from "./session-steps-projector.js";
import { projectExportSnapshot } from "./session-export.js";
import { readSessionCwdIdentity, type SessionCwdIdentity } from "./session-cwd-identity.js";
import type {
  ConversationCleanupPlan,
  ConversationDescriptor,
  ConversationReadContext,
  ConversationReferenceClassification,
  ConversationReferenceRecord,
  ConversationStorage,
} from "../application/ports/conversation-port.js";
import { PI_AGENT_KIND, PI_CONVERSATION_FORMAT } from "../application/ports/conversation-port.js";
import { artifactDeleteOperationKey, relativeWhitelistedPath } from "../storage/file-operation-policy.js";
import { NativePiConversationStorage } from "./native-pi-conversation-storage.js";
import type { NativeSessionSource } from "./native-session-source.js";
import type { NativeSessionIndexPort } from "../application/native-session-service.js";
import { classifyPiJsonlReference, requirePiDataDir } from "./pi-jsonl-reference.js";
import { usageLedgerFromJsonl, UsageLedgerCache, type UsageLedgerEvent } from "./usage-ledger.js";

interface FileFingerprint {
  readonly exists: boolean;
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string | null;
}

function fileFingerprint(filePath: string): FileFingerprint {
  try {
    const st = statSync(filePath);
    let sha256: string | null = null;
    if (st.isFile()) sha256 = createHash("sha256").update(readFileSync(filePath)).digest("hex");
    return {
      exists: true,
      dev: st.dev,
      ino: st.ino,
      nlink: st.nlink,
      mode: st.mode,
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256,
    };
  } catch {
    return { exists: false, dev: 0, ino: 0, nlink: 0, mode: 0, size: 0, mtimeMs: 0, sha256: null };
  }
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 严格校验当前 Pi JSONL v3 的 header、id、parentId 树，不做迁移或宽容跳过。 */
export function assertCurrentPiJsonl(content: string): void {
  if (content.trim().length === 0) return;
  let headerChecked = false;
  let entryCount = 0;
  const ids = new Set<string>();
  const parents = new Map<string, string | null>();
  const records: Array<{ type?: unknown; version?: unknown; id?: unknown; parentId?: unknown }> = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let entry: { type?: unknown; version?: unknown; id?: unknown; parentId?: unknown };
    try {
      entry = JSON.parse(trimmed) as { type?: unknown; version?: unknown; id?: unknown };
    } catch {
      throw new Error("session history contains a malformed line");
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("session history contains a malformed entry");
    }
    entryCount++;
    records.push(entry);
    if (typeof entry.id !== "string" || entry.id.length === 0 || ids.has(entry.id)) {
      throw new Error("session history is not Pi JSONL v3");
    }
    ids.add(entry.id);
    if (!headerChecked) {
      headerChecked = true;
      if (entry.type !== "session" || entry.version !== 3) {
        throw new Error("session history is not Pi JSONL v3");
      }
    } else {
      if (!(entry.parentId === null || typeof entry.parentId === "string")) {
        throw new Error("session history is not Pi JSONL v3");
      }
      if (entry.parentId === entry.id) throw new Error("session history is not Pi JSONL v3");
      parents.set(entry.id, entry.parentId);
    }
  }
  if (!headerChecked || entryCount === 0 || records.filter((record) => record.type === "session").length !== 1) {
    throw new Error("session history is not Pi JSONL v3");
  }
  for (const parent of parents.values()) {
    if (parent !== null && !ids.has(parent)) throw new Error("session history is not Pi JSONL v3");
  }
  for (const id of parents.keys()) {
    const seen = new Set<string>();
    let current: string | null | undefined = id;
    while (current !== null && current !== undefined) {
      if (seen.has(current)) throw new Error("session history is not Pi JSONL v3");
      seen.add(current);
      current = parents.get(current);
    }
  }
}

/** Read the creation-time canonical root from an immutable Pi transcript; malformed/legacy data is unavailable. */
export function readPiSessionCwdIdentity(file: string): SessionCwdIdentity | null {
  try {
    const content = readFileSync(file, "utf8");
    assertOpenablePiJsonl(content);
    return readSessionCwdIdentity(parseSessionEntries(content) as SessionEntry[]);
  } catch {
    return null;
  }
}

function assertOpenablePiJsonl(content: string): void {
  if (content.trim().length === 0) throw new Error("session history is empty");
  assertCurrentPiJsonl(content);
  if (!content.endsWith("\n")) throw new Error("session history is not Pi JSONL v3");
}

function buildPersistedSessionManager(file: string, entries: SessionEntry[]): SessionManager {
  const header = entries[0] as SessionHeader | undefined;
  const cwd = typeof header?.cwd === "string" ? header.cwd : process.cwd();
  const sessionDir = path.dirname(file);
  // SessionManager 的构造函数是 private；使用 SDK open 的同一内部参数形态，
  // 但注入已校验的内存 entries，避免把可替换的原路径交给 SDK 的隐式迁移路径。
  const SessionManagerCtor = SessionManager as unknown as new (
    cwd: string,
    sessionDir: string,
    sessionFile: string | undefined,
    persist: boolean,
    newSessionOptions: NewSessionOptions | undefined,
    preloadedFileEntries?: SessionEntry[],
  ) => SessionManager;
  return new SessionManagerCtor(cwd, sessionDir, file, true, undefined, entries);
}

/** 只读校验后恢复可追加的 Pi SessionManager；打开过程发生任何文件变化都 fail-closed。 */
export function openPiRuntimeSessionFile(
  file: string,
  options?: { readonly onContentValidated?: (content: string) => void },
): SessionManager {
  const before = fileFingerprint(file);
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    throw new Error("session history is unavailable");
  }
  assertOpenablePiJsonl(content);
  const entries = parseSessionEntries(content) as SessionEntry[];
  if (entries.length === 0) throw new Error("session history is not Pi JSONL v3");
  options?.onContentValidated?.(content);
  const manager = buildPersistedSessionManager(file, entries);
  if (!sameFingerprint(before, fileFingerprint(file))) {
    throw new Error("会话文件在打开期间被修改（拒绝 SDK 隐式迁移/重写）");
  }
  return manager;
}

/** 只读解析 Pi JSONL，返回与活 AgentAdapter 相同的导出投影。 */
export async function readPiJsonlExport(conversationRef: string | null, usage?: ColdUsageOptions): Promise<unknown> {
  if (conversationRef === null) return { messages: [], timeline: [], usageSnapshot: { execution: projectExecutionSnapshot([]) } };
  const before = fileFingerprint(conversationRef);
  let messages: unknown;
  try {
    const content = readFileSync(conversationRef, "utf8");
    if (content.trim().length === 0) {
      messages = { messages: [], timeline: [], usageSnapshot: { execution: projectExecutionSnapshot([]) } };
    } else {
      const parsed = parseSessionEntries(content);
      assertCurrentPiJsonl(content);
      if (parsed.length === 0) throw new Error("cannot parse session file");
      const manager = buildPersistedSessionManager(conversationRef, parsed as SessionEntry[]);
      // getBranch() is the SDK's selected current path: orphaned sibling branches never leak.
      messages = { ...projectExportSnapshot(manager.buildSessionContext().messages as unknown[], manager.getBranch()),
        usageSnapshot: { execution: projectExecutionSnapshot(manager.getEntries()), ...projectColdUsage(manager, usage) } };
    }
  } catch (error) {
    throw new Error("会话历史读取失败", { cause: error });
  }
  if (!sameFingerprint(before, fileFingerprint(conversationRef))) {
    throw new Error("会话历史读取失败：会话文件在读取期间被修改");
  }
  return messages;
}

export async function readPiJsonlSteps(file: string | null, sessionId: string): Promise<import("../shared/session-steps.js").SessionStepsSnapshot> {
  if (file === null) return projectColdSessionSteps(sessionId, []);
  const before = fileFingerprint(file);
  const content = readFileSync(file, "utf8");
  assertCurrentPiJsonl(content);
  const parsed = content.trim() ? parseSessionEntries(content) as SessionEntry[] : [];
  const header = parsed[0] as SessionHeader | undefined;
  const manager = SessionManager.inMemory(header?.cwd ?? process.cwd(), undefined, parsed);
  const branch = manager.getBranch();
  if (!sameFingerprint(before, fileFingerprint(file))) throw new Error("session history changed during read");
  return projectColdSessionSteps(sessionId, branch);
}

export const FIRST_PROMPT_MAX_BYTES = 256 * 1024;
export const FIRST_PROMPT_MAX_LINE_BYTES = 64 * 1024;
export const FIRST_PROMPT_MAX_LINES = 1024;
const FIRST_PROMPT_CACHE_BYTES = 4 * 1024 * 1024;
const FIRST_PROMPT_NEGATIVE_TTL_MS = 2000;

function promptFileIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

// Same snapshot/open/fstat/recheck pattern as session-file-preview. The managed root
// and every descendant must not be symlinks. This is not openat/ABA isolation from
// a malicious local writer; the service-maintained DATA_DIR is not a sandbox.
function snapshotPromptPath(root: string, file: string): Array<{ file: string; stat: Stats }> {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("history unavailable");
  const parts = relative.split(path.sep);
  const nodes = [root];
  for (const part of parts) nodes.push(path.join(nodes.at(-1)!, part));
  return nodes.map((node, index) => {
    const stat = lstatSync(node);
    if (stat.isSymbolicLink() || (index === nodes.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("history unavailable");
    return { file: node, stat };
  });
}
function unchangedPromptPath(nodes: ReturnType<typeof snapshotPromptPath>): boolean {
  return nodes.every(({ file, stat }) => {
    const now = lstatSync(file);
    return !now.isSymbolicLink() && promptFileIdentity(now) === promptFileIdentity(stat);
  });
}

/** Bounded descriptor reads, no readline buffering or whole-file scan. */
export async function readPiJsonlFirstPrompt(file: string, root = path.dirname(file)): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    const nodes = snapshotPromptPath(root, file);
    const before = nodes.at(-1)!.stat;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || promptFileIdentity(opened) !== promptFileIdentity(before) || !unchangedPromptPath(nodes)) return null;
    const prompt = await readPromptPrefix(handle);
    if (promptFileIdentity(await handle.stat()) !== promptFileIdentity(opened) || !unchangedPromptPath(nodes)) return null;
    return prompt;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readPromptPrefix(handle: FileHandle): Promise<string | null> {
  const chunk = Buffer.allocUnsafe(8192);
  let pending = Buffer.alloc(0);
  let bytes = 0;
  let lines = 0;
  let header = false;
  while (bytes < FIRST_PROMPT_MAX_BYTES) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, FIRST_PROMPT_MAX_BYTES - bytes), bytes);
    if (!bytesRead) return null; // No user, or incomplete final line: unknown, not empty-history proof.
    bytes += bytesRead;
    pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (++lines > FIRST_PROMPT_MAX_LINES || newline > FIRST_PROMPT_MAX_LINE_BYTES) return null;
      const line = new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, newline));
      pending = pending.subarray(newline + 1);
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (!header) {
        if (entry?.type !== "session" || entry.version !== 3 || typeof entry.id !== "string") return null;
        header = true;
      } else {
        if (!entry || typeof entry.id !== "string" || !(entry.parentId === null || typeof entry.parentId === "string")) return null;
        if (entry.type === "message" && entry.message?.role === "user") return firstUserPrompt([entry.message]);
      }
    }
    if (pending.length > FIRST_PROMPT_MAX_LINE_BYTES || lines >= FIRST_PROMPT_MAX_LINES) return null;
  }
  return null;
}

export class PiJsonlConversationStorage implements ConversationStorage {
  readonly agentKind = PI_AGENT_KIND;
  readonly conversationFormat = PI_CONVERSATION_FORMAT;
  private readonly dataDir: string;

  private readonly unifiedStorage?: NativePiConversationStorage;
  constructor(dataDir: string, private readonly unified?: { source: NativeSessionSource; index: NativeSessionIndexPort }) {
    this.dataDir = requirePiDataDir(dataDir);
    if (unified) this.unifiedStorage = new NativePiConversationStorage(unified.source, unified.index);
  }

  private isUnified(file: string | null): boolean {
    if (!file || !this.unified) return false;
    const relative = path.relative(this.unified.source.root, file).split(path.sep);
    return relative.length === 2 && /^--.*--$/.test(relative[0]!) && relative[1]!.endsWith(".jsonl");
  }

  private async unifiedConversation(conversation: ConversationDescriptor, context: ConversationReadContext) {
    const binding = await this.unified!.index.binding(context.sessionId);
    if (!binding?.private || binding.sourcePath !== conversation.conversationRef) throw new Error("private source unavailable");
    return { ...conversation, conversationFormat: "pi-native-jsonl-v3" };
  }

  private readonly firstPrompts = new Map<string, { identity: string; prompt: string | null; expires: number; bytes: number }>();
  private firstPromptCacheBytes = 0;

  async readTitle(conversation: ConversationDescriptor, context: ConversationReadContext): Promise<string | null> {
    try {
      // Unified Web-private files retain the managed DTO format but their name
      // lives in native session_info, just like shared CLI sessions.
      if (this.isUnified(conversation.conversationRef)) return this.unifiedStorage!.readTitle(await this.unifiedConversation(conversation, context), context);
      return null;
    } catch { return null; }
  }

  async readFirstPrompt(conversation: ConversationDescriptor, context: ConversationReadContext): Promise<string | null> {
    try {
      if (this.isUnified(conversation.conversationRef)) return this.unifiedStorage!.readFirstPrompt(await this.unifiedConversation(conversation, context), context);
      this.assertReadReference(conversation, context);
      const file = conversation.conversationRef;
      if (file === null) return null;
      const nodes = snapshotPromptPath(this.dataDir, file);
      const identity = promptFileIdentity(nodes.at(-1)!.stat);
      const cached = this.firstPrompts.get(file);
      if (cached?.identity === identity && cached.expires > Date.now()) return cached.prompt;
      if (cached) {
        this.firstPromptCacheBytes -= cached.bytes;
        this.firstPrompts.delete(file);
      }
      const prompt = await readPiJsonlFirstPrompt(file, this.dataDir);
      if (!unchangedPromptPath(nodes)) return null;
      // Charge UTF-16 string storage plus fixed entry overhead (not a total heap quota).
      const bytes = 2 * (file.length + (prompt?.length ?? 0)) + 256;
      while (this.firstPrompts.size >= 256 || this.firstPromptCacheBytes + bytes > FIRST_PROMPT_CACHE_BYTES) {
        const key = this.firstPrompts.keys().next().value;
        if (key === undefined) break;
        this.firstPromptCacheBytes -= this.firstPrompts.get(key)!.bytes;
        this.firstPrompts.delete(key);
      }
      // Concurrent reads may have installed this entry while awaiting I/O.
      const previous = this.firstPrompts.get(file);
      if (previous) this.firstPromptCacheBytes -= previous.bytes;
      this.firstPrompts.set(file, { identity, prompt, bytes,
        expires: prompt === null ? Date.now() + FIRST_PROMPT_NEGATIVE_TTL_MS : Infinity });
      this.firstPromptCacheBytes += bytes;
      return prompt;
    } catch {
      return null;
    }
  }

  async readExport(conversation: ConversationDescriptor, context: ConversationReadContext): Promise<unknown> {
    if (this.isUnified(conversation.conversationRef)) return this.unifiedStorage!.readExport(await this.unifiedConversation(conversation, context), context);
    this.assertReadReference(conversation, context);
    return readPiJsonlExport(conversation.conversationRef, context.usage);
  }

  private subagentCache = new Map<string, { fingerprint: string; entries: SessionEntry[] }>();
  async readSubagents(conversation: ConversationDescriptor, context: ConversationReadContext, runId?: string) {
    if (this.isUnified(conversation.conversationRef)) return this.unifiedStorage!.readSubagents(await this.unifiedConversation(conversation, context), context, runId);
    this.assertReadReference(conversation, context);
    const file = conversation.conversationRef;
    if (!file) return projectSubagents(context.sessionId, []);
    const nodes = snapshotPromptPath(this.dataDir, file);
    const fingerprint = promptFileIdentity(nodes.at(-1)!.stat);
    const cached = this.subagentCache.get(file);
    if (cached?.fingerprint === fingerprint && unchangedPromptPath(nodes)) return projectSubagents(context.sessionId, cached.entries, undefined, runId);
    const before = fileFingerprint(file);
    const content = readFileSync(file, "utf8");
    assertCurrentPiJsonl(content);
    const entries = parseSessionEntries(content) as SessionEntry[];
    const manager = SessionManager.inMemory(process.cwd(), undefined, entries);
    const branch = manager.getBranch().filter(e => (e.type === "custom" && e.customType === "agent-team:transcript") ||
      (e.type === "message" && e.message.role === "toolResult" && ["subagent", "subagent_wait"].includes(e.message.toolName)));
    const result = projectSubagents(context.sessionId, branch, undefined, runId);
    if (!sameFingerprint(before, fileFingerprint(file))) throw new Error("session history changed during read");
    if (!unchangedPromptPath(nodes)) throw new Error("session history changed during read");
    if (this.subagentCache.size >= 8) this.subagentCache.delete(this.subagentCache.keys().next().value!);
    this.subagentCache.set(file, { fingerprint, entries: branch });
    return result;
  }

  private readonly usageLedgers = new UsageLedgerCache();
  async readUsageLedger(conversation: ConversationDescriptor, context: ConversationReadContext): Promise<readonly UsageLedgerEvent[]> {
    if (this.isUnified(conversation.conversationRef)) return this.unifiedStorage!.readUsageLedger(await this.unifiedConversation(conversation, context), context);
    this.assertReadReference(conversation, context);
    const file = conversation.conversationRef;
    if (!file) return [];
    const nodes = snapshotPromptPath(this.dataDir, file);
    const fingerprint = promptFileIdentity(nodes.at(-1)!.stat);
    const cached = this.usageLedgers.get(file, fingerprint);
    if (cached) return cached;
    const ledger = usageLedgerFromJsonl(await readFile(file, "utf8"));
    if (!unchangedPromptPath(nodes)) throw new Error("session history changed during read");
    this.usageLedgers.set(file, fingerprint, ledger);
    return ledger;
  }

  async readSteps(conversation: ConversationDescriptor, context: ConversationReadContext) {
    if (this.isUnified(conversation.conversationRef)) return this.unifiedStorage!.readSteps(await this.unifiedConversation(conversation, context), context);
    this.assertReadReference(conversation, context);
    return readPiJsonlSteps(conversation.conversationRef, context.sessionId);
  }

  private assertReadReference(conversation: ConversationDescriptor, context: ConversationReadContext): void {
    this.assertDescriptor(conversation);
    if (conversation.conversationRef !== null) {
      if (!path.isAbsolute(conversation.conversationRef)) throw new Error("Pi conversation reference must be absolute");
      relativeWhitelistedPath(this.dataDir, conversation.conversationRef);
      const classification = classifyPiJsonlReference(this.dataDir, {
        sessionId: context.sessionId,
        projectId: context.projectId,
        agentKind: conversation.agentKind,
        conversationFormat: conversation.conversationFormat,
        conversationRef: conversation.conversationRef,
      });
      if (classification.kind === "invalid" || (classification.kind === "valid" && !classification.idsMatch)) {
        throw new Error("Pi conversation reference does not match its session");
      }
    }
  }

  planCleanup(input: {
    readonly sessionId: string;
    readonly projectId: string;
    readonly conversation: ConversationDescriptor;
  }): ConversationCleanupPlan | null {
    this.assertDescriptor(input.conversation);
    if (input.conversation.conversationRef === null || this.isUnified(input.conversation.conversationRef)) return null;
    const classification = classifyPiJsonlReference(this.dataDir, {
      sessionId: input.sessionId,
      projectId: input.projectId,
      agentKind: input.conversation.agentKind,
      conversationFormat: input.conversation.conversationFormat,
      conversationRef: input.conversation.conversationRef,
    });
    if (classification.kind !== "valid") {
      throw new Error("Pi conversation reference has an invalid managed layout");
    }
    // A valid path may be shared by an import/recovery fixture. Only the
    // session encoded by the path may enqueue its deletion; a non-owner is
    // removed without touching an artifact that belongs to another session.
    if (!classification.idsMatch) return null;
    if (!path.isAbsolute(input.conversation.conversationRef)) {
      throw new Error("Pi conversation reference must be absolute");
    }
    const relativePath = relativeWhitelistedPath(this.dataDir, input.conversation.conversationRef);
    return {
      operationKey: artifactDeleteOperationKey(
        input.conversation.agentKind,
        input.conversation.conversationFormat,
        relativePath,
      ),
      kind: "delete",
      relativePath,
      sessionId: input.sessionId,
      projectId: input.projectId,
    };
  }

  classifyReference(record: ConversationReferenceRecord, dataDir: string): ConversationReferenceClassification {
    this.assertDescriptor(record.conversation);
    if (this.isUnified(record.conversation.conversationRef)) return {
      kind: "valid", canonical: path.relative(this.unified!.source.root, record.conversation.conversationRef!).split(path.sep).join("/"), idsMatch: true,
    };
    return classifyPiJsonlReference(dataDir, {
      sessionId: record.sessionId,
      projectId: record.projectId,
      agentKind: record.conversation.agentKind,
      conversationFormat: record.conversation.conversationFormat,
      conversationRef: record.conversation.conversationRef,
    });
  }

  private assertDescriptor(conversation: ConversationDescriptor): void {
    if (conversation.agentKind !== this.agentKind || conversation.conversationFormat !== this.conversationFormat) {
      throw new Error("unsupported conversation kind or format");
    }
  }
}
