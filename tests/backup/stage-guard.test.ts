// withStageTimeout reporter safety（P1）：StageReporter 的 start/timeout/done 一律安全
// 包装——reporter 抛错绝不能让 action 落入后台无人接管，也绝不能被 reporter 异常打断
// abort/结算。覆盖：
// - "start" 抛错：gate 仍正常等待并返回 action 结果（action 不被后台放弃）；
// - "done"（成功/失败）抛错：gate 仍以 action 的结果 resolve/reject；
// - "timeout" 抛错：abortable 阶段仍执行 abort 并等到 action 确认结算后才以
//   StageTimeoutError 拒绝；non-cancellable 阶段仍等到 action 真实结束后如实报告其错误；
// - 不抛错时 telemetry 顺序不被破坏（start→done / start→timeout）。

import { describe, expect, it } from "vitest";
import {
  StageTimeoutError,
  withStageTimeout,
  type PreMigrationStage,
} from "../../src/backup/stage-guard.js";

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("withStageTimeout: StageReporter 抛错必须无害（safe wrapper）", () => {
  it("reporter 在 'start' 抛错：action 仍完整运行并以其结果 resolve（不后台放弃、不提前拒绝）", async () => {
    let actionRuns = 0;
    await expect(
      withStageTimeout("target-resolve", 500, async () => {
        actionRuns += 1;
        await tick(5);
        return "value";
      }, undefined, () => {
        throw new Error("reporter exploded at start");
      }),
    ).resolves.toBe("value");
    expect(actionRuns).toBe(1);
  });

  it("reporter 在 'done'（成功路径）抛错：gate 仍 resolve 为 action 的值", async () => {
    let doneCalls = 0;
    await expect(
      withStageTimeout("pg-dump", 500, async () => 42, undefined, (_stage, state) => {
        if (state === "done") {
          doneCalls += 1;
          throw new Error("reporter exploded at done");
        }
      }),
    ).resolves.toBe(42);
    expect(doneCalls).toBe(1);
  });

  it("reporter 在 'done'（失败路径）抛错：gate 仍以 action 自身错误拒绝", async () => {
    await expect(
      withStageTimeout("age", 500, async () => {
        throw new Error("action failed");
      }, undefined, (_stage, state) => {
        if (state === "done") throw new Error("reporter exploded at done");
      }),
    ).rejects.toThrow("action failed");
  });

  it("abortable 阶段：reporter 在 'start'/'timeout' 都抛错也不打断 abort 与确认结算", async () => {
    const events: ("start" | "done" | "timeout")[] = [];
    let aborted = 0;
    let actionSettled = false;
    const action = () => new Promise<number>((resolve) => {
      setTimeout(() => {
        actionSettled = true;
        resolve(7);
      }, 60);
    });
    const gate = withStageTimeout("pg-dump", 20, action, {
      abort() { aborted += 1; },
    }, (_stage, state) => {
      events.push(state);
      throw new Error("reporter exploded on every callback");
    });
    await expect(gate).rejects.toBeInstanceOf(StageTimeoutError);
    expect(aborted).toBe(1);
    // gate 等到 action 的确认结算之后才拒绝，而不是被 reporter 异常打断后悬空。
    expect(actionSettled).toBe(true);
    expect(events).toContain("start");
    expect(events).toContain("timeout");
    expect(events).not.toContain("done");
  });

  it("non-cancellable 阶段：reporter 在 'timeout' 抛错仍等到 action 真实结束并如实报告其失败", async () => {
    let actionSettled = false;
    const action = () => new Promise<void>((_resolve, reject) => {
      setTimeout(() => {
        actionSettled = true;
        reject(new Error("late action failure"));
      }, 50);
    });
    const gate = withStageTimeout("reset", 20, action, undefined, () => {
      throw new Error("reporter exploded");
    });
    await expect(gate).rejects.toThrow("late action failure");
    expect(actionSettled).toBe(true);
  });

  it("reporter 不抛错时 telemetry 顺序保持 start→done（成功）与 start→timeout（超时）", async () => {
    const doneEvents: Array<[PreMigrationStage, "start" | "done"]> = [];
    await withStageTimeout("backup", 500, async () => 1, undefined, (stage, state) => {
      if (state !== "timeout") doneEvents.push([stage, state]);
    });
    expect(doneEvents).toEqual([["backup", "start"], ["backup", "done"]]);

    const timeoutEvents: ("start" | "done" | "timeout")[] = [];
    let aborted = 0;
    const lateAction = () => new Promise<void>((resolve) => setTimeout(resolve, 60));
    await expect(
      withStageTimeout("age", 20, lateAction, {
        abort() { aborted += 1; },
      }, (_stage, state) => { timeoutEvents.push(state); }),
    ).rejects.toBeInstanceOf(StageTimeoutError);
    expect(timeoutEvents).toEqual(["start", "timeout"]);
    expect(aborted).toBe(1);
  });
});