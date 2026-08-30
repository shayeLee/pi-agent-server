#!/usr/bin/env node
// 进程入口：从环境变量读取配置，启动 pi-agent-server，处理优雅关闭信号。

import { startServer, type StorageDialect } from "./server/start.js";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";

const intranetCidrs = (process.env.INTRANET_CIDRS ?? "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 公网 token → accountId：TOKENS="token1:acct1,token2:acct2"
const tokens: Record<string, string> = {};
for (const pair of (process.env.TOKENS ?? "").split(",")) {
  const idx = pair.indexOf(":");
  if (idx > 0) {
    const token = pair.slice(0, idx).trim();
    const accountId = pair.slice(idx + 1).trim();
    if (token && accountId) tokens[token] = accountId;
  }
}

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

// 可信代理 IP 列表（反代部署时配置；默认不信任，只信 TCP 对端）
const trustProxy = process.env.TRUST_PROXY
  ? process.env.TRUST_PROXY.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : undefined;

const app = await startServer({
  port,
  host,
  // 存储方言（默认 sqlite，向后兼容）：PG 需显式 PI_STORAGE_DIALECT=postgres + PI_DATABASE_URL，
  // 否则走 SQLite；空/空白 PI_STORAGE_DIALECT 归一化为未配置（SQLite 默认），未知非空值 /
  // PG 缺 URL 在 startServer 内 fail-fast（不静默回退）。
  storageDialect: process.env.PI_STORAGE_DIALECT as StorageDialect | undefined,
  dbPath: process.env.DB_PATH,
  databaseUrl: process.env.PI_DATABASE_URL,
  intranetCidrs,
  tokens,
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
  trustProxy,
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
