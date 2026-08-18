// E2E 测试用的 mock pi-server：真实 buildApp + buildAuthenticate + MockAgentAdapter。
// 不依赖真实 Pi SDK 模型凭证，供 Playwright 端到端验证 HTTP/SSE 完整链路。

import { DatabaseSync } from "node:sqlite";
import { buildApp } from "../src/server/app.js";
import { buildAuthenticate } from "../src/server/real-auth.js";
import { SqliteSessionRepository } from "../src/storage/sqlite-session-repository.js";
import { SqliteProjectRepository } from "../src/storage/sqlite-project-repository.js";
import { MockAgentAdapter } from "../src/agent/mock-agent-adapter.js";

const PORT = Number(process.env.PORT ?? 8081);

const db = new DatabaseSync(":memory:");

// 外键约束要求 projects 先于 sessions，且默认项目落库（与 start.ts 一致）
const projects = new SqliteProjectRepository(db);
void projects.ensureDefaultProject({ id: "default", name: "默认项目", cwd: "/tmp/mock-project", ownerKey: "", createdAt: 0 });

const app = buildApp({
  sessions: new SqliteSessionRepository(db),
  projects,
  defaultProjectCwd: "/tmp/mock-project",
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
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "我是 pi-server 测试助手" },
      },
      { type: "agent_end", messages: [], willRetry: false },
    ]),
});

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`mock pi-server listening on http://127.0.0.1:${PORT}`);
