// Pi 专属 AgentSession factory：把 SessionManager/createAgentSession 与通用 runtime 隔离。
// 本模块不读取或写入 session Repository；引用 reservation 与删除竞态由应用层协调。

import path from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { PiAgentAdapter, type AgentSessionLike } from "./pi-agent-adapter.js";
import type { FailbackLifecycleSource } from "./failback-lifecycle.js";
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
import { captureSessionCwdIdentity, readSessionCwdIdentity } from "./session-cwd-identity.js";

export type PiResourceLoaderRequest = {
  /** 会话所属项目的 cwd（提示词/工具根）。 */
  readonly projectCwd: string;
  /** 会话创建时冻结的系统提示词；null 表示未记录（宿主按项目 cwd 重新解析）。 */
  readonly systemPrompt: string | null;
};

/** 会话专属 loader 与其同一 ExtensionRuntime 的可选 failback EventBus。 */
export type PiSessionResourceLoader = {
  readonly loader: ResourceLoader;
  readonly failbackLifecycleSource?: FailbackLifecycleSource;
};

export type PiAgentSessionFactoryOptions = {
  readonly modelRuntime: ModelRuntime;
  /**
   * 会话专属 ResourceLoader 工厂：每次创建 adapter（新会话或恢复）调用一次，返回一个
   * **只服务该活动 session** 的 loader。
   *
   * 不能传入共享 loader：`AgentSession.dispose()` 会 invalidate 该 loader 的
   * ExtensionRuntime，而 startup/项目提示词探针会话创建后立即 dispose；共享会让真实会话拿到
   * 已 stale 的 runtime。同一 session 的多轮由同一 AgentSession/adapter 承担（SDK 单会话语义），
   * 不需要也不应该重建 loader。
   */
  readonly createResourceLoader: (request: PiResourceLoaderRequest) => Promise<ResourceLoader | PiSessionResourceLoader>;
  readonly defaultModel?: ReturnType<ModelRuntime["getModel"]>;
  readonly defaultThinkingLevel?: string;
  readonly customTools?: readonly ToolDefinition[];
  readonly agentToolConfig: {
    readonly tools?: readonly string[];
    readonly noTools?: "all" | "builtin";
  };
};

type PiSessionManager = SessionManager;
type PiSessionManagerWithTranscript = PiSessionManager & {
  buildSessionContext?: () => { model?: unknown; messages?: unknown[]; thinkingLevel?: unknown };
};

type PiCreateOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;

export class PiAgentSessionFactory implements AgentSessionFactory {
  readonly agentKind = PI_AGENT_KIND;
  readonly conversationFormat = PI_CONVERSATION_FORMAT;
  private readonly modelRuntime: ModelRuntime;
  private readonly createResourceLoader: PiAgentSessionFactoryOptions["createResourceLoader"];
  private readonly defaultModel: ReturnType<ModelRuntime["getModel"]> | undefined;
  private readonly defaultThinkingLevel: string | undefined;
  private readonly customTools: readonly ToolDefinition[] | undefined;
  private readonly agentToolConfig: PiAgentSessionFactoryOptions["agentToolConfig"];

  constructor(options: PiAgentSessionFactoryOptions) {
    this.modelRuntime = options.modelRuntime;
    this.createResourceLoader = options.createResourceLoader;
    this.defaultModel = options.defaultModel;
    this.defaultThinkingLevel = options.defaultThinkingLevel;
    this.customTools = options.customTools;
    this.agentToolConfig = options.agentToolConfig;
  }

