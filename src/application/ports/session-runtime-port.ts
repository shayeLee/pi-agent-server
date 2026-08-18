// SessionRuntimePort：面向 HTTP/application 层的会话运行时端口（submitMessage、steer、followUp、abort、exportSession、setModel、setThinkingLevel）。
// RuntimeRegistry 的 SessionEntry 通过该 port 接口暴露给 server/app，避免 HTTP 层依赖 SessionRuntime concrete class。
// SubmitDecision / ControlDecision 定义在此处，由 SessionRuntime 实现并由 HTTP 层消费。

import type { ImageInput } from "../../agent/agent-adapter.js";
import type { TaskState } from "../../core/task-state-machine.js";
import type { RuntimeLifecyclePort } from "./runtime-lifecycle-port.js";

/** submitMessage 的入参（精简自 SessionRuntimeOptions 中的提交字段）。 */
export type SubmitInput = {
  requestId: string;
  userId: string;
  prompt: string;
  parentId?: string;
  images?: ImageInput[];
};

/** submitMessage 的返回决策：run（立即执行）/ queued（排队等待）/ rejected（限流）/ conflict（状态不允许）/ done（幂等命中）。 */
export type SubmitDecision =
  | { kind: "run" }
  | { kind: "queued"; position?: number }
  | { kind: "rejected"; reason: "user-queue-full" | "global-overload" }
  | { kind: "conflict"; reason?: "processing" | "active" | "poisoned" }
  | { kind: "done"; result: unknown };

/** 控制操作（steer/followUp/abort）的返回决策：ok（已执行）/ conflict（状态不允许）。 */
export type ControlDecision = { kind: "ok" } | { kind: "conflict" };

/** 面向 HTTP/application 的会话运行时端口。 */
export interface SessionRuntimePort {
  /** 会话标识（只读）。 */
  readonly sessionId: string;
  /** 当前任务状态（idle/queued/streaming/terminal）。 */
  readonly state: TaskState;

  /** 发送输入（幂等 + 状态机 + 并发 + 异步流式）。 */
  submitMessage(input: SubmitInput): Promise<SubmitDecision>;
  /** 流式中插入指令。 */
  steer(text: string): Promise<ControlDecision>;
  /** 流式中追加指令。 */
  followUp(text: string): Promise<ControlDecision>;
  /** 中止当前任务。 */
  abort(): Promise<ControlDecision>;
  /** 导出会话数据（快照读取）。 */
  exportSession(): Promise<unknown>;
  /** 切换模型。 */
  setModel(provider: string, modelId: string): Promise<void>;
  /** 切换思考级别。 */
  setThinkingLevel(level: string): Promise<void>;
}

/** RuntimeRegistry 内部持有的运行时：应用端口 + 生命周期操作。 */
export interface ManagedSessionRuntimePort extends SessionRuntimePort, RuntimeLifecyclePort {}
