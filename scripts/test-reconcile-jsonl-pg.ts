// Mandatory WP4C gate. Unlike ordinary `pnpm test`, this command never skips:
// it requires PI_TEST_PG_URL, then runs the isolated PostgreSQL reconcile
// analyzer test file against the real server (dedicated random schema, created
// and dropped by the fixture; the URL is passed only through the child
// environment and is never printed). Without the URL this gate exits non-zero.
// The fixture applies migrations with the ledger via runPostgresMigrations,
// seeds data with parameter binding only (never ident-quoted values), touches
// no filesystem (DATA_DIR is a lexical binding string only), and also runs the
// real reconcile CLI PG branch (source entry via tsx, random schema bound
// through the URL's search_path options — no LOGIN role is created; the CLI
// strictly parses options, allowing only search_path, and merges
// default_transaction_read_only=on plus a bounded lock_timeout) plus the
// URL-options-with-non-search_path fail-closed case. It verifies random-schema
// isolation, server-side read-write refusal, zero DB changes, no URL/path/
// credential leakage, and reliable schema cleanup (no roles are ever created).
// WP4C Plan A has no executor: this gate never exercises deletion/restore —
// executable is always false and the analyzer never scans the filesystem.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PG_TEST_REQUIRED_ENV, runVitestWithEvidence } from "./pg-test-gate.js";
import { resolveBinPath } from "./test-file-ops-pg.js";

export const RECONCILE_JSONL_PG_URL_ENV = "PI_TEST_PG_URL";
export const RECONCILE_JSONL_PG_TEST_FILE = "tests/postgres/reconcile-jsonl.test.ts";
export { PG_TEST_REQUIRED_ENV };

/** 判读连接串：缺失/空白 → 拒绝执行（发布门禁不允许以 skip 冒充通过）。 */
export function resolveReconcileJsonlPgUrl(raw: string | undefined): { ok: boolean; reason?: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      reason: `[test:reconcile-jsonl-pg] ${RECONCILE_JSONL_PG_URL_ENV} 未配置或为空白：真实 PostgreSQL reconcile 门禁未执行；请配置隔离测试 PG 后重试。连接串不打印。`,
    };
  }
  return { ok: true };
}

async function main(): Promise<void> {
  const decision = resolveReconcileJsonlPgUrl(process.env[RECONCILE_JSONL_PG_URL_ENV]);
  if (!decision.ok) {
    console.error(decision.reason ?? `[test:reconcile-jsonl-pg] ${RECONCILE_JSONL_PG_URL_ENV} 未配置`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runVitestWithEvidence({
    vitestPath: resolveBinPath("vitest", "vitest"),
    target: RECONCILE_JSONL_PG_TEST_FILE,
    scope: "test:reconcile-jsonl-pg",
    env: {
      ...process.env,
      [RECONCILE_JSONL_PG_URL_ENV]: process.env[RECONCILE_JSONL_PG_URL_ENV]!.trim(),
      [PG_TEST_REQUIRED_ENV]: "1",
    },
  });
}

function isCliEntry(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  void main();
}