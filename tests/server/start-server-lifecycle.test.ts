// startServer 启动/失败清理（H2）：走真实 composition root（不 mock ModelRuntime/SDK），
// 通过最小、无行为变化的测试注入点（StartConfig.onStorageReady，生产不传恒无操作）观测/注入
// 启动中段失败，验证：
// - 未知 storageDialect / PG 缺 databaseUrl 在任何资源创建前 fail-fast（错误消息 + 代码位置 = 行为契约）；
// - 至少一个初始化中段失败（注入 seam 抛错、以及真实 app.listen EADDRINUSE）：存储恰好关闭一次、
//   原始错误保留（cleanup 不掩盖）；
// - 成功 startServer 后 app.close：onClose 幂等 closeStorage 清理底层存储恰一次。
//
// 注：本文件会真实创建 SQLite 文件与 SDK runtime 对象，全部落在临时目录，测试结束 rmSync 清理；
// 不设置任何模型/凭证配置（不触达网络），与 scripts/mock-server.ts 同级别的本机可运行性。

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { startServer, type StartConfig } from "../../src/server/start.js";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-start-server-"));
}

function baseConfig(overrides: Partial<StartConfig> = {}): StartConfig {
  const dir = makeTempDir();
  return {
    port: 0,
    intranetCidrs: [],
    tokens: overrides.tokens ?? {},
    dataDir: dir,
    authPath: join(dir, "auth.json"),
    ...overrides,
  };
}

describe("startServer 启动/失败清理（H2：fail-fast 顺序 + 幂等 storage close + 成功 app.close 清理）", () => {
  it("未知 storageDialect fail-fast：在任何 ModelRuntime/Pool/DatabaseSync 创建前拒绝启动", async () => {
    // resolveStorageConfig 在 startServer 内最先解析（先于 ModelRuntime.create、任何 DatabaseSync/
    // Pool 创建）；断言的具体错误消息即 fail-fast 的位置与顺序契约。
    await expect(
      startServer(baseConfig({ storageDialect: "mongodb" as never })),
    ).rejects.toThrow(/未知存储方言：mongodb/);
  });

  it("PG 缺 databaseUrl fail-fast：在同位置（资源创建前）拒绝启动，绝不静默回退 SQLite", async () => {
    for (const databaseUrl of [undefined, "", "   "]) {
      await expect(
        startServer(baseConfig({ storageDialect: "postgres", databaseUrl })),
      ).rejects.toThrow(/databaseUrl.*PI_DATABASE_URL/);
    }
  });

  it("初始化中段失败（注入 seam 抛错）：存储恰好关闭一次（kysely.destroy×1），原始错误保留", async () => {
    let destroySpy: ReturnType<typeof vi.spyOn> | null = null;
    const midInitError = new Error("模拟中段初始化失败（schema 就绪后）");
    const dir = makeTempDir();
    try {
      await expect(
        startServer(
          baseConfig({
            dataDir: dir,
            dbPath: join(dir, "app.db"),
            onStorageReady: async (kysely: Kysely<DatabaseSchema>) => {
              destroySpy = vi.spyOn(kysely, "destroy");
              throw midInitError;
            },
          }),
        ),
      ).rejects.toBe(midInitError); // 原始错误原样保留（cleanup 未覆盖）

      expect(destroySpy).not.toBeNull();
      // 幂等 closer：恰好一次 destroy（createIdempotentStorageCloser 保证不重复）
      expect(destroySpy!.mock.calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("真实 listen 失败（端口被占）：catch 路径关闭存储恰一次，原始 EADDRINUSE 保留", async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const port = (blocker.address() as AddressInfo).port;
    let destroySpy: ReturnType<typeof vi.spyOn> | null = null;
    const dir = makeTempDir();
    try {
      await expect(
        startServer(
          baseConfig({
            port,
            dataDir: dir,
            dbPath: join(dir, "app.db"),
            onStorageReady: (kysely: Kysely<DatabaseSchema>) => {
              destroySpy = vi.spyOn(kysely, "destroy");
            },
          }),
        ),
      ).rejects.toSatisfy((err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(e.message ?? String(err));
      });

      // schema 初始化成功、listen 失败 → catch 统一清理（destroy 恰一次，非重复/遗漏）
      expect(destroySpy).not.toBeNull();
      expect(destroySpy!.mock.calls).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("成功启动后 app.close：onClose 触发幂等 storage cleanup（kysely.destroy 恰一次）", async () => {
    let destroySpy: ReturnType<typeof vi.spyOn> | null = null;
    const dir = makeTempDir();
    const app = await startServer(
      baseConfig({
        dataDir: dir,
        dbPath: join(dir, "app.db"),
        onStorageReady: (kysely: Kysely<DatabaseSchema>) => {
          destroySpy = vi.spyOn(kysely, "destroy");
        },
      }),
    );
    try {
      expect(destroySpy).not.toBeNull();
      expect(destroySpy!.mock.calls).toHaveLength(0); // 启动期间不销毁
      expect(app.server.address()).toBeTruthy(); // 已在真实端口监听
    } finally {
      // app.close 放 finally：任何断言失败也保证真实关闭监听 + 触发 onClose → cleanup（destroy 恰一次）
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(destroySpy!.mock.calls).toHaveLength(1); // app.close → onClose → closeStorage → destroy 恰一次
  });
});