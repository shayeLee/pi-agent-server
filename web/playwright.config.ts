import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  // mock 后端是共享内存库，并行会导致状态竞争；串行保证隔离
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
  },
  webServer: [
    {
      // mock pi-agent-server（不依赖真实模型凭证），提供完整 HTTP/SSE 链路；
      // 小配额供 e2e 验证 SSE 连接配额与断线清理（每用户 2 / 全局 10）；
      // 允许浏览器从 vite(5173) 跨域直连 SSE（vite 代理对 hijack SSE 响应头转发不可靠）
      command: "MAX_SSE_PER_USER=2 MAX_SSE_GLOBAL=10 CORS_ORIGINS=http://127.0.0.1:5173 npx tsx ../scripts/mock-server.ts",
      url: "http://127.0.0.1:8081/health",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // vite dev，代理 /v1 与 /health 到 mock pi-agent-server
      command: "VITE_API_TARGET=http://127.0.0.1:8081 pnpm dev --port 5173 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
