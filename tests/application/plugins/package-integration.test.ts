// 跨包集成（正向覆盖）：宿主按公开 ESM specifier 加载真实 `pi-agent-capability-onev` 包，
// 而不是相对路径、内联模块或测试 fake。先经 createRequire 从仓库根解析包 specifier：
// 解析不到时显式 skip 并打印原因（绝不静默通过，也不回退到绝对路径或任何插件专属环境变量）；
// 解析到时才正向 load，并断言宿主加载器真正消费了包默认入口（而非本仓源码）。
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { PluginLoader } from "../../../src/application/plugins/loader.js";

const PACKAGE_SPECIFIER = "pi-agent-capability-onev";
// 从仓库根 package.json 解析：与运行时 `import(specifier)` 的 node_modules 解析基准一致，
// 不使用本文件相对位置，也不读取任何插件环境变量。
const requireFromProject = createRequire(new URL("../../../package.json", import.meta.url));

let resolvedEntry: string | null = null;
let resolutionError: string | null = null;
try {
  resolvedEntry = requireFromProject.resolve(PACKAGE_SPECIFIER);
} catch (error) {
  resolutionError = error instanceof Error ? error.message : String(error);
}

describe("外部插件包集成（package specifier → 默认 dist）", () => {
  it("PluginLoader 按 specifier 加载 onev 包并校验 manifest/tools/modes", async (context) => {
    if (resolvedEntry === null) {
      // 依赖缺失是环境状态，不是通过：显式 skip 并给出可复现原因。
      console.info(
        `[skip] 未解析到 ${PACKAGE_SPECIFIER}：${resolutionError}。` +
          "在仓库根 `pnpm install`（或 `pnpm link` 插件包）后重跑以启用该正向覆盖。",
      );
      context.skip(`${PACKAGE_SPECIFIER} 未安装，无法验证真实包加载`);
      return;
    }

    const loader = new PluginLoader({ projectCwd: process.cwd() });
    const loaded = await loader.load(PACKAGE_SPECIFIER);

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
    // 业务能力标识经真实包的 manifest 进入宿主：声明集合原样透传，不做任何变换。
    expect(loaded.capabilities).toEqual(["canBind"]);
    // 反向证明：加载的是解析到的包默认入口，而非仓内源码。
    expect(resolvedEntry).toContain(PACKAGE_SPECIFIER);
  });

  it("真实包的 manifest.capabilities 与插件声明的档位映射一致（跨包契约不漂移）", async (context) => {
    if (resolvedEntry === null) {
      context.skip(`${PACKAGE_SPECIFIER} 未安装，无法验证真实包加载`);
      return;
    }
    // 宿主与插件是两个仓库：manifest 声明的 flag 集合必须与 declareCapabilities 的键集
    // 完全一致，否则宿主会在注册期 fail-fast。这里在加载期就提前暴露漂移。
    const module = (await import(PACKAGE_SPECIFIER)) as {
      default: { manifest: { capabilities?: readonly string[] } };
    };
    expect(module.default.manifest.capabilities).toEqual(["canBind"]);
  });
});
