// 跨包端到端：真实 `pi-agent-capability-onev` 包 + 真实宿主 buildApp/registerPlugins。
//
// 验证两件事（这两件在宿主单测里只能用 fake 插件覆盖，此处用真实包闭环）：
//   1) 插件声明的业务 flag 经宿主自动挂载的能力投影端点按 role 返回布尔；
//   2) 绑定/同步路由真的被 capability:admin 强制（user 403，admin 不被 RBAC 拦下）。
//
// 解析不到真实包时，默认显式 skip（依赖缺失是环境状态，不是通过），绝不回退到仓内源码。
// 但 skip 会让「user 不能改绑」这条核心断言在干净 CI 里静默消失，因此提供强制开关：
// 设置 `PI_REQUIRE_ONEV_E2E=1` 时缺失依赖直接失败，CI 可用它把本文件当必跑安全门禁（与本地可选共存）。
const REQUIRE_REAL_PACKAGE = process.env.PI_REQUIRE_ONEV_E2E === "1";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../src/server/app.js";
import { PluginLoader } from "../../../src/application/plugins/loader.js";
import { registerPlugins, type PluginHost } from "../../../src/server/plugin-host.js";
import { MockAgentAdapter } from "../../../src/agent/mock-agent-adapter.js";
import {
  ConversationStorageRegistry,
  DEFAULT_PROJECT_ID,
  type ModelCatalogPort,
} from "../../../src/application/ports/index.js";
import { PiJsonlConversationStorage } from "../../../src/agent/pi-jsonl-conversation-storage.js";
import { makeInitializedMemoryDb } from "../../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../../helpers/ip-access.js";

const PACKAGE_SPECIFIER = "pi-agent-capability-onev";
const requireFromProject = createRequire(new URL("../../../package.json", import.meta.url));

/**
 * 真实插件的 register 依赖已迁移的插件库（ONEV_DATA_DIR）与项目目录中的 components.json。
 * 这里用真实包的公开存储出口在临时目录准备这些前置条件，不手写 schema。
 */
async function prepareOnevRuntime(pluginDir: string, projectDir: string, dataDir: string): Promise<void> {
  const storage = (await import(`${pluginDir}/dist/storage/index.js`)) as {
    openDatabase: (options: { dbPath: string }) => unknown;
    applyMigrations: (db: unknown) => void;
    closeDatabase: (db: unknown) => void;
  };
  const dbPath = path.join(dataDir, "onev.db");
  const db = storage.openDatabase({ dbPath });
  storage.applyMigrations(db);
  storage.closeDatabase(db);
  writeFileSync(path.join(projectDir, "components.json"), JSON.stringify({ button: {} }));
}

let resolvedEntry: string | null = null;
try {
  resolvedEntry = requireFromProject.resolve(PACKAGE_SPECIFIER);
} catch {
  resolvedEntry = null;
}

/** 每角色一个来源 IP（一个 IP = 一个用户）。 */
const ROLE_IP = {
  admin: "10.0.0.31",
  user: "10.0.0.32",
  viewer: "10.0.0.33",
  operator: "10.0.0.34",
} as const;

const FAKE_MODEL_CATALOG: ModelCatalogPort = {
  async getAvailable() {
    return [{ provider: "fake", id: "fake-model", name: "fake-model" }];
  },
  async isAvailable(provider, id) {
    return provider === "fake" && id === "fake-model";
  },
};

const ACCESS_URL = "/v1/capabilities/onev/access";
const BIND_URL = "/v1/capabilities/onev/documents/links";
const SYNC_URL = "/v1/capabilities/onev/sync/dingtalk/button";

