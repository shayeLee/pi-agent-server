// startServer 显式 provider 扩展接入（真实 composition root，不触网）：
// - 显式配置 providerExtensionPaths：扩展注册的 provider 进入宿主 ModelRuntime，因此
//   PI_DEFAULT_MODEL 指向该 provider 时启动成功，/v1/models 目录也能列出它；
// - 未显式配置：同一默认模型即「不可用」并拒绝启动，证明没有自动发现/隐式加载；
// - 显式配置但加载失败（路径不存在）→ 在任何存储/网络资源创建前拒绝启动；
// - 相对路径 → 拒绝启动（绝对路径约束）。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type StartConfig } from "../../src/server/start.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-start-provider-ext-"));
  cleanups.push(dir);
  return dir;
}

async function createBaseline(dbPath: string): Promise<void> {
  const db = new DatabaseSync(dbPath);
  try { await runSqliteMigrations(db); } finally { db.close(); }
}

/** 最小 provider 扩展 fixture：注册 fixture provider + provider hooks，使用本地 apiKey。 */
function writeProviderExtensionFixture(root: string): string {
  const extensionDir = join(root, "fixture-extension");
  mkdirSync(join(extensionDir, "extensions"), { recursive: true });
  writeFileSync(join(extensionDir, "package.json"), JSON.stringify({
    name: "pi-provider-extension-fixture",
    version: "1.0.0",
    type: "module",
    pi: { extensions: ["./extensions"] },
  }));
  writeFileSync(join(extensionDir, "extensions", "provider.ts"), `
export default function (pi) {
  pi.registerProvider("fixture-provider", {
    name: "Fixture Provider",
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture-key",
    api: "openai-completions",
    models: [{
      id: "fixture-model",
      name: "Fixture Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }],
  });
  pi.on("before_provider_request", (event) => event.payload);
  pi.on("before_provider_headers", () => undefined);
}
`);
  return extensionDir;
}

function baseConfig(overrides: Partial<StartConfig> = {}): StartConfig {
  const dir = makeTempDir();
  return {
    port: 0,
    ipAccess: makeTestIpAccess(),
    dataDir: dir,
    authPath: join(dir, "auth.json"),
    ...overrides,
  };
}

async function startWithBaseline(config: StartConfig): Promise<Awaited<ReturnType<typeof startServer>>> {
  const dataDir = config.dataDir as string;
  const dbPath = config.dbPath ?? join(dataDir, "pi-agent-server.db");
  await createBaseline(dbPath);
  return startServer({ ...config, dbPath });
}

describe("startServer 显式 provider 扩展接入", () => {
  it("显式配置：provider 注册进入宿主 ModelRuntime，默认模型可用且出现在 /v1/models", async () => {
    const root = makeTempDir();
    const extensionDir = writeProviderExtensionFixture(root);
    const config = baseConfig({
      dataDir: root,
      providerExtensionPaths: [extensionDir],
      // 不显式接入 provider 扩展时，这个默认模型会解析失败并拒绝启动。
      defaultModel: { provider: "fixture-provider", id: "fixture-model" },
    });
    const app = await startWithBaseline(config);
    try {
      const models = await app.inject({ method: "GET", url: "/v1/models" });
      expect(models.statusCode).toBe(200);
      const body = models.json() as { models: Array<{ provider: string; id: string }>; defaultModel: { provider: string; id: string } | null };
      expect(body.models.some((model) => model.provider === "fixture-provider" && model.id === "fixture-model")).toBe(true);
      expect(body.defaultModel).toEqual(expect.objectContaining({ provider: "fixture-provider", id: "fixture-model" }));
    } finally {
      await app.close();
    }
  });

  it("冻结系统提示词 loader：为其它 cwd 的项目解析提示词时同样显式接入 provider 扩展", async () => {
    const root = makeTempDir();
    const extensionDir = writeProviderExtensionFixture(root);
    // 另一个项目 cwd：会走 start.ts 的会话专属（冻结提示词）ResourceLoader，而非共享 loader。
    const otherProjectCwd = join(root, "other-project");
    mkdirSync(otherProjectCwd, { recursive: true });
    const config = baseConfig({
      dataDir: root,
      providerExtensionPaths: [extensionDir],
      defaultModel: { provider: "fixture-provider", id: "fixture-model" },
    });
    const app = await startWithBaseline(config);
    try {
      const project = await app.inject({
        method: "POST",
        url: "/v1/projects",
        payload: { name: "other", cwd: otherProjectCwd },
      });
      expect(project.statusCode).toBe(201);
      const projectId = (project.json() as { id: string }).id;

      // createSession 会经 SystemPromptPort 解析该项目 cwd 的完整提示词，从而构造会话专属 loader。
      const session = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { projectId, title: "frozen-prompt" },
      });
      expect(session.statusCode).toBe(201);
      expect((session.json() as { systemPrompt?: string }).systemPrompt).toBeTruthy();

      // 第二个 loader 的 provider 注册刷入同一 ModelRuntime 后仍完好（重复 flush 幂等）。
      const models = await app.inject({ method: "GET", url: "/v1/models" });
      const body = models.json() as { models: Array<{ provider: string; id: string }> };
      expect(body.models.some((model) => model.provider === "fixture-provider" && model.id === "fixture-model")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("未显式配置：同一 provider 不被加载，默认模型不可用 → 拒绝启动", async () => {
    const root = makeTempDir();
    // 扩展存在于磁盘，但未列入 providerExtensionPaths：noExtensions 必须保持关闭自动发现。
    writeProviderExtensionFixture(root);
    const config = baseConfig({
      dataDir: root,
      defaultModel: { provider: "fixture-provider", id: "fixture-model" },
    });
    await expect(startWithBaseline(config)).rejects.toThrow(/默认模型不可用/);
  });

  it("显式配置加载失败（路径不存在）：在任何存储资源创建前拒绝启动", async () => {
    const root = makeTempDir();
    const config = baseConfig({
      dataDir: root,
      providerExtensionPaths: [join(root, "missing-extension")],
    });
    const dbPath = join(root, "pi-agent-server.db");
    await createBaseline(dbPath);
    await expect(startServer({ ...config, dbPath })).rejects.toThrow(/provider extension failed to load/);
    // 拒绝发生在扩展加载阶段：DB 基线文件之外不产生宿主持久化副作用。
    expect(readdirSync(root).filter((entry) => entry.includes("sessions"))).toEqual([]);
  });

  it("相对路径：在任何资源创建前拒绝（绝对路径约束）", async () => {
    const root = makeTempDir();
    await expect(
      startServer(baseConfig({ dataDir: root, providerExtensionPaths: ["relative/extension"] })),
    ).rejects.toThrow(/must be absolute/);
    expect(readdirSync(root)).toEqual([]);
  });
});
