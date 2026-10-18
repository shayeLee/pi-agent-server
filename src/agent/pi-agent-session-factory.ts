// Pi 专属 AgentSession factory：把 SessionManager/createAgentSession 与通用 runtime 隔离。
// 本模块不读取或写入 session Repository；引用 reservation 与删除竞态由应用层协调。

import path from "node:path";
import { abortTrace, traceSessionLifecycle } from "../core/abort-trace.js";
import { resolveSdkToolConfig, validateResolvedToolSelection } from "./tool-selection.js";
import { constants, openSync, closeSync, writeSync, fstatSync, mkdirSync, lstatSync, realpathSync } from "node:fs";
import { canonicalCwdIdentity } from "../core/native-session-policy.js";
import { nativeProjectDirectory, nativePathSnapshot, type NativeSessionSource, type NativeSourceBinding } from "./native-session-source.js";
import { openNativeSessionManager, type NativeSessionFd } from "./native-session-fd.js";
import type { NativeSessionIndexPort } from "../application/native-session-service.js";
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
  /** 会话所属项目（用于读取项目级 MCP 设置）。 */
  readonly projectId: string;
  /** 会话所属项目的 cwd（提示词/工具根）。 */
  readonly projectCwd: string;
  /** 会话创建时冻结的系统提示词；null 表示未记录（宿主按项目 cwd 重新解析）。 */
  readonly systemPrompt: string | null;
  /** 会话可以使用谁的按用户 MCP 凭证；null 表示谁的都不用（共享或原生会话）。 */
  readonly mcpCredentialOwner: string | null;
};

/** 会话专属 loader 与其同一 ExtensionRuntime 的必需 EventBus（也承载 host identity）。 */
export type PiSessionResourceLoader = {
  readonly loader: ResourceLoader;
  readonly failbackLifecycleSource: FailbackLifecycleSource;
};

