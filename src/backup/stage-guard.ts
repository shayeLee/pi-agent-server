// Bounded per-stage safety for the offline pre-migration backup/apply gate.
//
// Every key external step (target resolve, pg_dump, archive list, age,
// migration apply, verify) gets a safe stage label and a hard budget so the
// gate fails fast at the exact hanging step instead of an opaque global
// timeout. Stage labels are never secret-bearing and never contain a URL.
//
// Timeout lifecycle contract (P1): a stage budget is a SAFETY decision, not a
// way to hand control back while work is still running. Two stage classes:
//
// - Abortable stages (external children: pg_dump, age, pg_restore --list):
//   on timeout the abort kills the child, then the gate waits for the
//   CONFIRMED settlement of the action (its own finally closes streams and
//   removes temp files) BEFORE the StageTimeoutError is returned. The gate
//   never returns while the action may still be running.
// - Non-cancellable stages (DB/file mutations: reset, migration apply/verify,
//   backup verify, target resolve): there is no safe cancellation, so the
//   gate does NOT return to the caller at all when the budget fires. It only
//   RECORDS the timeout (reporter state "timeout") and BLOCKS every later
//   stage, waiting for the action's real settlement; only then does the
//   caller receive the safe error (the action's own failure, or — when the
//   late action actually completed — a StageTimeoutError, because the
//   over-budget run still fails closed). Real DB cancellation, once
//   implemented, can upgrade these stages to abortable.

export type PreMigrationStage =
  | "target-resolve"
  | "pg-dump"
  | "archive-list"
  | "age"
  | "backup"
  | "backup-verify"
  | "reset"
  | "migration-apply"
  | "migration-verify";

/** Bounded budgets for the backup core's external steps.
 *
 * Sizing (measured by tests/backup/age-stream.test.ts): real age encrypts tens
 * of MiB per second while actual prebackup payloads are KB–MB, so payload time
 * is milliseconds. These budgets bound a hung or never-scheduled external step
 * (spawn/scheduling/flush latency under a fully parallel test/CI load), not
 * payload throughput. Each is overridable via `stageTimeoutMs`. On timeout an
 * abortable stage kills its child and the gate waits for the confirmed
 * settlement before returning.
 */
export const BACKUP_STAGE_BUDGET_MS = {
  targetResolve: 10_000,
  pgDump: 20_000,
  archiveList: 20_000,
  /** Must stay >= the default inner age child budget (AGE_PROCESS_TIMEOUT_MS). */
  age: 60_000,
} as const;

/** Bounded budgets for the orchestration steps in applyWithPreMigrationBackup.
 *
 * `backup` bounds the whole createBackup sequence (target-resolve + binary
 * preflights + pg-dump + archive-list + age). It is a loose worst-case backstop
 * above the dominant sub-stage budget, not a sum: real volumes are KB–MB and
 * the standalone WP3C gate completes in well under a second.
 *
 * `reset`/`migrationApply`/`migrationVerify`/`backupVerify` are
 * NON-CANCELLABLE mutation/verification stages: when their budget fires the
 * gate blocks (no return to the CLI, no later stage) until the running action
 * really settles. The budgets therefore bound how late a run may FINISH, not
 * when the caller hears about it.
 */
export const APPLY_STAGE_BUDGET_MS = {
  backup: 90_000,
  backupVerify: 10_000,
  /** Controlled cutover only: local file deletion or one-schema DDL; milliseconds in practice. */
  reset: 30_000,
  migrationApply: 20_000,
  migrationVerify: 20_000,
} as const;

