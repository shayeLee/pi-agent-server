// Mandatory WP4B gate. Unlike ordinary `pnpm test`, this command never skips:
// it requires PI_TEST_PG_URL, then runs the isolated PostgreSQL file-operation
// planner test file against the real server (dedicated random schema, created
// and dropped by the fixture; the URL is passed only through the child
// environment and is never printed). Without the URL this gate exits non-zero.
// The fixture also runs the real planner CLI PG branch (source entry via tsx,
// random schema bound through the URL's search_path options — no LOGIN role is
// created; the CLI strictly parses options, allowing only search_path, and
// merges default_transaction_read_only=on plus a bounded lock_timeout) and
// verifies random-schema isolation, zero DB changes, and no URL/path/credential
// leakage. The planner is read-only; its read-only enforcement on the CLI side
// is enforced in tests/postgres/file-operation-planner.test.ts (and in-process
// CLI tests), so this gate never exercises an executor — WP4B physical
// execution is not implemented.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PG_TEST_REQUIRED_ENV, runVitestWithEvidence } from "./pg-test-gate.js";

const require = createRequire(import.meta.url);

export const FILE_OPS_PG_URL_ENV = "PI_TEST_PG_URL";
export const FILE_OPS_PG_TEST_FILE = "tests/postgres/file-operation-planner.test.ts";
export { PG_TEST_REQUIRED_ENV };

/** 判读连接串：缺失/空白 → 拒绝执行（发布门禁不允许以 skip 冒充通过）。 */
export function resolveFileOpsPgUrl(raw: string | undefined): { ok: boolean; reason?: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      reason: `[test:file-ops-pg] ${FILE_OPS_PG_URL_ENV} 未配置或为空白：真实 PostgreSQL file_operations planner 门禁未执行；请配置隔离测试 PG 后重试。连接串不打印。`,
    };
  }
  return { ok: true };
}

export function resolveBinPath(packageName: string, binKey: string): string {
  const pkgJsonPath = require.resolve(`${packageName}/package.json`);
  const pkg = require(pkgJsonPath) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binKey];
  if (typeof bin !== "string" || bin.length === 0) {
    throw new Error(`[test:file-ops-pg] 依赖 '${packageName}' 没有可执行的 bin '${binKey}'`);
  }
  // 用 package 目录 + bin 路径 join，不走 package subpath require.resolve：
  // 有些 CLI（如 vitest 4）的 exports 未暴露 ./vitest.mjs，subpath 解析会失败。
  return join(dirname(pkgJsonPath), bin);
}

async function main(): Promise<void> {
  const decision = resolveFileOpsPgUrl(process.env[FILE_OPS_PG_URL_ENV]);
  if (!decision.ok) {
    console.error(decision.reason ?? `[test:file-ops-pg] ${FILE_OPS_PG_URL_ENV} 未配置`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runVitestWithEvidence({
    vitestPath: resolveBinPath("vitest", "vitest"),
    target: FILE_OPS_PG_TEST_FILE,
    scope: "test:file-ops-pg",
    env: { ...process.env, [FILE_OPS_PG_URL_ENV]: process.env[FILE_OPS_PG_URL_ENV]!.trim(), [PG_TEST_REQUIRED_ENV]: "1" },
  });
}

function isCliEntry(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isCliEntry()) {
  void main();
}