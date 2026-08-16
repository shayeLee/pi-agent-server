import { describe, it, expect } from "vitest";
import { transition, type TaskState, type TaskEvent } from "../src/core/task-state-machine.js";

// 快速断言辅助：断言某个转换合法并返回期望状态
function ok(state: TaskState, event: TaskEvent, expected: TaskState): void {
  expect(transition(state, event)).toBe(expected);
}

// 断言某个转换非法（返回 null → 409）
function forbidden(state: TaskState, event: TaskEvent): void {
  expect(transition(state, event)).toBeNull();
}

describe("任务状态机（README §4.2）", () => {
  describe("合法转换", () => {
    it("空闲时提交进入队列", () => ok("idle", "submit", "queued"));
    it("排队任务出队进入流式", () => ok("queued", "dequeue", "streaming"));
    it("排队任务可中止，从队列移除回到空闲", () => ok("queued", "abort", "idle"));
    it("流式正常完成进入终态", () => ok("streaming", "complete", "terminal"));
    it("流式中止进入终态", () => ok("streaming", "abort", "terminal"));
    it("流式出错进入终态", () => ok("streaming", "fail", "terminal"));
    it("流式中可插入指令（steer，状态不变）", () => ok("streaming", "steer", "streaming"));
    it("流式中可追加指令（followUp，状态不变）", () => ok("streaming", "followUp", "streaming"));
    it("终态释放后回到空闲", () => ok("terminal", "release", "idle"));
  });

  describe("非法转换（返回 null → 409）", () => {
    it("空闲时 steer 非法", () => forbidden("idle", "steer"));
    it("空闲时 followUp 非法", () => forbidden("idle", "followUp"));
    it("空闲时 abort 非法", () => forbidden("idle", "abort"));
    it("空闲时 complete 非法", () => forbidden("idle", "complete"));
    it("空闲时 dequeue 非法", () => forbidden("idle", "dequeue"));
    it("空闲时 release 非法", () => forbidden("idle", "release"));

    it("排队时 submit（messages）非法 → 409", () => forbidden("queued", "submit"));
    it("排队时 steer 非法（不接受）", () => forbidden("queued", "steer"));
    it("排队时 followUp 非法（不接受）", () => forbidden("queued", "followUp"));
    it("排队时 complete 非法", () => forbidden("queued", "complete"));
    it("排队时 fail 非法", () => forbidden("queued", "fail"));
    it("排队时 release 非法", () => forbidden("queued", "release"));

    it("流式中 submit（messages）非法 → 409", () => forbidden("streaming", "submit"));
    it("流式中 dequeue 非法", () => forbidden("streaming", "dequeue"));
    it("流式中 release 非法", () => forbidden("streaming", "release"));

    it("终态时 submit 非法", () => forbidden("terminal", "submit"));
    it("终态时 complete 非法", () => forbidden("terminal", "complete"));
    it("终态时 abort 非法", () => forbidden("terminal", "abort"));
    it("终态时 steer 非法", () => forbidden("terminal", "steer"));
    it("终态时 followUp 非法", () => forbidden("terminal", "followUp"));
    it("终态时 dequeue 非法", () => forbidden("terminal", "dequeue"));
  });

  describe("完整生命周期", () => {
    it("submit → dequeue → complete → release 回到 idle", () => {
      let s: TaskState = "idle";
      s = transition(s, "submit")!;
      s = transition(s, "dequeue")!;
      s = transition(s, "complete")!;
      s = transition(s, "release")!;
      expect(s).toBe("idle");
    });

    it("submit → dequeue → abort → release 回到 idle", () => {
      let s: TaskState = "idle";
      s = transition(s, "submit")!;
      s = transition(s, "dequeue")!;
      s = transition(s, "abort")!;
      s = transition(s, "release")!;
      expect(s).toBe("idle");
    });

    it("submit → abort（排队中取消）直接回 idle，无需 release", () => {
      let s: TaskState = "idle";
      s = transition(s, "submit")!;
      s = transition(s, "abort")!;
      expect(s).toBe("idle");
    });
  });
});
