// 显式 provider 扩展接入：纯函数 + 真实 SDK 加载路径（不启动服务、不触网）。
//
// 覆盖：
// - resolveProviderExtensionPaths：空白忽略、`~/` 展开、相对路径 fail-fast、保序去重；
// - assertProviderExtensionsLoaded：加载失败（路径不存在/模块抛错/非工厂导出）即拒绝，
//   且错误消息含路径与原因、不含任何凭证；配置目录没有任何入口（空目录/manifest 入口缺失）同样
//   fail-fast（SDK 不报错也不加载）；
// - flushProviderRegistrations：扩展排队的 provider 注册真正进入 ModelRuntime（getModel 可见），
//   且队列被清空（不会在 createAgentSession 里二次注册）；
// - loadSessionResourceLoader：扩展加载 cwd 稳定（项目 cwd 交替不清扩展模块缓存、不重放模块级
//   副作用）；冻结字面量 override 显式关闭 APPEND_SYSTEM.md 自动发现（文件变化仍冻结字面量）；
// - DefaultResourceLoader(noExtensions:true, additionalExtensionPaths:[...]) 的加载是显式且封闭的：
//   不显式配置时不加载任何外部扩展。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProviderExtensionsLoaded,
  flushProviderRegistrations,
  loadSessionResourceLoader,
  resolveProviderExtensionPaths,
} from "../../src/server/provider-extensions.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-provider-ext-"));
  cleanups.push(dir);
  return dir;
}

/** 写一个最小 provider 扩展 fixture（注册 provider + 两个 provider hook）。返回其目录。 */
function writeProviderExtensionFixture(root: string, providerId: string, modelId: string): string {
  const extensionDir = join(root, "fixture");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(join(extensionDir, "package.json"), JSON.stringify({
    name: "pi-provider-extension-fixture",
    version: "1.0.0",
    type: "module",
    pi: { extensions: ["./extensions"] },
  }));
  mkdirSync(join(extensionDir, "extensions"), { recursive: true });
  writeFileSync(join(extensionDir, "extensions", "provider.ts"), `
export default function (pi) {
  pi.registerProvider(${JSON.stringify(providerId)}, {
    name: "Fixture Provider",
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture-key",
    api: "openai-completions",
    models: [{
      id: ${JSON.stringify(modelId)},
      name: "Fixture Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }],
  });
  pi.on("before_provider_request", (event) => ({ ...event.payload, fixtureMark: true }));
  pi.on("before_provider_headers", (event) => { event.headers["X-Fixture-Provider"] = "1"; });
}
`);
  return extensionDir;
}

async function makeRuntime(root: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
  });
}

function makeLoader(root: string, additionalExtensionPaths: readonly string[] = []): DefaultResourceLoader {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  return new DefaultResourceLoader({
    cwd: root,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(additionalExtensionPaths.length > 0 ? { additionalExtensionPaths: [...additionalExtensionPaths] } : {}),
  });
}

describe("resolveProviderExtensionPaths", () => {
  it("未配置/空白项归一化为空，不加载任何扩展", () => {
    expect(resolveProviderExtensionPaths(undefined)).toEqual([]);
    expect(resolveProviderExtensionPaths([])).toEqual([]);
    expect(resolveProviderExtensionPaths(["", "   ", "\t"])).toEqual([]);
  });

  it("展开 ~/ 前缀，保留绝对路径，保序去重", () => {
    const paths = resolveProviderExtensionPaths(["~/pkg-a", "/opt/pkg-b", "~/pkg-a", "/opt/pkg-b"]);
    expect(paths).toHaveLength(2);
    expect(paths[0]!.endsWith("/pkg-a")).toBe(true);
    expect(paths[0]!.startsWith("/")).toBe(true);
    expect(paths[0]!.startsWith("~")).toBe(false);
    expect(paths[1]).toBe("/opt/pkg-b");
  });

  it("相对路径 fail-fast（不回显以外的静默行为），错误消息不回显为已展开的机密路径", () => {
    expect(() => resolveProviderExtensionPaths(["./relative-extension"])).toThrow(/must be absolute/);
    expect(() => resolveProviderExtensionPaths(["relative-extension"])).toThrow(/must be absolute/);
  });
});

