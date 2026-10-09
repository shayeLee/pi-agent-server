import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.js";
export default mergeConfig(base, defineConfig({ envDir: false, server: { proxy: {
  "/v1": { target: "http://127.0.0.1:5268", changeOrigin: true },
  "/health": { target: "http://127.0.0.1:5268", changeOrigin: true },
} } }));
