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
  /** active：会话已有活动任务；poisoned：abort 超时后不可复用；payload-mismatch：同 requestId 不同载荷。 */
  | { kind: "conflict"; reason?: "processing" | "active" | "poisoned" | "payload-mismatch" }
  | { kind: "done"; result: unknown };

/** 控制操作（steer/followUp/abort）的返回决策：ok（已执行）/ conflict（状态或 requestId 不允许）。 */
export type ControlDecision = { kind: "ok" } | { kind: "conflict"; reason?: "failback-in-progress" };

/**
 * runTurn 的入参：requestId 专属的同步轮次。
 * - owner 由调用方（插件宿主）绑定，runtime 不接受模型/tools/cwd/图片；
 * - signal 由上层按 HTTP disconnect 或 API revoke 触发，只终止本 requestId 对应的 task；
 * - maxAssistantTextLength 是本轮助手文本上限，超过即中止本轮并返回 error。
 */
export type RunTurnInput = {
  requestId: string;
  prompt: string;
  signal?: AbortSignal;
  maxAssistantTextLength?: number;
};

/** requestId 专属的同步轮次结果：文本/终态只属于该请求，绝不来自 session 级事件流。 */
export type SessionTurnResult =
  | { status: "completed"; text: string }
  | { status: "aborted" }
  | { status: "error"; message: string }
  | { status: "busy" };

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
  /** 中止当前任务；提供 expectedRequestId 时仅中止匹配的当前任务。 */
  abort(expectedRequestId?: string): Promise<ControlDecision>;
  /**
   * 同步执行一轮并返回该 requestId 专属结果。
   *
   * 与 submitMessage 不同，这里不读取 session 级事件流：助手文本与终态由 runtime 按
   * 当前 task 的 key 单独累计并结算，因此旧请求在 submit 异步窗口内到达的事件绝不会
   * 串入本请求。session 正忙（或排队）返回 busy 且不留后台任务。
   */
  runTurn(input: RunTurnInput): Promise<SessionTurnResult>;
  /** 导出会话数据（快照读取）。 */
  exportSession(): Promise<unknown>;
  /** 切换模型。 */
  setModel(provider: string, modelId: string): Promise<void>;
  /** 切换思考级别。 */
  setThinkingLevel(level: string): Promise<void>;
}

/** RuntimeRegistry 内部持有的运行时：应用端口 + 生命周期操作。 */
export interface ManagedSessionRuntimePort extends SessionRuntimePort, RuntimeLifecyclePort {}
