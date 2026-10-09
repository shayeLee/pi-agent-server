import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.js";

// Never load the developer's .env.local or default/live proxy target.
export default mergeConfig(base, defineConfig({
  envDir: false,
  server: { proxy: {
    "/v1": { target: "http://127.0.0.1:5258", changeOrigin: true },
    "/health": { target: "http://127.0.0.1:5258", changeOrigin: true },
  } },
}));
