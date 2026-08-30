// 幂等 storage close 行为：
//   - 成功路径与失败路径共用同一 closer，多次/并发调用只真正 destroy 一次；
//   - destroy 抛错原样传播（不掩盖原始错误）；
//   - 回归：schema 初始化成功后、启动后续步骤失败时，closeStorage 幂等销毁底层 Kysely/DatabaseSync。

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createIdempotentStorageCloser, closeStoragePreservingError } from "../../src/server/storage-close.js";
import { initializeDatabase } from "../../src/storage/bootstrap.js";

describe("幂等 storage close（createIdempotentStorageCloser / startServer 存储生命周期）", () => {
  it("多次 close（含并发）只真正 destroy 一次", async () => {
    let destroys = 0;
    const close = createIdempotentStorageCloser(() => {
      destroys += 1;
    });
    await Promise.all([close(), close(), close()]);
    expect(destroys).toBe(1);
    await close();
    expect(destroys).toBe(1);
  });

  it("并发两次 close 共享同一个 destroy 完成结果（destroy 只执行一次）", async () => {
    let destroys = 0;
    // 初值用 no-op：Promise executor 同步执行，随后被 resolve 替换（保持可空语义的同时
    // 避免 let/null-only-闭包赋值的类型收窄问题）。
    let releaseDestroy: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseDestroy = resolve; });
    const close = createIdempotentStorageCloser(async () => {
      destroys += 1;
      await gate;
    });

    // 第一个 caller 进入 destroy（挂起）后，第二个 caller 并发调用
    const first = close();
    const second = close();
    // 两个并发 caller 拿到的是同一个 in-flight Promise，等待同一次 destroy 完成
    expect(second).toBe(first);

    releaseDestroy();
    await Promise.all([first, second]);
    expect(destroys).toBe(1);
    // 完成后再次调用是 no-op，不触发第二次 destroy
    await close();
    expect(destroys).toBe(1);
  });

  it("destroy 抛错时原样传播（不掩盖原始错误），后续调用仍为 no-op", async () => {
    const close = createIdempotentStorageCloser(() => {
      throw new Error("close-fail");
    });
    await expect(close()).rejects.toThrow("close-fail");
    // 幂等继续成立：重试不再触发 destroy
    await close();
  });

  it("回归：初始化成功后、后续初始化失败时，closeStorage destroy 底层 DatabaseSync（恰一次）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-storage-close-"));
    const file = join(dir, "app.db");
    const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    let kysely: Awaited<ReturnType<typeof initializeDatabase>> | null = null;
    // 与 start.ts 完全一致的 closer 构造：初始化后销毁 Kysely（经 adapter 关闭 DatabaseSync）
    const closeStorage = createIdempotentStorageCloser(async () => {
      if (kysely) await kysely.destroy();
    });

    // 初始化成功
    kysely = await initializeDatabase(db);
    // 模拟初始化后某一步（如 ensureDefaultProject / backfill / buildApp）失败
    await expect(Promise.reject(new Error("模拟后续初始化失败"))).rejects.toThrow("模拟后续初始化失败");

    // startServer 的 catch 路径调用 closeStorage → Kysely destroy → 底层 DatabaseSync 已关闭
    await closeStorage();
    expect(() => db.prepare("SELECT 1")).toThrow(/not open/i);

    // 幂等：再次调用不再动作、不抛错（不会二次 close）
    await closeStorage();
    expect(() => db.prepare("SELECT 1")).toThrow(/not open/i);

    rmSync(dir, { recursive: true, force: true });
  });

  it("closeStoragePreservingError：cleanup 成功时仍重新抛出原始错误", async () => {
    const original = new Error("原始启动错误");
    let destroys = 0;
    const close = createIdempotentStorageCloser(() => {
      destroys += 1;
    });

    await expect(closeStoragePreservingError(close, original)).rejects.toBe(original);
    // 清理确实执行了（销毁恰一次）
    expect(destroys).toBe(1);
  });

  it("closeStoragePreservingError：cleanup 失败时不掩盖原始错误，cleanup 错误只上报回调", async () => {
    const original = new Error("原始启动错误");
    const cleanupError = new Error("cleanup-fail");
    let cleanupAttempts = 0;
    const close = createIdempotentStorageCloser(() => {
      cleanupAttempts += 1;
      throw cleanupError;
    });
    const reported: unknown[] = [];

    // 重新抛出的必须是原始错误（toBe 引用相等，证明未被 cleanupError 覆盖）
    await expect(closeStoragePreservingError(close, original, (e) => reported.push(e))).rejects.toBe(
      original,
    );
    // cleanup 错误只交给回调，不覆盖原始错误
    expect(cleanupAttempts).toBe(1);
    expect(reported).toEqual([cleanupError]);
    // 幂等继续成立：重试不再触发清理
    await close();
    expect(cleanupAttempts).toBe(1);
  });

  it("回归：初始化成功后、后续初始化失败且 closeStorage 自身失败时，仍抛出原始启动错误", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-storage-close-fail-"));
    const file = join(dir, "app.db");
    const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    let kysely: Awaited<ReturnType<typeof initializeDatabase>> | null = null;
    // 构造与 start.ts 相同的 closer，但 destroy 后额外抛错模拟 closeStorage 失败
    const closeStorage = createIdempotentStorageCloser(async () => {
      if (kysely) await kysely.destroy();
      throw new Error("destroy-fail");
    });

    kysely = await initializeDatabase(db);
    const original = new Error("模拟后续初始化失败");
    const reported: unknown[] = [];

    await expect(
      closeStoragePreservingError(closeStorage, original, (e) => reported.push(e)),
    ).rejects.toBe(original);
    // cleanup 错误上报给了回调，且不会覆盖原始启动错误
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain("destroy-fail");
    // destroy 仍执行了：底层 DatabaseSync 已关闭
    expect(() => db.prepare("SELECT 1")).toThrow(/not open/i);

    rmSync(dir, { recursive: true, force: true });
  });
});