  async prepareNew(context: AgentSessionContext): Promise<PreparedAgentSession> {
    this.assertContext(context);
    // Store an immutable canonical path plus inode identity in JSONL. Project/default cwd config
    // is mutable and must never re-root an already-created session.
    const cwdIdentity = captureSessionCwdIdentity(context.projectCwd);
    const sessionManager = SessionManager.create(cwdIdentity.cwd, this.sessionDirectory(context));
    sessionManager.appendCustomEntry("pi-agent-server:cwd-identity", cwdIdentity);
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
    const identity = readSessionCwdIdentity([sessionManager.getHeader()!, ...sessionManager.getEntries()]);
    if (!identity) throw new Error("session has no trusted frozen cwd identity");
    const opened = await this.createSdkSession({ ...context, projectCwd: identity.cwd }, sessionManager, false);
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
    // A restored JSONL is the SDK's authority: it records automatic extension fallback too.
    // Only an old transcript with no model/thinking snapshot may use the DB index as fallback.
    const transcript = !isNewSession
      ? (sessionManager as PiSessionManagerWithTranscript).buildSessionContext?.()
      : undefined;
    const transcriptHasModel = transcript?.model !== undefined;
    const transcriptHasThinking = transcript?.thinkingLevel !== undefined;
    const useDatabaseFallback = isNewSession || !transcriptHasModel;
    const model = useDatabaseFallback && context.modelProvider !== null && context.modelId !== null
      ? this.modelRuntime.getModel(context.modelProvider, context.modelId)
      : isNewSession
        ? this.defaultModel
        : undefined;
    if (useDatabaseFallback && context.modelProvider !== null && context.modelId !== null && !model) {
      throw new Error("session model is unavailable");
    }
    const thinkingLevel = (isNewSession || !transcriptHasThinking)
      ? context.thinkingLevel ?? (isNewSession ? this.defaultThinkingLevel : undefined)
      : undefined;
    const toolConfig: { tools?: string[]; noTools?: "all" | "builtin" } = {};
    if (this.agentToolConfig.tools !== undefined) toolConfig.tools = [...this.agentToolConfig.tools];
    if (this.agentToolConfig.noTools !== undefined) toolConfig.noTools = this.agentToolConfig.noTools;
    const resolvedLoader = await this.resolveResourceLoader(context);
    const sessionLoader: PiSessionResourceLoader = "loader" in resolvedLoader
      ? resolvedLoader
      : { loader: resolvedLoader };
    const options: PiCreateOptions = {
      sessionManager,
      modelRuntime: this.modelRuntime,
      resourceLoader: sessionLoader.loader,
      settingsManager: SettingsManager.inMemory(),
      cwd: context.projectCwd,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel: thinkingLevel as NonNullable<PiCreateOptions["thinkingLevel"]> } : {}),
      ...toolConfig,
      ...(this.customTools !== undefined ? { customTools: [...this.customTools] } : {}),
    };
    const { session } = await createAgentSession(options);
    // SDK creation intentionally does not bind extension handlers. Install the adapter's session-local
    // failback bridge first, then bind exactly once; probes never enter this factory and remain unbound.
    const sdkSession = session as unknown as AgentSessionLike;
    const adapter = new PiAgentAdapter(
      sdkSession,
      (provider, modelId) => this.modelRuntime.getModel(provider, modelId),
      sessionLoader.failbackLifecycleSource,
    );
    // Test doubles intentionally model only the adapter surface. Real SDK sessions always bind once.
    if (sdkSession.bindExtensions) {
      await sdkSession.bindExtensions({
        mode: "json",
        onError: () => {}, // provider extensions are trusted, but their error text may contain credentials
      });
    }
    return {
      adapter,
      sessionFile: session.sessionFile ?? null,
    };
  }

  /**
   * 每次 adapter 创建都取**新的**会话专属 loader；冻结提示词由宿主按字面量 override。
   * 同一 session 的多轮复用同一 adapter（因此复用同一 loader），不在这里缓存/共享。
   */
  private resolveResourceLoader(context: AgentSessionContext): Promise<ResourceLoader | PiSessionResourceLoader> {
    return this.createResourceLoader({
      projectCwd: context.projectCwd,
      systemPrompt: context.systemPrompt ?? null,
    });
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
