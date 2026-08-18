// 观测订阅口（阶段 5）：服务端运维/审计通道，独立于面向客户端的 SSE 事件流。
// 事件只含脱敏后的结构化信息，绝不携带凭证、完整系统提示词、原始模型内容或敏感工具结果。

/** 观测事件（结构化、脱敏）。 */
export type ObservabilityEvent =
  | {
      type: "turn";
      sessionId: string;
      requestId: string;
      outcome: "completed" | "error" | "aborted";
      durationMs: number;
      ttftMs: number;
    }
  | {
      type: "usage";
      sessionId: string;
      requestId: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }
  | { type: "queue"; sessionId: string; requestId: string; position?: number }
  | { type: "queue_expired"; sessionId: string; requestId: string }
  | { type: "error"; sessionId: string; requestId: string; message: string };

/** 观测订阅口：会话核心在关键路径调用 observe 推送脱敏观测事件。 */
export interface ObservabilityPort {
  observe(event: ObservabilityEvent): void;
}
