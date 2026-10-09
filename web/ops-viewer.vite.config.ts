import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import path from "node:path";

// Resolve the grammars supplied by lowlight without depending on pnpm hoisting.
const lowlightRequire = createRequire(createRequire(import.meta.url).resolve("lowlight"));

// Isolated build: does not touch the regular web/dist app or the public /v1 API.
export default defineConfig({
  plugins: [react()],
  root: path.resolve(import.meta.dirname, "ops-viewer"),
  base: "/",
  resolve: {
    alias: {
      "highlight.js/lib/languages": dirname(lowlightRequire.resolve("highlight.js/lib/languages/javascript")),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist-ops-viewer"),
    emptyOutDir: true,
  },
});