describe("显式 provider 扩展加载（真实 SDK ResourceLoader）", () => {
  it("显式配置：扩展加载成功，排队的 provider 注册被刷进 ModelRuntime", async () => {
    const root = makeTempDir();
    const extensionDir = writeProviderExtensionFixture(root, "fixture-provider", "fixture-model");
    const runtime = await makeRuntime(root);
    const loader = makeLoader(root, [extensionDir]);

    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    // 加载阶段：provider 注册仍排在扩展运行时队列里（SDK 语义），尚未进入 ModelRuntime。
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
    expect(loader.getExtensions().runtime.pendingProviderRegistrations.map((entry) => entry.name)).toEqual([
      "fixture-provider",
    ]);

    const registered = flushProviderRegistrations(runtime, loader);
    expect(registered).toEqual(["fixture-provider"]);
    expect(runtime.getRegisteredProviderIds()).toContain("fixture-provider");
    expect(runtime.getModel("fixture-provider", "fixture-model")?.id).toBe("fixture-model");
    // 队列已清空：createAgentSession 内部 flush 不会重复注册。
    expect(loader.getExtensions().runtime.pendingProviderRegistrations).toEqual([]);
  });

  it("显式配置的扩展已注册 provider 后，createAgentSession 可直接选用该 provider 的模型", async () => {
    const root = makeTempDir();
    const extensionDir = writeProviderExtensionFixture(root, "fixture-provider", "fixture-model");
    const runtime = await makeRuntime(root);
    const loader = makeLoader(root, [extensionDir]);
    await loader.reload();
    flushProviderRegistrations(runtime, loader);

    const model = runtime.getModel("fixture-provider", "fixture-model");
    expect(model).toBeDefined();
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(root),
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager: SettingsManager.inMemory(),
      cwd: root,
      model,
      tools: [],
    });
    try {
      expect(session.model?.provider).toBe("fixture-provider");
      expect(session.model?.id).toBe("fixture-model");
    } finally {
      session.dispose();
    }
  });

  it("显式配置的扩展 provider hooks 绑到真实会话（before_provider_request / before_provider_headers）", async () => {
    const root = makeTempDir();
    const extensionDir = writeProviderExtensionFixture(root, "fixture-provider", "fixture-model");
    const runtime = await makeRuntime(root);
    const loader = makeLoader(root, [extensionDir]);
    await loader.reload();
    flushProviderRegistrations(runtime, loader);

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(root),
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager: SettingsManager.inMemory(),
      cwd: root,
      model: runtime.getModel("fixture-provider", "fixture-model"),
      tools: [],
    });
    try {
      // hooks 由 host 经真实会话的 ExtensionRunner 触发（sdk.js 的 onPayload / transformHeaders 路径）。
      const payload = await session.extensionRunner.emitBeforeProviderRequest({ model: "fixture-model" });
      expect(payload).toMatchObject({ model: "fixture-model", fixtureMark: true });
      const headers = await session.extensionRunner.emitBeforeProviderHeaders({});
      expect(headers["X-Fixture-Provider"]).toBe("1");
    } finally {
      session.dispose();
    }
  });

  it("未显式配置：noExtensions 之外的位置不会被加载（不自动发现）", async () => {
    const root = makeTempDir();
    // 把扩展放到 agentDir/extensions（Pi 默认自动发现位置）；noExtensions:true 必须忽略它。
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "auto-discovered.ts"),
      "export default function (pi) { pi.registerProvider('auto', { baseUrl: 'https://auto.invalid/v1', apiKey: 'k', api: 'openai-completions', models: [] }); }\n",
    );

    const runtime = await makeRuntime(root);
    const loader = makeLoader(root, []);
    await loader.reload();

    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getExtensions().runtime.pendingProviderRegistrations).toEqual([]);
    flushProviderRegistrations(runtime, loader);
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
  });

  it("显式配置但加载失败：路径不存在 / 模块抛错 / 非工厂导出 → 拒绝启动", async () => {
    const root = makeTempDir();
    // 扩展错误文本里带一个契合成凭证的标记：宿主一律不透传，只回显自己配置的路径。
    const secret = "SYNTHETIC-SECRET-8f3a1c";
    const brokenFile = join(root, "broken.ts");
    writeFileSync(brokenFile, `export default function () { throw new Error(${JSON.stringify(`fixture boom apiKey=${secret}`)}); }\n`);
    const notFactory = join(root, "not-a-factory.ts");
    writeFileSync(notFactory, "export const value = 1;\n");
    const missing = join(root, "missing-extension");

    const loader = makeLoader(root, [brokenFile, notFactory, missing]);
    await loader.reload();
    const errors = loader.getExtensions().errors;
    expect(errors).toHaveLength(3);

    let message = "";
    try {
      assertProviderExtensionsLoaded(loader, [brokenFile, notFactory, missing]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      // 脱敏：既不透传 SDK/扩展原文，也不附带 cause。
      expect((error as Error).cause).toBeUndefined();
    }
    expect(message).toMatch(/provider extension failed to load/);
    // 只报告宿主自己配置的路径（凭证与 SDK 原文一律不出现）。
    for (const path of [brokenFile, notFactory, missing]) expect(message).toContain(path);
    expect(message).not.toContain(secret);
    expect(message).not.toContain("fixture boom");
    expect(message).not.toContain("does not exist");
    expect(message).not.toMatch(/auth|token|apiKey/i);
  });

  it("全部加载成功时 assertProviderExtensionsLoaded 不抛错", async () => {
    const root = makeTempDir();
    const extensionDir = writeProviderExtensionFixture(root, "fixture-provider", "fixture-model");
    const loader = makeLoader(root, [extensionDir]);
    await loader.reload();
    expect(() => assertProviderExtensionsLoaded(loader, [extensionDir])).not.toThrow();
  });

  it("未产出任何入口：空目录 / manifest 入口缺失 / 空 extensions 子目录都 fail-fast（SDK 不报错也不加载）", async () => {
    const root = makeTempDir();
    // 0) 完全空目录：SDK 把目录当模块导入而报错 → 走 errors 分支 fail-fast。
    const emptyDir = join(root, "empty-dir");
    mkdirSync(emptyDir, { recursive: true });
    const emptyDirLoader = makeLoader(root, [emptyDir]);
    await emptyDirLoader.reload();
    expect(emptyDirLoader.getExtensions().errors.length).toBeGreaterThan(0);
    expect(() => assertProviderExtensionsLoaded(emptyDirLoader, [emptyDir]))
      .toThrow(/provider extension failed to load/);

    // 1) manifest 声明 pi.extensions 指向不存在的入口：SDK 既不报错也不加载。
    const missingEntry = join(root, "missing-entry");
    mkdirSync(missingEntry, { recursive: true });
    writeFileSync(join(missingEntry, "package.json"), JSON.stringify({
      name: "missing-entry-fixture",
      version: "1.0.0",
      pi: { extensions: ["./extensions"] },
    }));
    // 2) 有 extensions/ 子目录但完全为空：同样既不报错也不加载。
    const emptyExtensions = join(root, "empty-extensions");
    mkdirSync(join(emptyExtensions, "extensions"), { recursive: true });
    writeFileSync(join(emptyExtensions, "package.json"), JSON.stringify({
      name: "empty-extensions-fixture",
      version: "1.0.0",
      pi: { extensions: ["./extensions"] },
    }));

    for (const configured of [missingEntry, emptyExtensions]) {
      const loader = makeLoader(root, [configured]);
      await loader.reload();
      // 前提证据：SDK 本身完全不报错，也不会加载任何扩展入口。
      expect(loader.getExtensions().errors).toEqual([]);
      expect(loader.getExtensions().extensions).toEqual([]);

      let message = "";
      try {
        assertProviderExtensionsLoaded(loader, [configured]);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
        expect((error as Error).cause).toBeUndefined();
      }
      expect(message).toMatch(/provider extension failed to load/);
      expect(message).toContain(configured);
      // 脱敏：只回显宿主自己的路径，不透传 SDK 原文。
      expect(message).not.toContain("Cannot find module");
      expect(message).not.toMatch(/auth|token|apiKey/i);
    }
  });

  it("配置了多个路径时只报未覆盖的路径，成功路径不误报", async () => {
    const root = makeTempDir();
    const goodDir = writeProviderExtensionFixture(root, "fixture-provider", "fixture-model");
    const emptyDir = join(root, "empty-extensions");
    mkdirSync(join(emptyDir, "extensions"), { recursive: true });
    writeFileSync(join(emptyDir, "package.json"), JSON.stringify({
      name: "empty-extensions-fixture",
      version: "1.0.0",
      pi: { extensions: ["./extensions"] },
    }));

    const loader = makeLoader(root, [goodDir, emptyDir]);
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);

    let message = "";
    try {
      assertProviderExtensionsLoaded(loader, [goodDir, emptyDir]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(emptyDir);
    expect(message).not.toContain(goodDir);
  });

  it("provider 注册非法（streamSimple 缺 api）→ flush 失败即拒绝启动，不回显凭证", async () => {
    const root = makeTempDir();
    const secret = "SYNTHETIC-SECRET-4b7d2e";
    const extensionDir = join(root, "bad-provider");
    mkdirSync(join(extensionDir, "extensions"), { recursive: true });
    writeFileSync(join(extensionDir, "package.json"), JSON.stringify({
      name: "bad-provider-fixture",
      version: "1.0.0",
      pi: { extensions: ["./extensions"] },
    }));
    // ModelRuntime 会因为 streamSimple 缺 api 拒绝注册；错误里带合成凭证标记，不得回显。
    writeFileSync(
      join(extensionDir, "extensions", "bad.ts"),
      `export default function (pi) { pi.registerProvider('bad', { streamSimple: () => { throw new Error(${JSON.stringify(`nope ${secret}`)}); }, apiKey: ${JSON.stringify(secret)} }); }\n`,
    );

    const runtime = await makeRuntime(root);
    const loader = makeLoader(root, [extensionDir]);
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);

    let message = "";
    try {
      flushProviderRegistrations(runtime, loader);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      expect((error as Error).cause).toBeUndefined();
    }
    expect(message).toMatch(/failed to register provider "bad"/);
    // 脱敏断言：不回显 SDK 原文与任何凭证（含扩展自报的 apiKey）。
    expect(message).not.toContain(secret);
    expect(message).not.toContain("api is required");
    expect(message).not.toMatch(/auth|token|key/i);
  });
});

