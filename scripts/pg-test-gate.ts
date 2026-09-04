import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Set only by the mandatory PG runners. Ordinary `pnpm test` must retain skips. */
export const PG_TEST_REQUIRED_ENV = "PI_TEST_PG_REQUIRED";

export function isRequiredPgTest(raw: string | undefined = process.env[PG_TEST_REQUIRED_ENV]): boolean {
  return raw === "1" || raw?.toLowerCase() === "true";
}

export interface PgToolGateDecision {
  readonly ok: boolean;
  readonly reason?: string;
}

export type PgBinaryProbe = (binary: string) => boolean;

/**
 * Presence probes deliberately accept either conventional probe. This is
 * injectable so the -h/--version split is tested without relying on host tools.
 * Version parsing remains a separate fail-closed check.
 */
export function probePgBinary(
  binary: string,
  run: (binary: string, args: readonly string[]) => number | null = (command, args) => {
    try { return spawnSync(command, args, { stdio: "ignore" }).status; } catch { return null; }
  },
): boolean {
  return run(binary, ["--version"]) === 0 || run(binary, ["-h"]) === 0;
}

export function checkRequiredPgTools(probe: PgBinaryProbe = probePgBinary): PgToolGateDecision {
  const missing = ["pg_dump", "pg_restore", "age", "age-keygen"].filter((binary) => !probe(binary));
  return missing.length === 0
    ? { ok: true }
    : { ok: false, reason: `缺少 ${missing.join("、")}：真实 PostgreSQL 门禁拒绝通过；未执行真实 PG 用例。` };
}

export function assertRequiredPgTestEnvironment(
  scope: string,
  url: string | undefined,
  requireTools: boolean,
): void {
  if (!isRequiredPgTest()) return;
  if (!url?.trim()) throw new Error(`[${scope}] ${"PI_TEST_PG_URL"} 未配置或为空白：必需的真实 PG 用例不能 skip。`);
  if (requireTools) {
    const tools = checkRequiredPgTools();
    if (!tools.ok) throw new Error(`[${scope}] ${tools.reason}`);
  }
}

export interface VitestEvidenceOptions {
  readonly vitestPath: string;
  readonly target: string;
  readonly env: NodeJS.ProcessEnv;
  readonly scope: string;
}

/**
 * Run a mandatory suite with a machine-readable reporter. A zero exit from
 * Vitest is not sufficient: a gate must have executed at least one test and
 * may not contain pending/skipped tests. The JSON report is deleted on exit.
 */
export function runVitestWithEvidence(options: VitestEvidenceOptions): Promise<number> {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-pg-test-gate-"));
  const report = path.join(directory, "vitest.json");
  const child = spawn(process.execPath, [
    options.vitestPath,
    "run",
    options.target,
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${report}`,
  ], { stdio: "inherit", env: { ...options.env, [PG_TEST_REQUIRED_ENV]: "1" } });

  return new Promise((resolve) => {
    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      let finalCode = code;
      if (finalCode === 0) {
        try {
          if (!existsSync(report)) throw new Error("Vitest JSON evidence was not produced");
          const result = JSON.parse(readFileSync(report, "utf8")) as {
            numTotalTests?: unknown;
            numPassedTests?: unknown;
            numFailedTests?: unknown;
            numPendingTests?: unknown;
            numTodoTests?: unknown;
          };
          const total = result.numTotalTests;
          const passed = result.numPassedTests;
          const failed = result.numFailedTests;
          const pending = result.numPendingTests;
          const todo = result.numTodoTests;
          if (
            typeof total !== "number" || total < 1 ||
            typeof passed !== "number" || passed < 1 ||
            failed !== 0 || pending !== 0 || (typeof todo === "number" && todo !== 0)
          ) throw new Error(`Vitest evidence did not prove real execution (total=${String(total)}, passed=${String(passed)}, failed=${String(failed)}, pending=${String(pending)}, todo=${String(todo)})`);
        } catch (error) {
          console.error(`[${options.scope}] ${error instanceof Error ? error.message : "invalid Vitest evidence"}`);
          finalCode = 1;
        }
      }
      rmSync(directory, { recursive: true, force: true });
      resolve(finalCode);
    };
    child.once("error", (error) => {
      console.error(`[${options.scope}] 启动真实 Vitest 失败：${error.message}`);
      finish(1);
    });
    child.once("exit", (code, signal) => finish(signal ? 1 : (code ?? 1)));
  });
}
