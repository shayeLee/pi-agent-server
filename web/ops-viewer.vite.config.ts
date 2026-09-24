import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Isolated build: does not touch the regular web/dist app or the public /v1 API.
export default defineConfig({
  plugins: [react()],
  root: path.resolve(import.meta.dirname, "ops-viewer"),
  base: "/",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist-ops-viewer"),
    emptyOutDir: true,
  },
});
