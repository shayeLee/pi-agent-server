// E2E 测试用的 mock pi-agent-server：真实 buildApp + buildAuthenticate + MockAgentAdapter。
// 不依赖真实 Pi SDK 模型凭证，供 Playwright 端到端验证 HTTP/SSE 完整链路。
//
// 存储层与生产（start.ts）一致：DatabaseSync（启用 FK）→ initializeDatabase → Kysely repositories，
// 默认项目确保必须 await（不能 fire-and-forget），幂等 Kysely destroy / DB 关闭在 app.close 与
// 启动失败路径执行。

import { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import { buildApp } from "../src/server/app.js";
import { buildAuthenticate } from "../src/server/real-auth.js";
import { initializeDatabase } from "../src/storage/bootstrap.js";
import { sqliteConstraintErrorMapper } from "../src/storage/sqlite-constraint-errors.js";
import type { DatabaseSchema } from "../src/storage/db-schema.js";
import { createIdempotentStorageCloser } from "../src/server/storage-close.js";
import { KyselySessionRepository } from "../src/storage/kysely-session-repository.js";
import { KyselyProjectRepository } from "../src/storage/kysely-project-repository.js";
import { KyselyIdempotencyRepository } from "../src/storage/kysely-idempotency-repository.js";
import { KyselyFileOperationRepository } from "../src/storage/kysely-file-operation-repository.js";
import { relativeWhitelistedPath } from "../src/storage/file-operation-policy.js";
import { DEFAULT_PROJECT_ID } from "../src/application/ports/project-store-port.js";
import { MockAgentAdapter } from "../src/agent/mock-agent-adapter.js";

const PORT = Number(process.env.PORT ?? 8081);
const MOCK_CWD = "/tmp/mock-project";
const MOCK_SEED = {
  // 默认项目 seed 与生产（start.ts）一致，引用同一 DEFAULT_PROJECT_ID 常量，不硬编码字符串。
  id: DEFAULT_PROJECT_ID,
  name: "默认项目",
  cwd: MOCK_CWD,
  ownerKey: "",
  createdAt: 0,
};

// 外键约束要求 projects 先于 sessions，且默认项目落库（与 start.ts 一致，await 而非 fire-and-forget）。
const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
let kysely: Kysely<DatabaseSchema> | null = null;
const closeStorage = createIdempotentStorageCloser(async () => {
  if (kysely) await kysely.destroy();
});

let app;
try {
  kysely = await initializeDatabase(db);
  // mock 保持 SQLite memory（与生产 start.ts 的 dialect 组合根同一套中立 Repository + SQLite mapper）。
  const fileOperations = new KyselyFileOperationRepository(kysely, "sqlite");
  const fileOperationOptions = {
    fileOperations,
    relativePath: (filePath: string) => relativeWhitelistedPath(MOCK_CWD, filePath),
  } as const;
  const projects = new KyselyProjectRepository(kysely, sqliteConstraintErrorMapper, fileOperationOptions);
  await projects.ensureDefaultProject(MOCK_SEED);
  const sessions = new KyselySessionRepository(kysely, sqliteConstraintErrorMapper, fileOperationOptions);
  const idempotencyRepo = new KyselyIdempotencyRepository(kysely);

  app = buildApp({
    sessions,
    projects,
    defaultProjectCwd: MOCK_CWD,
    idempotencyRepo,
    // SSE 连接配额可从环境变量覆盖，便于 e2e 用小值验证配额/断线清理。
    maxSsePerUser: Number(process.env.MAX_SSE_PER_USER ?? 10),
    maxSseGlobal: Number(process.env.MAX_SSE_GLOBAL ?? 100),
    authenticate: buildAuthenticate({
      intranetCidrs: ["10.0.0.0/8", "127.0.0.0/8"],
      tokens: { "e2e-token": "e2e-user" },
    }),
    createAdapter: async () =>
      new MockAgentAdapter([
        { type: "agent_start" },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好，" },
        },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "我是 pi-agent-server 测试助手" },
        },
        { type: "agent_end", messages: [], willRetry: false },
      ]),
  });
  app.addHook("onClose", closeStorage);

  await app.listen({ port: PORT, host: "127.0.0.1" });
} catch (error) {
  // 启动失败：幂等销毁 Kysely/DatabaseSync 后再退出，避免残留连接。
  // 原始启动错误是退出原因，必须保留并输出；清理失败单独记录，不覆盖原始错误。
  try {
    await closeStorage();
  } catch (cleanupError) {
    console.error("mock 启动失败路径 storage close 失败:", cleanupError);
  }
  console.error("mock pi-agent-server 启动失败:", error);
  process.exit(1);
}

console.log(`mock pi-agent-server listening on http://127.0.0.1:${PORT}`);

// 优雅关闭：app.close() 会触发 onClose（幂等销毁 Kysely/DatabaseSync）。
async function shutdown(signal: string): Promise<void> {
  console.log(`mock 收到 ${signal}，开始关闭`);
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error("mock 优雅关闭失败:", error);
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
