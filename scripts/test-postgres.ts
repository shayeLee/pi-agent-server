// PG 集成测试 runner（发布门禁 `pnpm test:postgres`，跨平台 Node + tsx，不用 sh test -n）：
// - `PI_TEST_PG_URL` 缺失/空白 → 打印原因并以退出码 1 失败。绝不发起连接、绝不假装通过、
//   也绝不把连接串写进日志/错误信息（只提及环境变量名）。
// - 有值 → 仅运行 `tests/postgres/**` 下的真实集成测试（vitest 文件名过滤；根 vitest.config.ts
//   的 include 与 reporters 仍生效；普通 `pnpm test` 的 skip 行为不受影响）。
//
// 与普通 `pnpm test` 的刻意区分（供文档/验收引用）：
//   - `pnpm test`（无 PI_TEST_PG_URL）：tests/postgres 整组 skip（现有门控，不报失败）——复跑前检视基线；
//   - `pnpm test:postgres`（无 PI_TEST_PG_URL）：等同于非零退出且说明原因——发布门禁，不允许「没跑 PG 却说验收」。
//
// 本文件同时是可测试的最小结构：判定/解析函数导出（tests/tools/test-postgres-runner.test.ts 直接饮用），
// 仅当被当作 CLI 入口执行时才运行 main()。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** 测试门控环境变量名（只此一处定义，测试与文档引用同一常量）。 */
export const PG_TEST_URL_ENV = "PI_TEST_PG_URL";
/** vitest 文件名过滤：只跑 tests/postgres/** 下的真实集成测试。 */
export const PG_TEST_FILE_PATTERN = "tests/postgres";

export interface PgUrlDecision {
  ok: boolean;
  /** 失败原因（不含连接串，只提到环境变量名与复跑指引）。 */
  reason?: string;
}

/** 判读连接串：缺失/空白 → ok=false；有值 → ok=true。trim 保证空白不被当作有效值放行。 */
export function resolvePgTestUrl(raw: string | undefined): PgUrlDecision {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return {
      ok: false,
      reason:
        `[test:postgres] 环境变量 ${PG_TEST_URL_ENV} 未配置或为空白：真实 PG 集成测试未执行，` +
        `不得把未运行的门控用例当作验收通过。` +
        `请按 docs/postgres-podman-test.md 启动临时 PostgreSQL 并设置 ${PG_TEST_URL_ENV} 后重试。` +
        `（普通 pnpm test 中该组按既有门控 skip，不报失败；本命令是发布门禁，必须真实 PG 通过。）`,
    };
  }
  return { ok: true };
}

/**
 * 解析本地依赖包的可执行入口（package.json bin 字段），返回绝对路径。
 * 不依赖 shell（无需 `.cmd`/`PATH`），Windows/macOS/Linux 一致；找不到时报可操作错误。
 */
export function resolveBinPath(packageName: string, binKey: string): string {
  let pkgJsonPath: string;
  try {
    pkgJsonPath = require.resolve(`${packageName}/package.json`);
  } catch (error) {
    throw new Error(
      `[test:postgres] 找不到依赖 '${packageName}'（pnpm install 未执行？）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const pkg = require(pkgJsonPath) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binKey];
  if (typeof bin !== "string" || bin.length === 0) {
    throw new Error(`[test:postgres] 依赖 '${packageName}' 没有可执行的 bin '${binKey}'`);
  }
  return join(dirname(pkgJsonPath), bin);
}

/** 当前进程是否以 CLI 入口方式运行（区别于被测试 import）。 */
export function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const decision = resolvePgTestUrl(process.env[PG_TEST_URL_ENV]);
  if (!decision.ok) {
    // 无 URL：非零退出并说明原因（不会以 skip 冒充通过）
    console.error(decision.reason ?? `[test:postgres] ${PG_TEST_URL_ENV} 未配置`);
    process.exitCode = 1;
    return;
  }

  // 有 URL：仅跑 tests/postgres/**，连接串只进子进程环境（绝不打印）
  const vitestCli = resolveBinPath("vitest", "vitest");
  const envUrl = decision.ok ? process.env[PG_TEST_URL_ENV] : undefined;
  const child = spawn(
    process.execPath,
    [vitestCli, "run", PG_TEST_FILE_PATTERN],
    {
      stdio: "inherit",
      env: envUrl !== undefined ? { ...process.env, [PG_TEST_URL_ENV]: envUrl.trim() } : process.env,
    },
  );
  child.on("error", (error) => {
    console.error(`[test:postgres] 启动 vitest 失败：${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[test:postgres] vitest 被信号终止：${signal}`);
      process.exitCode = 1;
    } else {
      process.exitCode = code ?? 1;
    }
  });
}

if (isCliEntry()) {
  void main();
}