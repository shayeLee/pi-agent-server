// 会话引用与 Agent Session / 会话存储的通用端口。
// 通用层只携带 descriptor，不解释 conversationRef 的具体格式；当前唯一实现是 Pi JSONL。

import type { AgentAdapter } from "../../agent/agent-adapter.js";
import type { EnqueueFileOperationInput } from "./file-operation-store-port.js";

export const PI_AGENT_KIND = "pi" as const;
export const PI_CONVERSATION_FORMAT = "pi-jsonl-v3" as const;

export type ConversationDescriptor = {
  readonly agentKind: string;
  readonly conversationFormat: string;
  readonly conversationRef: string | null;
};

/** Session metadata needed by a factory; no repository or HTTP concerns cross this boundary. */
export type AgentSessionContext = {
  readonly sessionId: string;
  readonly projectId: string;
  readonly projectCwd: string;
  readonly dataDir: string;
  readonly modelProvider: string | null;
  readonly modelId: string | null;
  readonly thinkingLevel: string | null;
  readonly isNewSession: boolean;
  readonly agentToolConfig: {
    readonly tools?: readonly string[];
    readonly noTools?: "all" | "builtin";
  };
};

export type PreparedAgentSession = {
  /**
   * A concrete, stable cleanup anchor. New-session factories must reserve the
   * exact reference they may materialize; a failed open is therefore still
   * durably addressable through the session row and its cleanup outbox entry.
   */
  readonly proposedConversation: ConversationDescriptor & { readonly conversationRef: string };
  readonly open: () => Promise<OpenedAgentSession>;
};

export type OpenedAgentSession = {
  readonly adapter: AgentAdapter;
  /**
   * Must equal PreparedAgentSession.proposedConversation. A factory that
   * violates this contract remains responsible for rolling back any artifact
   * outside the proposed current-session path; the coordinator never deletes
   * a foreign reference merely because an untrusted factory reported it.
   */
  readonly conversation: ConversationDescriptor;
};

export interface AgentSessionFactory {
  readonly agentKind: string;
  readonly conversationFormat: string;
  prepareNew(context: AgentSessionContext): Promise<PreparedAgentSession>;
  restore(context: AgentSessionContext, conversation: ConversationDescriptor): Promise<AgentAdapter>;
}

export type CleanupConversationInput = {
  readonly sessionId: string;
  readonly projectId: string;
  readonly conversation: ConversationDescriptor;
};

/** A trusted, already policy-checked operation plan for the storage transaction. */
export type ConversationCleanupPlan = Omit<EnqueueFileOperationInput, "createdAt"> & {
  readonly kind: "delete";
  readonly sessionId: string;
  readonly projectId: string;
};

export type ConversationReferenceRecord = {
  readonly sessionId: string;
  readonly projectId: string;
  readonly conversation: ConversationDescriptor;
};

export type ConversationReadContext = {
  readonly sessionId: string;
  readonly projectId: string;
};

export interface ConversationStorage {
  readonly agentKind: string;
  readonly conversationFormat: string;
  /** Read-only export; the implementation validates session/project ownership context. */
  readExport(conversation: ConversationDescriptor, context: ConversationReadContext): Promise<unknown>;
  /** Return a cleanup operation or null for an unmaterialized conversation. */
  planCleanup(input: CleanupConversationInput): ConversationCleanupPlan | null;
  /** DB-only lexical reference analysis for reconcile. */
  classifyReference?(record: ConversationReferenceRecord, dataDir: string): ConversationReferenceClassification;
}

export type ConversationReferenceClassification =
  | { readonly kind: "unmaterialized" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly canonical: string; readonly idsMatch: boolean };

/** Registry is the only generic lookup point for kind/format pairs. */
export class ConversationStorageRegistry {
  private readonly entries = new Map<string, ConversationStorage>();

  register(storage: ConversationStorage): void {
    const key = conversationStorageKey(storage.agentKind, storage.conversationFormat);
    if (this.entries.has(key)) throw new Error("conversation storage already registered");
    this.entries.set(key, storage);
  }

  get(conversation: Pick<ConversationDescriptor, "agentKind" | "conversationFormat">): ConversationStorage | undefined {
    return this.entries.get(conversationStorageKey(conversation.agentKind, conversation.conversationFormat));
  }

  require(conversation: Pick<ConversationDescriptor, "agentKind" | "conversationFormat">): ConversationStorage {
    const storage = this.get(conversation);
    if (!storage) throw new Error("unsupported conversation kind or format");
    return storage;
  }
}

export function conversationStorageKey(agentKind: string, conversationFormat: string): string {
  return `${agentKind}\u0000${conversationFormat}`;
}

export type AgentSessionFactoryRegistry = {
  register(factory: AgentSessionFactory): void;
  get(conversation: Pick<ConversationDescriptor, "agentKind" | "conversationFormat">): AgentSessionFactory | undefined;
  require(conversation: Pick<ConversationDescriptor, "agentKind" | "conversationFormat">): AgentSessionFactory;
};

export class DefaultAgentSessionFactoryRegistry implements AgentSessionFactoryRegistry {
  private readonly entries = new Map<string, AgentSessionFactory>();

  register(factory: AgentSessionFactory): void {
    const key = conversationStorageKey(factory.agentKind, factory.conversationFormat);
    if (this.entries.has(key)) throw new Error("agent session factory already registered");
    this.entries.set(key, factory);
  }

  get(conversation: Pick<ConversationDescriptor, "agentKind" | "conversationFormat">): AgentSessionFactory | undefined {
    return this.entries.get(conversationStorageKey(conversation.agentKind, conversation.conversationFormat));
  }

  require(conversation: Pick<ConversationDescriptor, "agentKind" | "conversationFormat">): AgentSessionFactory {
    const factory = this.get(conversation);
    if (!factory) throw new Error("unsupported agent kind or conversation format");
    return factory;
  }
}

