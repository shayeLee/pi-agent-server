#!/usr/bin/env node
// 进程入口：从环境变量读取配置，启动 pi-agent-server，处理优雅关闭信号。
//
// WP5D-2 网络准入：
// - PI_ALLOWED_CLIENT_CIDRS 显式必填（无默认），PI_IP_ACCESS_POLICY_FILE 可选（安全加载：
//   符号链接/权限/属主/大小/TOCTOU 全程校验）；PI_DEFAULT_WORKSPACE_ROOT 已移除（2026-02 用户
//   决策：内网不做 workspace 强制，workspace 安全延期至公网暴露前）；
// - 旧变量 INTRANET_CIDRS / TOKENS / TRUST_PROXY 一律拒绝启动（值不回显）；
// - 身份 = 直接 socket IP，不信任任何代理头；CIDR 外 / disabled → 403，/v1 tokenRequired → 401。

import { startServer, rejectLegacyStartEnv, type StorageDialect } from "./server/start.js";
import { parseIpAccessEnv } from "./core/ip-access-config.js";
import { loadIpAccessPolicy } from "./core/ip-access-policy-file.js";

// WP5D-2：旧启动变量拒绝（failfast，值不回显）：不再有「未配置即默认内网」的隐式语义。
rejectLegacyStartEnv(process.env);

// WP5D-2：严格解析准入环境变量 + 可选策略文件安全加载（任何缺失/非法配置 fail-fast）。
const ipAccessEnv = parseIpAccessEnv(process.env);
const ipAccessPolicy = loadIpAccessPolicy(ipAccessEnv);

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";

const tools = (process.env.TOOLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// PI_DEFAULT_MODEL="provider/modelId"；模型 id 可包含斜杠，仅第一个斜杠分隔 provider。
function parseDefaultModel(value: string | undefined): { provider: string; id: string } | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  const provider = value.slice(0, slash).trim();
  const id = value.slice(slash + 1).trim();
  if (slash <= 0 || !provider || !id) {
    throw new Error("PI_DEFAULT_MODEL 必须为 provider/modelId");
  }
  return { provider, id };
}

// 严格生产 migration 门禁（WP2A）：默认 off 保持 RC 行为；PI_MIGRATION_GATE=verify 启用启动前
// migration ledger/head 只读校验（不自动迁移/不自动 reset）；未知非空值 fail-fast。
function resolveMigrationGate(value: string | undefined): "off" | "verify" {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || trimmed === "off") return "off";
  if (trimmed === "verify") return "verify";
  throw new Error(`PI_MIGRATION_GATE 只支持 off / verify（当前值不回显），收到未知非空值时拒绝启动`);
}

const app = await startServer({
  port,
  host,
  // 存储方言（默认 sqlite，向后兼容）：PG 需显式 PI_STORAGE_DIALECT=postgres + PI_DATABASE_URL，
  // 否则走 SQLite；空/空白 PI_STORAGE_DIALECT 归一化为未配置（SQLite 默认），未知非空值 /
  // PG 缺 URL 在 startServer 内 fail-fast（不静默回退）。
  storageDialect: process.env.PI_STORAGE_DIALECT as StorageDialect | undefined,
  dbPath: process.env.DB_PATH,
  databaseUrl: process.env.PI_DATABASE_URL,
  ipAccess: {
    allowedClientCidrs: ipAccessEnv.allowedClientCidrs,
    policy: ipAccessPolicy,
  },
  cwd: process.env.AGENT_CWD,
  tools: tools.length > 0 ? tools : undefined,
  dataDir: process.env.DATA_DIR,
  agentDir: process.env.PI_AGENT_DIR,
  authPath: process.env.PI_AUTH_PATH,
  modelProvider: process.env.PI_MODEL_PROVIDER,
  modelApiKey: process.env.PI_MODEL_API_KEY,
  defaultModel: parseDefaultModel(process.env.PI_DEFAULT_MODEL),
  defaultThinkingLevel: process.env.PI_DEFAULT_THINKING_LEVEL as
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | undefined,
  systemPrompt: process.env.PI_SYSTEM_PROMPT,
  migrationGate: resolveMigrationGate(process.env.PI_MIGRATION_GATE),
});

app.log.info(`pi-agent-server listening on ${host}:${port}`);

// 优雅关闭：停止接收新请求，Fastify close 等在途请求完成（needs.md §4.2 优雅关闭的
// 完整版——在途任务超时、通知 SSE 客户端重连——在 Worker/SSE 治理步骤补齐）。
async function shutdown(signal: string): Promise<void> {
  app.log.info(`收到 ${signal}，开始优雅关闭`);
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    // needs.md §5.5：不记录原始异常对象，只记录错误消息摘要
    app.log.error({ err: error instanceof Error ? error.message : String(error) }, "优雅关闭失败");
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));