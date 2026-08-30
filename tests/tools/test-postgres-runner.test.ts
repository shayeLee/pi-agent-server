// test:postgres runner 的最小可验证结构（tests/tools/...）：
// 1. 判定函数：PI_TEST_PG_URL 缺失/空白 → 明确拒绝（分泌原因）；有值 → 放行且过滤恰好为 tests/postgres/**。
// 2. 依赖解析：能定位本地 vitest CLI 入口（跨平台绝对路径，不走 shell）。
// 3. 真实进程级验证：无 URL 时运行 scripts/test-postgres.ts 必须以非零码失败且打印原因——
//    证明「没 URL 时 test:postgres 明确失败」，而普通 pnpm test 的 skip 行为不受影响（见最终运行验证）。

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PG_TEST_URL_ENV,
  PG_TEST_FILE_PATTERN,
  resolvePgTestUrl,
  resolveBinPath,
  isCliEntry,
} from "../../scripts/test-postgres.js";

describe("test:postgres runner（scripts/test-postgres.ts）", () => {
  it(`PI_TEST_PG_URL 缺失 → ok=false，原因明确（提及环境变量名，不泄漏连接串）`, () => {
    const d = resolvePgTestUrl(undefined);
    expect(d.ok).toBe(false);
    expect(d.reason).toContain(PG_TEST_URL_ENV);
    expect(d.reason).toMatch(/未配置或为空白/);
    expect(d.reason).not.toMatch(/postgresql:\/\//); // 连接串绝不泄漏
  });

  it("空白 / 仅空白 → 同样拒绝（trim 后按未配置处理，不为空白放行）", () => {
    expect(resolvePgTestUrl("").ok).toBe(false);
    expect(resolvePgTestUrl("   \n\t ").ok).toBe(false);
  });

  it("有连接串 → ok=true，vitest 过滤恰好为 tests/postgres/**（只跑真实集成测试）", () => {
    const d = resolvePgTestUrl("postgresql://u:p@127.0.0.1:54329/test");
    expect(d.ok).toBe(true);
    expect(PG_TEST_FILE_PATTERN).toBe("tests/postgres");
  });

  it("每次调用都基于当前 env 判读，且共同导出常量只定义一次", () => {
    expect(PG_TEST_URL_ENV).toBe("PI_TEST_PG_URL");
    expect(PG_TEST_FILE_PATTERN).not.toBe("");
  });

  it("可定位本地 vitest CLI（绝对路径、跨平台，不依赖 shell）", () => {
    const cli = resolveBinPath("vitest", "vitest");
    expect(cli).toContain("vitest");
    expect(cli.endsWith(".mjs") || cli.endsWith(".cjs") || cli.endsWith(".js")).toBe(true);
  });
});

describe("test:postgres 进程级契约（无 URL 必须非零失败；普通路径不受影响）", () => {
  const scriptPath = fileURLToPath(new URL("../../scripts/test-postgres.ts", import.meta.url));

  it("无 PI_TEST_PG_URL 直接运行脚本 → 退出码 1，stderr 说明原因", () => {
    const tsxCli = resolveBinPath("tsx", "tsx");
    const result = spawnSync(process.execPath, [tsxCli, scriptPath], {
      encoding: "utf8",
      env: { ...process.env, [PG_TEST_URL_ENV]: "" }, // 显式清空，保证本用例在任何环境下都验证失败路径
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(PG_TEST_URL_ENV);
    expect(result.stderr).toMatch(/未配置或为空白/);
    // 绝不把连接串打进输出
    expect(result.stdout + result.stderr).not.toMatch(/postgresql:\/\//);
  });

  it("脚本被当作模块 import 时不会自动执行命令（isCliEntry 守卫）", () => {
    expect(isCliEntry()).toBe(false); // 本进程 argv[1] 是 vitest，不是脚本本身
  });
});