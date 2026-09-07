// 通用会话创建服务：协调 session 记录、AgentSessionFactory 和 ConversationStorage。
// 它负责引用 reservation/条件回写与删除后的清理登记；具体 Agent/文件格式由实现端口负责。

import type { AgentAdapter } from "../agent/agent-adapter.js";
import { SessionDeletedError } from "../runtime/session-runtime.js";
import type {
  AgentSessionContext,
  AgentSessionFactoryRegistry,
  ConversationDescriptor,
  ConversationStorageRegistry,
  OpenedAgentSession,
} from "./ports/conversation-port.js";
import type { FileOperationStorePort } from "./ports/file-operation-store-port.js";
import { DEFAULT_PROJECT_ID, type ProjectStorePort } from "./ports/project-store-port.js";
import type { ConversationReservationInput, SessionRecord, SessionStorePort } from "./ports/session-store-port.js";

export type SessionConversationCoordinatorOptions = {
  readonly sessions: SessionStorePort;
  readonly projects: ProjectStorePort;
  readonly factories: AgentSessionFactoryRegistry;
  readonly conversationStorage: ConversationStorageRegistry;
  readonly fileOperations: FileOperationStorePort;
  readonly defaultProjectCwd: string;
  readonly dataDir: string;
  readonly defaultThinkingLevel?: string;
  readonly agentToolConfig: AgentSessionContext["agentToolConfig"];
};

export class SessionConversationCoordinator {
  private readonly sessions: SessionStorePort;
  private readonly projects: ProjectStorePort;
  private readonly factories: AgentSessionFactoryRegistry;
  private readonly conversationStorage: ConversationStorageRegistry;
  private readonly fileOperations: FileOperationStorePort;
  private readonly defaultProjectCwd: string;
  private readonly dataDir: string;
  private readonly defaultThinkingLevel?: string;
  private readonly agentToolConfig: AgentSessionContext["agentToolConfig"];

  constructor(options: SessionConversationCoordinatorOptions) {
    this.sessions = options.sessions;
    this.projects = options.projects;
    this.factories = options.factories;
    this.conversationStorage = options.conversationStorage;
    this.fileOperations = options.fileOperations;
    this.defaultProjectCwd = options.defaultProjectCwd;
    this.dataDir = options.dataDir;
    this.defaultThinkingLevel = options.defaultThinkingLevel;
    this.agentToolConfig = options.agentToolConfig;
  }

