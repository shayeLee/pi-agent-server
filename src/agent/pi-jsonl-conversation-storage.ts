// Pi 专属会话存储：Pi Session 的 JSONL v3 恢复、只读导出、引用清理和 DB-only 引用校验。
// 通用层只通过 ConversationStorage 访问本模块，不解释 conversationRef。

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  buildSessionContext,
  parseSessionEntries,
  SessionManager,
  type NewSessionOptions,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { projectExportMessages } from "./pi-agent-adapter.js";
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
import { classifyPiJsonlReference, requirePiDataDir } from "./pi-jsonl-reference.js";

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
export async function readPiJsonlExport(conversationRef: string | null): Promise<unknown> {
  if (conversationRef === null) return [];
  const before = fileFingerprint(conversationRef);
  let messages: unknown;
  try {
    const content = readFileSync(conversationRef, "utf8");
    const parsed = parseSessionEntries(content);
    assertCurrentPiJsonl(content);
    if (content.length > 0 && parsed.length === 0) throw new Error("cannot parse session file");
    const context = buildSessionContext(parsed as unknown as SessionEntry[]);
    messages = projectExportMessages(context.messages as unknown[]);
  } catch (error) {
    throw new Error("会话历史读取失败", { cause: error });
  }
  if (!sameFingerprint(before, fileFingerprint(conversationRef))) {
    throw new Error("会话历史读取失败：会话文件在读取期间被修改");
  }
  return messages;
}

export class PiJsonlConversationStorage implements ConversationStorage {
  readonly agentKind = PI_AGENT_KIND;
  readonly conversationFormat = PI_CONVERSATION_FORMAT;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = requirePiDataDir(dataDir);
  }

  async readExport(conversation: ConversationDescriptor, context: ConversationReadContext): Promise<unknown> {
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
    return readPiJsonlExport(conversation.conversationRef);
  }

  planCleanup(input: {
    readonly sessionId: string;
    readonly projectId: string;
    readonly conversation: ConversationDescriptor;
  }): ConversationCleanupPlan | null {
    this.assertDescriptor(input.conversation);
    if (input.conversation.conversationRef === null) return null;
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