describe("loadSessionResourceLoader：扩展加载 cwd 与项目提示词 cwd 解耦", () => {
  /**
   * 写一个模块级副作用探针扩展：模块求值 + 包一层 fake fetch。
   * 计数写在 globalThis 的专用 key 上，避免与其它测试互相污染；不触真实 fetch。
   */
  function writeSideEffectExtension(root: string, probeKey: string): string {
    const extensionDir = join(root, "side-effect-extension");
    mkdirSync(join(extensionDir, "extensions"), { recursive: true });
    writeFileSync(join(extensionDir, "package.json"), JSON.stringify({
      name: "pi-provider-extension-side-effect-fixture",
      version: "1.0.0",
      type: "module",
      pi: { extensions: ["./extensions"] },
    }));
    writeFileSync(join(extensionDir, "extensions", "side-effect.ts"), `
const KEY = ${JSON.stringify(probeKey)};
const state = globalThis[KEY] ?? { moduleEvaluations: 0, fetchWrappers: 0 };
globalThis[KEY] = state;
// 模拟 WorkBuddy 的模块级副作用：缓存 miss 时会重放。
state.moduleEvaluations += 1;
state.fetchWrappers += 1;
export default function (pi) {
  pi.registerProvider('probe-provider', {
    baseUrl: 'https://probe.invalid/v1', apiKey: 'k', api: 'openai-completions', models: [],
  });
}
`);
    return extensionDir;
  }

  function sideEffectProbe(probeKey: string): { moduleEvaluations: number; fetchWrappers: number } {
    return ((globalThis as Record<string, unknown>)[probeKey] as { moduleEvaluations: number; fetchWrappers: number } | undefined)
      ?? { moduleEvaluations: 0, fetchWrappers: 0 };
  }

  it("同一 extensionCwd 下反复 new loader（项目 cwd 交替）不会重评估扩展模块、不会重复包装 fetch", async () => {
    const root = makeTempDir();
    const probeKey = `__piExtCwdProbe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const extensionDir = writeSideEffectExtension(root, probeKey);
    const runtime = await makeRuntime(root);
    const serviceCwd = join(root, "service");
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    for (const dir of [serviceCwd, projectA, projectB]) mkdirSync(dir, { recursive: true });

    // 真实 start.ts 的 loader 序列：startup 探针(service) → 项目探针 A → 项目探针 B → 冻结会话。
    // 项目 cwd 只交给 createAgentSession({ cwd })，绝不传给 ResourceLoader。
    for (const sessionCwd of [serviceCwd, projectA, projectB, projectA, serviceCwd]) {
      const loader = await loadSessionResourceLoader(runtime, {
        extensionCwd: serviceCwd,
        agentDir: join(root, "agent"),
        providerExtensionPaths: [extensionDir],
      });
      // 会话 cwd 可以与扩展加载 cwd 不同，提示词中的 Current working directory 取会话 cwd。
      const { session } = await createAgentSession({
        sessionManager: SessionManager.inMemory(sessionCwd),
        modelRuntime: runtime,
        resourceLoader: loader,
        settingsManager: SettingsManager.inMemory(),
        cwd: sessionCwd,
        tools: [],
      });
      try {
        expect(session.systemPrompt).toContain(`Current working directory: ${sessionCwd}`);
      } finally {
        session.dispose();
      }
    }

    // 模块只求值一次、fetch 只包一层：每一次 new loader 只重跑工厂函数。
    expect(sideEffectProbe(probeKey)).toEqual({ moduleEvaluations: 1, fetchWrappers: 1 });
  });

  it("对照：扩展加载 cwd 交替会让 SDK 清缓存并重放模块级副作用（这正是解耦要避免的）", async () => {
    const root = makeTempDir();
    const probeKey = `__piExtCwdProbe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const extensionDir = writeSideEffectExtension(root, probeKey);
    const runtime = await makeRuntime(root);
    const serviceCwd = join(root, "service");
    const projectA = join(root, "project-a");
    for (const dir of [serviceCwd, projectA]) mkdirSync(dir, { recursive: true });

    for (const extensionCwd of [serviceCwd, projectA, serviceCwd]) {
      await loadSessionResourceLoader(runtime, {
        extensionCwd,
        agentDir: join(root, "agent"),
        providerExtensionPaths: [extensionDir],
      });
    }

    // 3 次 new loader + 2 次 cwd 变化 → 3 次模块求值与 3 层 fetch 包装。
    expect(sideEffectProbe(probeKey)).toEqual({ moduleEvaluations: 3, fetchWrappers: 3 });
  });
});

