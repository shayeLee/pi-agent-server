// 任务状态机（needs.md §4.2）
// idle → queued → streaming → terminal；completed/aborted/error 后经 release 回到 idle。
// 非法转换返回 null（HTTP 409）。

export type TaskState = "idle" | "queued" | "streaming" | "terminal";

export type TaskEvent =
  | "submit" // messages：提交输入
  | "dequeue" // 从队列出队，开始流式
  | "complete" // 正常完成
  | "abort" // 中止（排队中取消 / 流式中止）
  | "fail" // 出错
  | "steer" // 流式中插入指令
  | "followUp" // 流式中追加指令
  | "release"; // 终态清理后回到 idle

const TABLE: Record<TaskState, Record<TaskEvent, TaskState | null>> = {
  idle: {
    submit: "queued",
    dequeue: null,
    complete: null,
    abort: null,
    fail: null,
    steer: null,
    followUp: null,
    release: null,
  },
  queued: {
    submit: null,
    dequeue: "streaming",
    complete: null,
    abort: "idle",
    fail: null,
    steer: null,
    followUp: null,
    release: null,
  },
  streaming: {
    submit: null,
    dequeue: null,
    complete: "terminal",
    abort: "terminal",
    fail: "terminal",
    steer: "streaming",
    followUp: "streaming",
    release: null,
  },
  terminal: {
    submit: null,
    dequeue: null,
    complete: null,
    abort: null,
    fail: null,
    steer: null,
    followUp: null,
    release: "idle",
  },
};

export function transition(state: TaskState, event: TaskEvent): TaskState | null {
  return TABLE[state][event];
}
