import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["**/long-session-performance.spec.ts", "**/recent-session-restore.spec.ts"],
  timeout: 30_000,
  // mock 后端是共享内存库，并行会导致状态竞争；串行保证隔离
  workers: 1,
  use: {
    browserName: "chromium",
    channel: "chrome",
    baseURL: "http://127.0.0.1:5189",
  },
  webServer: [
    {
      // mock pi-agent-server（不依赖真实模型凭证），提供完整 HTTP/SSE 链路；
      // 小配额供 e2e 验证 SSE 连接配额与断线清理（每用户 2 / 全局 10）；
      // 专用端口 + 禁止复用：绝不能把 E2E 请求写进正在运行的真实服务。
      command: "PORT=8089 MAX_SSE_PER_USER=2 MAX_SSE_GLOBAL=10 CORS_ORIGINS=http://127.0.0.1:5189 volta run npx tsx ../scripts/mock-server.ts",
      url: "http://127.0.0.1:8089/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // vite dev，代理 /v1 与 /health 到 mock pi-agent-server
      command: "VITE_API_TARGET=http://127.0.0.1:8089 volta run pnpm dev --port 5189 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5189",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