describe("loadSessionResourceLoader：冻结提示词字面量不受 APPEND_SYSTEM.md 自动发现影响", () => {
  it("systemPromptOverride 分支不传 appendSystemPrompt 时也不会自动追加 agentDir/APPEND_SYSTEM.md", async () => {
    const root = makeTempDir();
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const appendPath = join(agentDir, "APPEND_SYSTEM.md");
    writeFileSync(appendPath, "APPEND-BEFORE-MARKER");
    const runtime = await makeRuntime(root);
    const frozen = "FROZEN-LITERAL-PROMPT";

    const loader = await loadSessionResourceLoader(runtime, {
      extensionCwd: root,
      agentDir,
      systemPromptOverride: () => frozen,
    });
    expect(loader.getAppendSystemPrompt()).toEqual([]);

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(root),
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager: SettingsManager.inMemory(),
      cwd: root,
      tools: [],
    });
    try {
      expect(session.systemPrompt).toContain(frozen);
      expect(session.systemPrompt).not.toContain("APPEND-BEFORE-MARKER");
    } finally {
      session.dispose();
    }

    // 磁盘上的 APPEND_SYSTEM.md 变化后重新构造 loader：冻结字面量仍不变、仍不追加。
    writeFileSync(appendPath, "APPEND-AFTER-MARKER");
    const reloaded = await loadSessionResourceLoader(runtime, {
      extensionCwd: root,
      agentDir,
      systemPromptOverride: () => frozen,
    });
    expect(reloaded.getAppendSystemPrompt()).toEqual([]);
    const { session: second } = await createAgentSession({
      sessionManager: SessionManager.inMemory(root),
      modelRuntime: runtime,
      resourceLoader: reloaded,
      settingsManager: SettingsManager.inMemory(),
      cwd: root,
      tools: [],
    });
    try {
      expect(second.systemPrompt).toContain(frozen);
      expect(second.systemPrompt).not.toContain("APPEND-AFTER-MARKER");
    } finally {
      second.dispose();
    }
  });
});