export class StageTimeoutError extends Error {
  readonly stage: PreMigrationStage;
  readonly timeoutMs: number;
  constructor(stage: PreMigrationStage, timeoutMs: number) {
    super(`[pre-migration:${stage}] exceeded the ${timeoutMs}ms safety budget; the gate waited for the stage to settle before failing (no result was returned while the stage was still running)`);
    this.name = "StageTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

export interface StageReporter {
  (stage: PreMigrationStage, state: "start" | "done" | "timeout"): void;
}

/** Best-effort cancel handle so a hung child process can be killed on timeout. */
export interface StageAbort {
  abort(): void | Promise<void>;
}

/**
 * Run `action` under a hard `timeoutMs` budget for `stage`.
 *
 * Timeout lifecycle:
 * - While the action runs past the budget, the returned promise NEVER
 *   settles: no timeout result is handed back while the action may still be
 *   mutating state.
 * - With an `abort` (abortable external-child stage): the abort is invoked
 *   once, then the gate waits UNCONDITIONALLY for the action to settle (the
 *   killed child and the action's own finally are confirmed done) before
 *   rejecting with a StageTimeoutError naming the stage. A late success value
 *   is discarded; the timeout decision wins.
 * - Without an `abort` (non-cancellable DB/mutation stage): the gate only
 *   records the timeout via `report(stage, "timeout")` and keeps blocking
 *   (every later stage is unreachable because this promise stays pending).
 *   When the action really settles, the caller receives the action's own
 *   error if it failed, or a StageTimeoutError if it completed late — the
 *   over-budget run still fails closed and never reports success.
 * - A late action outcome therefore can never surface as an unhandled
 *   rejection and can never race the caller's cleanup.
 */
export function withStageTimeout<T>(
  stage: PreMigrationStage,
  timeoutMs: number,
  action: () => Promise<T>,
  abort?: StageAbort,
  report?: StageReporter,
): Promise<T> {
  const actionPromise = Promise.resolve().then(action);
  // The handlers below are the single consumer of this promise; this extra
  // catch only prevents an unhandled rejection when a timeout has already
  // abandoned a still-running (or later-failing) action.
  actionPromise.catch(() => undefined);
  // Best-effort telemetry only: a throwing reporter must never derail the
  // stage lifecycle. It must not let an early "start" throw bounce the gate
  // promise while the action keeps running in the background, and it must not
  // interrupt the timeout continuation (abort + confirmed settlement) or the
  // success/error settlement below.
  const safeReport: StageReporter | undefined = report
    ? (reportedStage, state) => {
        try {
          report(reportedStage, state);
        } catch {
          // Telemetry errors are swallowed: the gate's safety lifecycle wins.
        }
      }
    : undefined;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    // Set SYNCHRONOUSLY when the budget fires, so the action's own handlers
    // below can never win the race and resolve/reject the gate before the
    // timeout continuation has waited for the confirmed settlement.
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled || timedOut) return;
      timedOut = true;
      // Budget exhausted. Record the timeout and keep blocking: the promise
      // below must not settle until the action itself has settled.
      safeReport?.(stage, "timeout");
      void (async () => {
        if (abort) {
          try { await abort.abort(); } catch { /* best-effort kill */ }
        }
        // Confirmed settlement: wait for the real action outcome, however
        // long the aborted child/action takes to wind down. An abortable
        // action fails (the child was killed); a non-cancellable action may
        // still succeed late — either way the caller only hears about it now.
        const outcome = await actionPromise.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        if (settled) return;
        settled = true;
        if (abort) {
          // The abort caused (or raced) the failure; the timeout is the
          // meaningful, safe error for the caller.
          reject(new StageTimeoutError(stage, timeoutMs));
          return;
        }
        if (outcome.ok) {
          // The non-cancellable stage completed after the budget was spent:
          // the run still fails closed (never success over budget).
          reject(new StageTimeoutError(stage, timeoutMs));
          return;
        }
        reject(outcome.error);
      })();
    }, timeoutMs);
    safeReport?.(stage, "start");
    actionPromise.then(
      (value) => {
        if (settled || timedOut) return;
        settled = true;
        clearTimeout(timer);
        safeReport?.(stage, "done");
        resolve(value);
      },
      (error) => {
        if (settled || timedOut) return;
        settled = true;
        clearTimeout(timer);
        safeReport?.(stage, "done");
        reject(error);
      },
    );
  });
}
