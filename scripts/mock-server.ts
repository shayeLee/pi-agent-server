// E2E 测试用的 mock pi-server：真实 buildApp + buildAuthenticate + MockAgentAdapter。
// 不依赖真实 Pi SDK 模型凭证，供 Playwright 端到端验证 HTTP/SSE 完整链路。

import { DatabaseSync } from "node:sqlite";
import { buildApp } from "../src/server/app.js";
import { buildAuthenticate } from "../src/server/real-auth.js";
import { SqliteSessionRepository } from "../src/storage/sqlite-session-repository.js";
import { MockAgentAdapter } from "../src/agent/mock-agent-adapter.js";

const PORT = Number(process.env.PORT ?? 8081);

const app = buildApp({
  sessions: new SqliteSessionRepository(new DatabaseSync(":memory:")),
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
