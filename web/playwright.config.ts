import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
  },
  webServer: [
    {
      // mock pi-server（不依赖真实模型凭证），提供完整 HTTP/SSE 链路
      command: "npx tsx ../scripts/mock-server.ts",
      url: "http://127.0.0.1:8081/health",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // vite dev，代理 /v1 与 /health 到 mock pi-server
      command: "VITE_API_TARGET=http://127.0.0.1:8081 pnpm dev --port 5173 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
