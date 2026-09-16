// model-failback 扩展经 Pi EventBus 发给宿主的最小生命周期协议。
// 该协议只描述扩展内部一次 failback 尝试；宿主在 SessionRuntime 中补上当前 requestId。

export const FAILBACK_LIFECYCLE_EVENT = "model-failback:lifecycle";

export type FailbackLifecycleEvent = {
  readonly version: 1;
  readonly phase: "start" | "end";
  readonly attemptId: string;
  readonly sessionId: string | null;
  readonly outcome?: "switched" | "no-target" | "failed" | "cancelled";
  /** Present on the terminal event after the engine selected a target; safe model identifiers only. */
  readonly from?: string;
  readonly to?: string;
  readonly reason?: string;
};

export type FailbackLifecycleSource = {
  on(channel: string, handler: (data: unknown) => void): () => void;
};

export function isFailbackLifecycleEvent(value: unknown): value is FailbackLifecycleEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<FailbackLifecycleEvent>;
  if (
    event.version !== 1 ||
    (event.phase !== "start" && event.phase !== "end") ||
    typeof event.attemptId !== "string" ||
    event.attemptId.length === 0 ||
    (event.sessionId !== null && typeof event.sessionId !== "string") ||
    (event.from !== undefined && typeof event.from !== "string") ||
    (event.to !== undefined && typeof event.to !== "string") ||
    (event.reason !== undefined && typeof event.reason !== "string")
  ) return false;
  return event.outcome === undefined ||
    event.outcome === "switched" ||
    event.outcome === "no-target" ||
    event.outcome === "failed" ||
    event.outcome === "cancelled";
}
