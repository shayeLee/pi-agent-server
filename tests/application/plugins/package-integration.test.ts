// 跨包集成：宿主按公开 ESM specifier 加载真实 `pi-agent-capability-onev` 包
// （node_modules 中的本地链接 → 插件包默认 dist）。此测试直接验证宿主加载器能消费
// 包默认入口（而非相对路径或内联模块），确保发布出去的 dist 契约真实可用。
import { describe, expect, it } from "vitest";
import { PluginLoader } from "../../../src/application/plugins/loader.js";

describe("外部插件包集成（package specifier → 默认 dist）", () => {
  it("PluginLoader 按 specifier 加载 onev 包并校验 manifest/tools/modes", async () => {
    const loader = new PluginLoader({ projectCwd: process.cwd() });
    const loaded = await loader.load("pi-agent-capability-onev");

    expect(loaded.manifest.id).toBe("onev");
    expect(loaded.manifest.version).toBe(1);
    expect(loaded.manifest.name).toBe("onev 知识库");
    expect(loaded.tools.map((tool) => tool.name).sort()).toEqual(["gitnexus", "vue2-index"]);
    expect(loaded.modes.map((mode) => mode.id)).toEqual([
      "usage-principles",
      "design-guidelines",
      "interactive-prototype",
    ]);
    // 阶段一不产生副作用：加载只是解析与校验，register/dispose 不会被调用。
    expect(typeof loaded.plugin.register).toBe("function");
    expect(typeof loaded.plugin.dispose).toBe("function");
  });
});