describe("真实 onev 包：能力投影与 admin 档强制（端到端）", () => {
  async function makeRealPluginApp(): Promise<{
    app: FastifyInstance;
    host: PluginHost;
    close: () => Promise<void>;
  }> {
    // Pi JSONL 存储要求非根绝对目录；用临时目录，测试结束清理。
    const dataDir = mkdtempSync(path.join(tmpdir(), "onev-projection-"));
    const onevDataDir = path.join(dataDir, "onev-data");
    mkdirSync(onevDataDir, { recursive: true, mode: 0o700 });
    await prepareOnevRuntime(path.dirname(path.dirname(resolvedEntry!)), dataDir, onevDataDir);
    const previousDataDir = process.env.ONEV_DATA_DIR;
    process.env.ONEV_DATA_DIR = onevDataDir;

    const storage = await makeInitializedMemoryDb();
    const conversationStorage = new ConversationStorageRegistry();
    conversationStorage.register(new PiJsonlConversationStorage(dataDir));

    // 插件 register 需要真实 SessionService（而不是 repository）；由宿主回调交出。
    let sessionService: Parameters<typeof registerPlugins>[1]["sessions"] | undefined;
    const app = buildApp({
      sessions: storage.sessions,
      projects: storage.projects,
      defaultProjectCwd: dataDir,
      conversationStorage,
      modelCatalog: FAKE_MODEL_CATALOG,
      ipAccess: makeTestIpAccess({
        policy: makePolicy(
          Object.entries(ROLE_IP).map(([role, ip]) => ({ ip, role: role as "admin" | "user" | "viewer" | "operator" })),
        ),
      }),
      onSessionServiceReady: (service) => {
        sessionService = service;
      },
      createAdapter: async () => new MockAgentAdapter(),
    });

    const loaded = await new PluginLoader({ projectCwd: dataDir }).load(PACKAGE_SPECIFIER);
    // 真实包的 manifest 必须已经声明 canBind；否则下面的投影断言会失去意义。
    expect(loaded.capabilities).toEqual(["canBind"]);
    expect(sessionService).toBeDefined();
    const host = await registerPlugins([loaded], {
      app,
      projectCwd: dataDir,
      sessions: sessionService!,
    });

    return {
      app,
      host,
      close: async () => {
        await host.dispose();
        await app.close();
        await storage.close();
        if (previousDataDir === undefined) delete process.env.ONEV_DATA_DIR;
        else process.env.ONEV_DATA_DIR = previousDataDir;
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  }

  it("能力投影按 role 返回 canBind：仅 admin true，user/viewer/operator 均 false", async (context) => {
    if (resolvedEntry === null) {
      if (REQUIRE_REAL_PACKAGE) {
        throw new Error(`PI_REQUIRE_ONEV_E2E=1 但未解析到 ${PACKAGE_SPECIFIER}：请安装并构建真实插件包`);
      }
      context.skip(`${PACKAGE_SPECIFIER} 未安装，无法验证真实包端到端`);
      return;
    }
    const { app, close } = await makeRealPluginApp();
    try {
      const read = async (ip: string) =>
        (await app.inject({ method: "GET", url: ACCESS_URL, remoteAddress: ip })).json();

      expect(await read(ROLE_IP.admin)).toEqual({ canBind: true });
      expect(await read(ROLE_IP.user)).toEqual({ canBind: false });
      expect(await read(ROLE_IP.viewer)).toEqual({ canBind: false });
      // operator 是运维面角色：/v1 一律 403，不因名义而误报可读。
      const operator = await app.inject({ method: "GET", url: ACCESS_URL, remoteAddress: ROLE_IP.operator });
      expect(operator.statusCode).toBe(403);
    } finally {
      await close();
    }
  });

  it("改绑与同步被 admin 档强制：user/viewer 403，admin 通过 RBAC（不因权限被拦）", async (context) => {
    if (resolvedEntry === null) {
      if (REQUIRE_REAL_PACKAGE) {
        throw new Error(`PI_REQUIRE_ONEV_E2E=1 但未解析到 ${PACKAGE_SPECIFIER}：请安装并构建真实插件包`);
      }
      context.skip(`${PACKAGE_SPECIFIER} 未安装，无法验证真实包端到端`);
      return;
    }
    const { app, close } = await makeRealPluginApp();
    try {
      const post = (ip: string, url: string, payload: unknown) =>
        app.inject({
          method: "POST",
          url,
          remoteAddress: ip,
          headers: { "content-type": "application/json" },
          payload: JSON.stringify(payload),
        });

      // user 是本次变更的**核心回归点**：变更前它就能改绑（capability:write 含 user）。
      const userBind = await post(ROLE_IP.user, BIND_URL, { name: "button", documentId: "doc-1" });
      expect(userBind.statusCode).toBe(403);
      const viewerBind = await post(ROLE_IP.viewer, BIND_URL, { name: "button", documentId: "doc-1" });
      expect(viewerBind.statusCode).toBe(403);

      const userSync = await post(ROLE_IP.user, SYNC_URL, {});
      expect(userSync.statusCode).toBe(403);

      // admin 不被 RBAC 拦下：请求进入 handler 后因未绑定/未启用同步而失败，
      // 但绝不是 403（证明权限门已放行，且与业务错误可区分）。
      const adminBind = await post(ROLE_IP.admin, BIND_URL, { name: "button", documentId: "doc-1" });
      expect(adminBind.statusCode).not.toBe(403);
      expect(adminBind.statusCode).toBe(200);

      const adminSync = await post(ROLE_IP.admin, SYNC_URL, {});
      expect(adminSync.statusCode).not.toBe(403);
    } finally {
      await close();
    }
  });

  it("投影端点是只读 GET：POST 不被允许（不暴露写面）", async (context) => {
    if (resolvedEntry === null) {
      if (REQUIRE_REAL_PACKAGE) {
        throw new Error(`PI_REQUIRE_ONEV_E2E=1 但未解析到 ${PACKAGE_SPECIFIER}：请安装并构建真实插件包`);
      }
      context.skip(`${PACKAGE_SPECIFIER} 未安装，无法验证真实包端到端`);
      return;
    }
    const { app, close } = await makeRealPluginApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: ACCESS_URL,
        remoteAddress: ROLE_IP.admin,
        headers: { "content-type": "application/json" },
        payload: "{}",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await close();
    }
  });
});
