import { defineConfig } from "@playwright/test";

/**
 * The general specs run in shards (see e2e-groups.ts), each with its own mock pi-agent-server and Vite
 * on dedicated ports. Specs that talk to the mock directly read its URL from PI_E2E_MOCK_API.
 */
export function generalConfig(ports: { web: number; mock: number }) {
  const web = `http://127.0.0.1:${ports.web}`;
  const mock = `http://127.0.0.1:${ports.mock}`;
  // Test workers inherit this environment.
  process.env.PI_E2E_MOCK_API = mock;
  return defineConfig({
    testDir: "./e2e",
    testIgnore: ["**/long-session-performance.spec.ts", "**/recent-session-restore.spec.ts"],
    timeout: 30_000,
    // mock 后端是共享内存库，并行会导致状态竞争；同一分片内串行保证隔离
    workers: 1,
    use: {
      browserName: "chromium",
      channel: "chrome",
      baseURL: web,
    },
    webServer: [
      {
        // mock pi-agent-server（不依赖真实模型凭证），提供完整 HTTP/SSE 链路；
        // 小配额供 e2e 验证 SSE 连接配额与断线清理（每用户 2 / 全局 10）；
        // 专用端口 + 禁止复用：绝不能把 E2E 请求写进正在运行的真实服务。
        command: `PORT=${ports.mock} MAX_SSE_PER_USER=2 MAX_SSE_GLOBAL=10 CORS_ORIGINS=${web} volta run npx tsx ../scripts/mock-server.ts`,
        url: `${mock}/health`,
        reuseExistingServer: false,
        timeout: 30_000,
      },
      {
        // vite dev，代理 /v1 与 /health 到 mock pi-agent-server
        command: `VITE_API_TARGET=${mock} volta run pnpm dev --port ${ports.web} --strictPort --host 127.0.0.1`,
        url: web,
        reuseExistingServer: false,
        timeout: 30_000,
      },
    ],
  });
}
