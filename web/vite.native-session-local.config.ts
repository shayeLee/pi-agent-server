import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.js";

// Each E2E group that runs its own server picks a dedicated port, so groups can run side by side.
const target = `http://127.0.0.1:${process.env.PI_E2E_API_PORT ?? "5258"}`;

// Never load the developer's .env.local or default/live proxy target.
export default mergeConfig(base, defineConfig({
  envDir: false,
  server: { proxy: {
    "/v1": { target, changeOrigin: true },
    "/health": { target, changeOrigin: true },
  } },
}));