  async createAdapter(sessionId: string): Promise<AgentAdapter> {
    const record = await this.sessions.get(sessionId);
    if (!record) throw new SessionDeletedError(sessionId);
    const projectCwd = await this.projectCwd(record);
    if (projectCwd === null) throw new SessionDeletedError(sessionId);

    const conversation = this.conversationOf(record);
    const factory = this.factories.require(conversation);
    const context = this.contextOf(record, projectCwd);
    if (conversation.conversationRef !== null) {
      return factory.restore(context, conversation);
    }

    const prepared = await factory.prepareNew(context);
    this.assertFactoryDescriptor(factory.agentKind, factory.conversationFormat, prepared.proposedConversation);
    const proposedRef = prepared.proposedConversation.conversationRef;
    const reservation = this.reservationInputOf(sessionId, record.projectId, prepared.proposedConversation);
    const reserved = await this.sessions.reserveConversation(sessionId, reservation);
    if (!reserved) return this.restoreReservationOutcome(sessionId, projectCwd);

    let opened: OpenedAgentSession | undefined;
    try {
      opened = await prepared.open();
      this.assertFactoryDescriptor(factory.agentKind, factory.conversationFormat, opened.conversation);
      // A reservation is also the durable cleanup anchor. Factories must not
      // switch paths after it is recorded, otherwise a delete racing open
      // could only enqueue the proposed path and leave the actual artifact.
      if (opened.conversation.conversationRef !== proposedRef) {
        throw new Error("agent session factory materialized a conversation reference different from its reservation");
      }
      const committed = await this.sessions.commitConversationReservation(sessionId, proposedRef, proposedRef);
      if (committed) return opened.adapter;
      await this.anchorCleanup(sessionId, record.projectId, opened.conversation);
      try { opened.adapter.dispose(); } catch { /* preserve the winner outcome */ }
      return this.restoreReservationOutcome(sessionId, projectCwd);
    } catch (error) {
      // Keep the reservation in the session record while registering cleanup.
      // Releasing it would allow the deterministic Pi path to be reused while
      // an older delete operation may still target that same artifact.
      const cleanupErrors: unknown[] = [];
      // The proposed path is always the durable reservation anchor. If a
      // broken factory also reports a different, valid current-session path,
      // register both plans rather than letting the mismatch hide the proposal.
      const cleanupTargets = opened && opened.conversation.conversationRef !== proposedRef
        ? [opened.conversation, prepared.proposedConversation]
        : [prepared.proposedConversation];
      for (const target of cleanupTargets) {
        try {
          await this.anchorCleanup(sessionId, record.projectId, target);
        } catch (caught) {
          cleanupErrors.push(caught);
        }
      }
      if (opened) {
        try { opened.adapter.dispose(); } catch { /* preserve the creation error */ }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "agent session creation failed and cleanup could not be registered");
      }
      throw error;
    }
  }

  private async restoreReservationOutcome(sessionId: string, projectCwd: string): Promise<AgentAdapter> {
    // A different creator or a concurrent delete may have won the CAS. Never
    // overwrite its value. A still-unmaterialized row instead means the
    // proposed artifact is tombstoned (or otherwise unavailable), not a
    // restorable winner.
    const winner = await this.sessions.get(sessionId);
    if (!winner) throw new SessionDeletedError(sessionId);
    if (winner.conversationRef === null) {
      throw new Error("new session conversation reference is retired or unavailable");
    }
    const winnerConversation = this.conversationOf(winner);
    const winnerFactory = this.factories.require(winnerConversation);
    return winnerFactory.restore(this.contextOf(winner, projectCwd), winnerConversation);
  }

  private async anchorCleanup(
    sessionId: string,
    projectId: string,
    conversation: ConversationDescriptor,
  ): Promise<void> {
    const storage = this.conversationStorage.require(conversation);
    const plan = storage.planCleanup({ sessionId, projectId, conversation });
    if (plan) await this.fileOperations.enqueue(plan);
  }

  /**
   * Compute the tombstone operation key for a proposed new-session reference
   * before Pi writes JSONL.  A new session must be addressable by its cleanup
   * plan, otherwise it could never be blocked from reusing a deleted artifact
   * nor cleaned up on a failed open.
   */
  private reservationInputOf(
    sessionId: string,
    projectId: string,
    conversation: ConversationDescriptor & { readonly conversationRef: string },
  ): ConversationReservationInput {
    const storage = this.conversationStorage.require(conversation);
    const plan = storage.planCleanup({ sessionId, projectId, conversation });
    if (!plan) {
      throw new Error("new session reservation requires an addressable cleanup plan");
    }
    return { conversationRef: conversation.conversationRef, tombstoneOperationKey: plan.operationKey };
  }

  private async projectCwd(record: SessionRecord): Promise<string | null> {
    if (record.projectId === DEFAULT_PROJECT_ID) return this.defaultProjectCwd;
    const project = await this.projects.get(record.projectId);
    return project?.cwd ?? null;
  }

  private conversationOf(record: SessionRecord): ConversationDescriptor {
    return {
      agentKind: record.agentKind,
      conversationFormat: record.conversationFormat,
      conversationRef: record.conversationRef,
    };
  }

  private contextOf(record: SessionRecord, projectCwd: string): AgentSessionContext {
    return {
      sessionId: record.id,
      projectId: record.projectId,
      projectCwd,
      dataDir: this.dataDir,
      modelProvider: record.modelProvider,
      modelId: record.modelId,
      thinkingLevel: record.thinkingLevel ?? (record.conversationRef === null ? this.defaultThinkingLevel ?? null : null),
      isNewSession: record.conversationRef === null,
      agentToolConfig: this.agentToolConfig,
    };
  }

  private assertFactoryDescriptor(
    agentKind: string,
    conversationFormat: string,
    conversation: ConversationDescriptor,
  ): void {
    if (conversation.agentKind !== agentKind || conversation.conversationFormat !== conversationFormat) {
      throw new Error("agent session factory returned an unexpected conversation descriptor");
    }
  }
}
