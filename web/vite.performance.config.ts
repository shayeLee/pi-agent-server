import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.js";

// Isolated, instrumented App build; never changes the shipped entry or bundle.
export default mergeConfig(base, defineConfig({
  envDir: false,
  resolve: { alias: { "react-dom/client": "react-dom/profiling" } },
  build: { outDir: "/tmp/web-long-session-performance/build", emptyOutDir: true },
  server: { proxy: { "/v1": { target: "http://127.0.0.1:8119" } } },
  plugins: [{ name: "fixture-render-counts", enforce: "pre", transform(source, id) {
    if (!id.includes("/web/src/")) return;
    const names = ["App", "Chat", "Timeline", "MessageItem", "ToolCallCard", "Markdown", "CodeBlock", "Composer"];
    let code = source;
    for (const name of names) code = code.replace(new RegExp(`(function ${name}\\([\\s\\S]*?\\)\\s*\\{)`), `$1\n globalThis.__perfCounts["${name}"] = (globalThis.__perfCounts["${name}"] || 0) + 1;`);
    if (id.endsWith("/main.tsx")) code = code.replace('import { StrictMode }', 'import { Profiler, StrictMode }').replace('<App />', '<Profiler id="App" onRender={(_id, phase, actualDuration) => globalThis.__perfCommits.push({ phase, actualDuration, at: performance.now() })}><App /></Profiler>');
    return code;
  } }],
}));
