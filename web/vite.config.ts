import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Use client source during dev/tests; production typecheck consumes the root package declarations.
    alias: {
      "pi-agent-server/client": fileURLToPath(
        new URL("../src/client/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    // 强制绑定 IPv4，避免浏览器访问 127.0.0.1 时被 IPv6 ::1 监听拒绝
    host: "127.0.0.1",
    // 开发时把 /v1 代理到本地 pi-agent-server，避免 CORS
    proxy: {
      "/v1": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      "/health": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});