export type PiAgentSessionFactoryOptions = {
  readonly modelRuntime: ModelRuntime;
  /** Separate factory registration; managed references never inherit native allowroots. */
  readonly native?: { source: NativeSessionSource; index: NativeSessionIndexPort };
  /** New Web-private files use the native root, retaining the managed format registration. */
  readonly unified?: { source: NativeSessionSource; index: NativeSessionIndexPort };
  /**
   * 会话专属 ResourceLoader 工厂：每次创建 adapter（新会话或恢复）调用一次，返回一个
   * **只服务该活动 session** 的 loader。
   *
   * 不能传入共享 loader：`AgentSession.dispose()` 会 invalidate 该 loader 的
   * ExtensionRuntime，而 startup/项目提示词探针会话创建后立即 dispose；共享会让真实会话拿到
   * 已 stale 的 runtime。同一 session 的多轮由同一 AgentSession/adapter 承担（SDK 单会话语义），
   * 不需要也不应该重建 loader。
   */
  readonly createResourceLoader: (request: PiResourceLoaderRequest) => Promise<PiSessionResourceLoader>;
  readonly defaultModel?: ReturnType<ModelRuntime["getModel"]>;
  readonly defaultThinkingLevel?: string;
  readonly customTools?: readonly ToolDefinition[];
  readonly agentToolConfig: {
    /** Resolved exact allowlist; raw modifiers belong at the composition boundary. */
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
  readonly conversationFormat: string;
  private readonly native?: PiAgentSessionFactoryOptions["native"];
  private readonly unified?: PiAgentSessionFactoryOptions["unified"];
  private readonly modelRuntime: ModelRuntime;
  private readonly createResourceLoader: PiAgentSessionFactoryOptions["createResourceLoader"];
  private readonly defaultModel: ReturnType<ModelRuntime["getModel"]> | undefined;
  private readonly defaultThinkingLevel: string | undefined;
  private readonly customTools: readonly ToolDefinition[] | undefined;
  private readonly agentToolConfig: PiAgentSessionFactoryOptions["agentToolConfig"];

  constructor(options: PiAgentSessionFactoryOptions) {
    this.modelRuntime = options.modelRuntime;
    this.native = options.native;
    this.unified = options.unified;
    this.conversationFormat = options.native ? "pi-native-jsonl-v3" : PI_CONVERSATION_FORMAT;
    this.createResourceLoader = options.createResourceLoader;
    this.defaultModel = options.defaultModel;
    this.defaultThinkingLevel = options.defaultThinkingLevel;
    this.customTools = options.customTools;
    validateResolvedToolSelection(options.agentToolConfig.tools);
    this.agentToolConfig = {
      ...options.agentToolConfig,
      ...(options.agentToolConfig.tools !== undefined ? { tools: [...options.agentToolConfig.tools] } : {}),
    };
  }

  async prepareNew(context: AgentSessionContext): Promise<PreparedAgentSession> {
    this.assertContext(context);
    if (this.native) throw new Error("native factory cannot create or copy sessions");
    // Store an immutable canonical path plus inode identity in JSONL. Project/default cwd config
    // is mutable and must never re-root an already-created session.
    const cwdIdentity = captureSessionCwdIdentity(context.projectCwd);
    if (this.unified) return this.prepareUnified(context, cwdIdentity);
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
    const sourceRegistration = this.native ?? this.unified;
    const sourceBinding = await sourceRegistration?.index.binding(context.sessionId);
    if (this.native || sourceBinding) {
      const binding = sourceBinding;
      if (!binding || binding.sourcePath !== conversation.conversationRef || (!this.native && !binding.private) || (this.native && binding.private)) throw new Error("native source unavailable");
      const project = canonicalCwdIdentity(context.projectCwd);
      if (project.cwd !== binding.cwd || project.dev !== binding.dev || project.ino !== binding.ino) throw new Error("native project identity changed");
      const { manager, descriptor } = openNativeSessionManager(sourceRegistration!.source, binding);
      try {
        const opened = await this.createSdkSession({ ...context, projectCwd: binding.cwd }, manager, false, descriptor);
        try { descriptor.check(); } catch (error) { opened.adapter.dispose(); throw error; }
        return this.guardAdapter(opened.adapter, descriptor);
      } catch (error) { descriptor.close(); throw error; }
    }
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

  private async prepareUnified(context: AgentSessionContext, identity: ReturnType<typeof captureSessionCwdIdentity>): Promise<PreparedAgentSession> {
    const registration = this.unified!;
    if (!registration.index.reservePrivate || !registration.index.finalizePrivate || !registration.index.retirePrivate) throw new Error("private source index unavailable");
    const memory = SessionManager.inMemory(identity.cwd);
    const header = memory.getHeader()!;
    const file = path.join(registration.source.root, nativeProjectDirectory(identity.cwd), `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`);
    const binding: NativeSourceBinding = { ...identity, sourceId: header.id, sourcePath: file, sourceDev: -1, sourceIno: -1, private: true };
    return {
      proposedConversation: this.descriptor(file),
      sourceReservationKey: `native-private:${header.id}`,
      open: async () => {
        // Unique source ID/path are claimed before the first scan-visible byte exists.
        await registration.index.reservePrivate!(context.projectId, binding, context.sessionId);
        let descriptor: NativeSessionFd | undefined;
        try {
          mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          let node = path.parse(file).root;
          for (const part of path.dirname(file).slice(node.length).split(path.sep).filter(Boolean)) {
            node = path.join(node, part);
            const stat = lstatSync(node);
            if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(node) !== node) throw new Error("unsafe private source directory");
          }
          const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          let actual: NativeSourceBinding;
          try {
            const bytes = Buffer.from(JSON.stringify(header) + "\n");
            if (writeSync(fd, bytes) !== bytes.length) throw new Error("private header write failed");
            const stat = fstatSync(fd);
            actual = { ...binding, sourceDev: stat.dev, sourceIno: stat.ino };
            const current = nativePathSnapshot(registration.source.root, file).at(-1)!.stat;
            if (current.dev !== stat.dev || current.ino !== stat.ino || stat.nlink !== 1) throw new Error("private source changed");
          } finally { closeSync(fd); }
          await registration.index.finalizePrivate!(actual, context.sessionId);
          const opened = openNativeSessionManager(registration.source, actual);
          descriptor = opened.descriptor;
          opened.manager.appendCustomEntry("pi-agent-server:cwd-identity", identity);
          const result = await this.createSdkSession(context, opened.manager, true, descriptor);
          return { adapter: this.guardAdapter(result.adapter, descriptor), conversation: this.descriptor(file) };
        } catch (error) {
          descriptor?.close();
          await registration.index.retirePrivate!(context.sessionId);
          throw error;
        }
      },
    };
  }

  private guardAdapter(adapter: AgentAdapter, descriptor: NativeSessionFd): AgentAdapter {
    const asynchronous = new Set<PropertyKey>(["prompt", "promptCustom", "queueCustomFollowUp", "steer", "followUp", "navigateTree", "setModel", "setThinkingLevel", "exportSession", "getLastUsage", "getUsageSnapshot"]);
    return new Proxy(adapter, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (property === "dispose") return () => { try { target.dispose(); } finally { descriptor.close(); } };
        if (property === "abort" || String(property).startsWith("subscribe")) return value.bind(target);
        if (asynchronous.has(property)) return async (...args: unknown[]) => { descriptor.check(); return value.apply(target, args); };
        return (...args: unknown[]) => { descriptor.check(); return value.apply(target, args); };
      },
    });
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
    nativeFd?: NativeSessionFd,
  ): Promise<{ readonly adapter: PiAgentAdapter; readonly sessionFile: string | null }> {
    // A restored JSONL is the SDK's authority: it records automatic extension fallback too.
    // Only an old transcript with no model/thinking snapshot may use the DB index as fallback.
    const transcript = !isNewSession
      ? (sessionManager as PiSessionManagerWithTranscript).buildSessionContext?.()
      : undefined;
    const transcriptHasModel = transcript?.model != null;
    const transcriptHasThinking = transcript?.thinkingLevel != null;
    const historicalModel = transcript?.model as { provider: string; modelId: string } | null | undefined;
    const databaseHasModel = context.modelProvider != null && context.modelId != null;
    const model = transcriptHasModel
      ? this.modelRuntime.getModel(historicalModel!.provider, historicalModel!.modelId)
      : databaseHasModel
        ? this.modelRuntime.getModel(context.modelProvider!, context.modelId!)
        : this.defaultModel;
    // SDK silently auto-picks another provider when history cannot be restored. Do not let
    // restored sessions change identity (or consult unrelated credentials) through that fallback.
    if ((transcriptHasModel || databaseHasModel || !isNewSession) && !model) {
      throw new Error(transcriptHasModel ? "historical session model is unavailable" : "session model is unavailable (no saved or configured default model)");
    }
    const thinkingLevel = (isNewSession || !transcriptHasThinking)
      ? context.thinkingLevel ?? (isNewSession ? this.defaultThinkingLevel : undefined)
      : undefined;
    const settingsManager = SettingsManager.inMemory();
    const toolConfig = resolveSdkToolConfig(this.agentToolConfig, settingsManager.getDefaultTools());
    const resolvedLoader = await this.resolveResourceLoader(context);
    // Fail before SDK startup: an unbridged extension must never mistake this host for CLI.
    if (!resolvedLoader?.loader || typeof resolvedLoader.failbackLifecycleSource?.on !== "function") {
      throw new Error("Host session requires a session-local ResourceLoader EventBus");
    }
    const sessionLoader = resolvedLoader;
    const options: PiCreateOptions = {
      sessionManager,
      modelRuntime: this.modelRuntime,
      resourceLoader: sessionLoader.loader,
      settingsManager,
      cwd: context.projectCwd,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel: thinkingLevel as NonNullable<PiCreateOptions["thinkingLevel"]> } : {}),
      ...toolConfig,
      ...(this.customTools !== undefined ? { customTools: [...this.customTools] } : {}),
    };
    const { session } = await createAgentSession(options);
    traceSessionLifecycle(session, context.sessionId);
    // SDK creation intentionally does not bind extension handlers. Install the adapter's session-local
    // failback + agent-team notready bridges first, then bind exactly once; probes stay unbound.
    // SessionRuntime later attaches only its own notification admission capability.
    const sdkSession = session as unknown as AgentSessionLike;
    if (nativeFd) {
      const stop = () => { abortTrace("native.poison", { sessionId: context.sessionId }, true); void sdkSession.abort?.().catch(() => {}); sdkSession.dispose(); (this.native ?? this.unified)?.source.revoke(nativeFd.binding); };
      nativeFd.onPoison = stop;
      // Guard SDK emission before adapter observers see even a delta. A poisoned
      // in-memory tree must never be emitted after SDK appended before _persist failed.
      const emitter = sdkSession as AgentSessionLike & { _emit?: (...args: unknown[]) => void };
      const emit = emitter._emit?.bind(emitter);
      if (emit) emitter._emit = (...args) => { try { nativeFd.check(); } catch { return; } emit(...args); };
      const subscribe = sdkSession.subscribe.bind(sdkSession);
      sdkSession.subscribe = listener => subscribe(event => { try { nativeFd.check(); } catch { return; } listener(event); });
    }
    const adapter = new PiAgentAdapter(
      sdkSession,
      (provider, modelId) => this.modelRuntime.getModel(provider, modelId),
      sessionLoader.failbackLifecycleSource,
    );
    // Test doubles intentionally model only the adapter surface. Real SDK sessions always bind once.
    try {
      if (sdkSession.bindExtensions) {
        await sdkSession.bindExtensions({
          mode: "json",
          onError: () => {}, // provider extensions are trusted, but their error text may contain credentials
        });
      }
      nativeFd?.check();
    } catch (error) { adapter.dispose(); nativeFd?.close(); throw error; }
    return {
      adapter,
      sessionFile: session.sessionFile ?? null,
    };
  }

  /**
   * 每次 adapter 创建都取**新的**会话专属 loader；冻结提示词由宿主按字面量 override。
   * 同一 session 的多轮复用同一 adapter（因此复用同一 loader），不在这里缓存/共享。
   */
  private resolveResourceLoader(context: AgentSessionContext): Promise<PiSessionResourceLoader> {
    return this.createResourceLoader({
      projectId: context.projectId,
      projectCwd: context.projectCwd,
      systemPrompt: context.systemPrompt ?? null,
      mcpCredentialOwner: context.mcpCredentialOwner ?? null,
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
