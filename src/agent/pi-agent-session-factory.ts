// Pi 专属 AgentSession factory：把 SessionManager/createAgentSession 与通用 runtime 隔离。
// 本模块不读取或写入 session Repository；引用 reservation 与删除竞态由应用层协调。

import path from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { PiAgentAdapter, type AgentSessionLike } from "./pi-agent-adapter.js";
import type { AgentAdapter } from "./agent-adapter.js";
import {
  PI_AGENT_KIND,
  PI_CONVERSATION_FORMAT,
  type AgentSessionContext,
  type AgentSessionFactory,
  type ConversationDescriptor,
  type OpenedAgentSession,
  type PreparedAgentSession,
} from "../application/ports/conversation-port.js";
import { DEFAULT_PROJECT_ID } from "../application/ports/project-store-port.js";
import { openPiRuntimeSessionFile } from "./pi-jsonl-conversation-storage.js";
import { classifyPiJsonlReference } from "./pi-jsonl-reference.js";

export type PiAgentSessionFactoryOptions = {
  readonly modelRuntime: ModelRuntime;
  readonly resourceLoader: ResourceLoader;
  readonly defaultModel?: ReturnType<ModelRuntime["getModel"]>;
  readonly defaultThinkingLevel?: string;
  readonly agentToolConfig: {
    readonly tools?: readonly string[];
    readonly noTools?: "all" | "builtin";
  };
};

type PiSessionManager = SessionManager;

type PiCreateOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;

export class PiAgentSessionFactory implements AgentSessionFactory {
  readonly agentKind = PI_AGENT_KIND;
  readonly conversationFormat = PI_CONVERSATION_FORMAT;
  private readonly modelRuntime: ModelRuntime;
  private readonly resourceLoader: ResourceLoader;
  private readonly defaultModel: ReturnType<ModelRuntime["getModel"]> | undefined;
  private readonly defaultThinkingLevel: string | undefined;
  private readonly agentToolConfig: PiAgentSessionFactoryOptions["agentToolConfig"];

  constructor(options: PiAgentSessionFactoryOptions) {
    this.modelRuntime = options.modelRuntime;
    this.resourceLoader = options.resourceLoader;
    this.defaultModel = options.defaultModel;
    this.defaultThinkingLevel = options.defaultThinkingLevel;
    this.agentToolConfig = options.agentToolConfig;
  }

  async prepareNew(context: AgentSessionContext): Promise<PreparedAgentSession> {
    this.assertContext(context);
    const sessionManager = SessionManager.create(context.projectCwd, this.sessionDirectory(context));
    const conversationRef = sessionManager.getSessionFile();
    if (!conversationRef) throw new Error("new Pi session did not provide a session file");
    const proposedConversation = this.descriptor(conversationRef);
    return {
      proposedConversation,
      open: async () => this.openPrepared(context, sessionManager),
    };
  }

  async restore(context: AgentSessionContext, conversation: ConversationDescriptor): Promise<AgentAdapter> {
    this.assertContext(context);
    this.assertDescriptor(conversation);
    if (conversation.conversationRef === null) throw new Error("cannot restore an unmaterialized Pi session");
    const classification = classifyPiJsonlReference(context.dataDir, {
      sessionId: context.sessionId,
      projectId: context.projectId,
      agentKind: conversation.agentKind,
      conversationFormat: conversation.conversationFormat,
      conversationRef: conversation.conversationRef,
    });
    if (classification.kind !== "valid" || !classification.idsMatch) {
      throw new Error("Pi conversation reference does not match its session");
    }
    const sessionManager = openPiRuntimeSessionFile(conversation.conversationRef);
    const opened = await this.createSdkSession(context, sessionManager, false);
    return opened.adapter;
  }

  private async openPrepared(
    context: AgentSessionContext,
    sessionManager: PiSessionManager,
  ): Promise<OpenedAgentSession> {
    const opened = await this.createSdkSession(context, sessionManager, true);
    const actualRef = opened.sessionFile;
    if (!actualRef) throw new Error("new Pi session did not provide a session file");
    return {
      adapter: opened.adapter,
      conversation: this.descriptor(actualRef),
    };
  }

  private async createSdkSession(
    context: AgentSessionContext,
    sessionManager: PiSessionManager,
    isNewSession: boolean,
  ): Promise<{ readonly adapter: PiAgentAdapter; readonly sessionFile: string | null }> {
    const model = context.modelProvider !== null && context.modelId !== null
      ? this.modelRuntime.getModel(context.modelProvider, context.modelId)
      : isNewSession
        ? this.defaultModel
        : undefined;
    if (context.modelProvider !== null && context.modelId !== null && !model) {
      throw new Error("session model is unavailable");
    }
    const thinkingLevel = context.thinkingLevel ?? (isNewSession ? this.defaultThinkingLevel : undefined);
    const toolConfig: { tools?: string[]; noTools?: "all" | "builtin" } = {};
    if (this.agentToolConfig.tools !== undefined) toolConfig.tools = [...this.agentToolConfig.tools];
    if (this.agentToolConfig.noTools !== undefined) toolConfig.noTools = this.agentToolConfig.noTools;
    const options: PiCreateOptions = {
      sessionManager,
      modelRuntime: this.modelRuntime,
      resourceLoader: this.resourceLoader,
      settingsManager: SettingsManager.inMemory(),
      cwd: context.projectCwd,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel: thinkingLevel as NonNullable<PiCreateOptions["thinkingLevel"]> } : {}),
      ...toolConfig,
    };
    const { session } = await createAgentSession(options);
    return {
      adapter: new PiAgentAdapter(session as unknown as AgentSessionLike, (provider, modelId) =>
        this.modelRuntime.getModel(provider, modelId),
      ),
      sessionFile: session.sessionFile ?? null,
    };
  }

  private sessionDirectory(context: AgentSessionContext): string {
    return context.projectId === DEFAULT_PROJECT_ID
      ? path.join(context.dataDir, "sessions", context.sessionId)
      : path.join(context.dataDir, "projects", context.projectId, "sessions", context.sessionId);
  }

  private descriptor(conversationRef: string): ConversationDescriptor & { readonly conversationRef: string } {
    return {
      agentKind: this.agentKind,
      conversationFormat: this.conversationFormat,
      conversationRef,
    };
  }

  private assertDescriptor(conversation: ConversationDescriptor): void {
    if (conversation.agentKind !== this.agentKind || conversation.conversationFormat !== this.conversationFormat) {
      throw new Error("unsupported agent kind or conversation format");
    }
  }

  private assertContext(context: AgentSessionContext): void {
    if (context.agentToolConfig === undefined) throw new Error("agent session factory context is incomplete");
  }
}
