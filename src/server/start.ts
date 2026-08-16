// 启动入口：把真实 Pi SDK、SQLite 存储、真实鉴权、HTTP 层组装起来（README §4.1/§7）。
// 服务端安全边界：
// - 独立 agentDir（不继承个人 ~/.pi/agent），DefaultResourceLoader 禁用项目/全局自动发现；
// - 服务端默认模型 API key 从环境变量注入（setRuntimeApiKey，不落盘），不走个人 auth.json。

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { buildApp } from "./app.js";
import { buildAuthenticate } from "./real-auth.js";
import { SqliteSessionRepository } from "../storage/sqlite-session-repository.js";
import { SqliteIdempotencyRepository } from "../storage/sqlite-idempotency-repository.js";
import { PiAgentAdapter, type AgentSessionLike } from "../agent/pi-agent-adapter.js";

export type StartConfig = {
  host?: string;
  port: number;
  /** 服务数据库路径（SQLite）；默认 :memory:（仅测试）。 */
  dbPath?: string;
  /** 内网网段（来源 IP 命中即按 IP 识别身份，免 token）。 */
  intranetCidrs: string[];
  /** 公网 token → accountId 映射（pi-server 签发账号，仅公网使用）。 */
  tokens: Record<string, string>;
  /** Agent 工作目录（工具/仓库根）。 */
  cwd?: string;
  /** 启用工具列表（README §4.3：默认不启用 bash/edit/write）。 */
  tools?: string[];
  /** 服务数据目录（JSONL 会话 + 服务专用 agentDir + 凭证文件的父目录）。 */
  dataDir?: string;
  /** 服务专用 agentDir（默认 dataDir/.pi-agent），不继承个人 ~/.pi/agent。 */
  agentDir?: string;
  /** 服务端凭证文件路径（默认 agentDir/auth.json），不走个人 ~/.pi/agent/auth.json。 */
  authPath?: string;
  /** 服务端默认模型 provider（如 "openai-codex"/"deepseek"），配合 modelApiKey 注入。 */
  modelProvider?: string;
  /** 服务端默认模型 API key（环境变量 PI_MODEL_API_KEY 注入，运行时注入不落盘）。 */
  modelApiKey?: string;
  /** 固定系统提示词（默认一个最小占位；后续按已启用能力组合生成）。 */
  systemPrompt?: string;
  /** 可信代理 IP 列表（反代部署时配置；默认 false 只信 TCP 对端，避免伪造 IP 绕过内网免登录）。 */
  trustProxy?: string | string[] | boolean;
};

export async function startServer(config: StartConfig) {
  const cwd = config.cwd ?? process.cwd();
  const dataDir = config.dataDir ?? cwd;
  const agentDir = config.agentDir ?? path.join(dataDir, ".pi-agent");
  const authPath = config.authPath ?? path.join(agentDir, "auth.json");

  // 模型运行时：凭证读服务端独立 authPath（不读个人 ~/.pi/agent/auth.json）；
  // 服务端默认 API key 也可用 setRuntimeApiKey 运行时注入（不持久化，README §7）。
  // 目录关系：dataDir（会话 JSONL）→ agentDir = dataDir/.pi-agent（agent 配置）→ authPath = agentDir/auth.json（凭证），三者均可用环境变量覆盖。
  const modelRuntime = await ModelRuntime.create({
    authPath,
    modelsPath: path.join(agentDir, "models.json"),
  });
  if (config.modelProvider && config.modelApiKey) {
    await modelRuntime.setRuntimeApiKey(config.modelProvider, config.modelApiKey);
  }

  // 独立 agentDir + 禁用所有自动发现（README §7）：DefaultResourceLoader 默认会隐式扫描
  // 个人 ~/.pi/agent、项目 .pi/、AGENTS.md 等自动加载 extensions/skills/prompts/themes——
  // extensions 是代码，隐式加载是安全边界问题，必须关闭。pi-server 自己的 extension/skill
  // 由能力 manifest 显式声明后，经 additionalExtensionPaths / extensionFactories /
  // additionalSkillPaths 受控注入（阶段 2 能力扩展机制），而非自动发现。
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: config.systemPrompt ?? "你是 pi-server 的助手。",
  });
  await resourceLoader.reload();

  const db = new DatabaseSync(config.dbPath ?? ":memory:");
  const sessions = new SqliteSessionRepository(db);
  const idempotencyRepo = new SqliteIdempotencyRepository(db);

  const authenticate = buildAuthenticate({
    intranetCidrs: config.intranetCidrs,
    tokens: config.tokens,
  });

  const app = buildApp({
    sessions,
    authenticate,
    createAdapter: async (sessionId) => {
      // 会话持久化映射（重启恢复）：查该会话的 Pi JSONL 路径，有则恢复，无则懒创建并记录。
      const record = await sessions.get(sessionId);
      const sessionManager = record?.piSessionFile
        ? SessionManager.open(record.piSessionFile)
        : SessionManager.create(dataDir, path.join(dataDir, "sessions", sessionId));

      const { session } = await createAgentSession({
        sessionManager,
        modelRuntime,
        resourceLoader,
        settingsManager: SettingsManager.inMemory(),
        cwd,
        // 默认禁用所有内置工具（bash/edit/write/read）；仅当显式配置 TOOLS 时按 allowlist 开放。
        // 知识库问答等能力工具由 manifest 显式注入（阶段 2），不走内置工具。
        ...(config.tools && config.tools.length > 0
          ? { tools: config.tools }
          : { noTools: "all" as const }),
      });

      // 首次发消息时把 Pi 会话文件路径记到服务库，重启后据此恢复对话历史
      if (!record?.piSessionFile && session.sessionFile) {
        await sessions.update(sessionId, { piSessionFile: session.sessionFile });
      }

      // 真实 AgentSession 结构满足 AgentSessionLike，此处用断言隔离 SDK 事件完整类型与我们的子集类型
      return new PiAgentAdapter(session as unknown as AgentSessionLike);
    },
    trustProxy: config.trustProxy,
    idempotencyRepo,
    serverEpoch: randomUUID(),
  });

  await app.listen({ port: config.port, host: config.host ?? "127.0.0.1" });
  return app;
}
