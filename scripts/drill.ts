#!/usr/bin/env node
// 备份 freshness 演练 runner CLI（真实一键演习执行器）。
// 命令：
// - preflight：安全门禁，全部通过才 PASS；否则 FAIL。
// - run：完整执行隔离演练（先做完整 preflight；再跑默认 DrillPlan），输出真实 PASS/FAIL/DEFERRED。
//        绝不伪造 PASS：判定只信任执行器真实采集的 observations；先决条件缺失（podman/age/pg 工具）
//        才 DEFERRED，其余任何未通过步骤均 FAIL。
// - cleanup：先执行完整 preflight，通过后只清空已知运行/临时子目录，固定保留 secrets。

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cleanupRunDirectories,
  collectRedactables,
  preflightDrill,
  redactText,
  defaultDrillPlan,
  resolveDrillRoot,
  type DrillEnv,
} from "../src/drill/drill-core.js";
import { LiveDrillExecutor, resolveExecutorContext, runDrill } from "../src/drill/drill-exec.js";
import { acquireDrillRunLock, releaseDrillRunLock } from "../src/drill/drill-run-lock.js";

const COMMANDS = ["preflight", "cleanup", "run"] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = "用法：pi-agent-server-drill <preflight|cleanup|run> [--help]";

function parseDrillArgs(args: readonly string[]): Command {
  const actual = args[0] === "--" ? args.slice(1) : args;
  if (actual.length === 0) throw new Error(USAGE);
  if (actual[0] === "--help" || actual[0] === "-h") throw new Error(USAGE);
  if (actual.length > 1) throw new Error("用法：pi-agent-server-drill 只接受一个命令");
  const command = actual[0] as string;
  if (!(COMMANDS as readonly string[]).includes(command)) throw new Error(USAGE);
  return command as Command;
}

function isCliEntry(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function exitCodeFor(outcome: string): number {
  return outcome === "PASS" ? 0 : outcome === "DEFERRED" ? 3 : 2;
}

async function main(): Promise<void> {
  const command = parseDrillArgs(process.argv.slice(2));
  const env = process.env as DrillEnv;
  const redactables = collectRedactables(env);
  const emit = (value: unknown): void => {
    console.log(redactText(JSON.stringify(value), redactables));
  };

  if (command === "preflight") {
    const verdict = preflightDrill(env);
    emit({ outcome: verdict.outcome, summary: verdict.summary, checks: verdict.checks });
    process.exitCode = verdict.outcome === "PASS" ? 0 : 2;
    return;
  }

  if (command === "cleanup") {
    const cleanupPreflight = preflightDrill(env);
    if (cleanupPreflight.outcome !== "PASS") {
      emit({ outcome: "FAIL", summary: "cleanup blocked by preflight", checks: cleanupPreflight.checks });
      process.exitCode = 2;
      return;
    }
    const lock = acquireDrillRunLock(resolveDrillRoot(env));
    let result: ReturnType<typeof cleanupRunDirectories>;
    try {
      // cleanupRunDirectories deliberately repeats the full preflight while the
      // lock is held, closing the validation-to-deletion window.
      result = cleanupRunDirectories(env);
    } finally {
      releaseDrillRunLock(lock);
    }
    emit({ outcome: "PASS", summary: "cleanup ok", removedRuns: result.removedRuns, cleared: result.cleared, preservedSecrets: result.preservedSecrets });
    process.exitCode = 0;
    return;
  }

  // run：完整 preflight 先决（失败即回收并退出非零）。
  const preflight = preflightDrill(env);
  if (preflight.outcome !== "PASS") {
    emit({ outcome: "FAIL", summary: "run blocked by preflight", checks: preflight.checks });
    process.exitCode = 2;
    return;
  }
  const plan = defaultDrillPlan();
  const ctx = resolveExecutorContext(env);
  const executor = new LiveDrillExecutor(ctx);
  const runLock = acquireDrillRunLock(ctx.root);
  let runId: string | null = null;
  let result: Awaited<ReturnType<typeof runDrill>> | null = null;
  let executionError: string | null = null;
  let cleanupError: string | null = null;
  try {
    result = await runDrill(executor, env, plan);
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
  }
  try {
    await executor.cleanup();
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error);
  }
  try {
    releaseDrillRunLock(runLock);
  } catch (error) {
    cleanupError ??= error instanceof Error ? error.message : String(error);
  }
  if (result !== null) {
    const finalAdjudication = cleanupError === null
      ? result.adjudication
      : { ...result.adjudication, outcome: "FAIL" as const, summary: "drill fail: resource cleanup failed" };
    try {
      // Final evidence is written only after Podman resources and the run lock
      // have been verified cleaned, so a persisted PASS includes cleanup.
      runId = await executor.writeEvidence(finalAdjudication, plan, result.observations, cleanupError === null);
    } catch {
      executionError ??= "evidence write failed";
    }
    const judgment = {
      outcome: finalAdjudication.outcome,
      summary: finalAdjudication.summary,
      mandatoryFailures: finalAdjudication.mandatoryFailures.map((o) => o.stepId),
      faultFailures: finalAdjudication.faultFailures.map((f) => `${f.fault}:guard=${f.guardOk ? "ok" : "fail"}:recovery=${f.recoveryOk ? "ok" : "fail"}`),
    };
    if (executionError === null) {
      emit({ outcome: judgment.outcome, summary: judgment.summary, runId, versions: judgment.outcome === "PASS" ? "checked" : undefined, mandatoryFailures: judgment.mandatoryFailures, faultFailures: judgment.faultFailures, evidencePreserved: true, resourcesCleaned: cleanupError === null });
      process.exitCode = exitCodeFor(judgment.outcome);
      return;
    }
  }
  emit({ outcome: "FAIL", summary: executionError !== null ? "execution failed" : "resource cleanup failed", runId, evidencePreserved: runId !== null, resourcesCleaned: cleanupError === null });
  process.exitCode = 2;
}

if (isCliEntry()) {
  void main().catch((error: unknown) => {
    const redactables = collectRedactables(process.env as DrillEnv);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[drill] ${redactText(message, redactables)}`);
    process.exitCode = 2;
  });
}
