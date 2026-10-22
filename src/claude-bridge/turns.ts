// Submitting a prompt and following its turn to the end.
//
// Each turn gets a watcher that subscribes to the session's SSE stream *before* the prompt is
// submitted, so no early event is missed. The watcher keeps running after a pi_send call stops
// waiting, which lets pi_wait pick up the result later without re-subscribing.
import { ApiError, createSseConnection, type ApiClient, type Export, type SseEvent } from "../client/index.js";

export type TurnStatus = "completed" | "error" | "aborted";

export type TurnProgress = {
  /** "queued" until the session picks the prompt up. */
  phase: "queued" | "running";
  queuePosition?: number;
  /** Top-level tool calls so far; calls made inside another tool are not counted. */
  toolCalls: number;
  lastTool?: string;
};

export type TurnResult = {
  status: TurnStatus;
  error?: string;
  /** The last assistant message of the turn, or null when it wrote none. */
  reply: string | null;
  toolCalls: number;
  elapsedMs: number;
};

export type TurnSnapshot =
  | ({ requestId: string; sessionId: string; done: true } & TurnResult)
  | ({ requestId: string; sessionId: string; done: false; elapsedMs: number } & TurnProgress);

type Turn = {
  sessionId: string;
  startedAt: number;
  progress: TurnProgress;
  result: Promise<TurnResult>;
  settled: TurnResult | null;
};

export type TurnTrackerOptions = {
  api: ApiClient;
  baseUrl: string;
  headers: () => Record<string, string>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** How long to wait for the SSE stream to open before submitting. */
  openTimeoutMs?: number;
  /** Finished turns stay readable by pi_wait for this long. */
  keepFinishedMs?: number;
};

const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_KEEP_FINISHED_MS = 60 * 60_000;

export class TurnTracker {
  private readonly turns = new Map<string, Turn>();
  private readonly now: () => number;

  constructor(private readonly options: TurnTrackerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Subscribe, submit and start following the turn. Rejects when the prompt is not accepted. */
  async start(sessionId: string, prompt: string, requestId: string): Promise<void> {
    const existing = this.turns.get(requestId);
    if (existing) {
      if (existing.sessionId !== sessionId) throw new Error(`requestId ${requestId} 已用于另一个会话`);
      return; // a retry of a call this process already submitted
    }

    const { api } = this.options;
    const before = await api.exportSession(sessionId);
    const progress: TurnProgress = { phase: "running", toolCalls: 0 };
    const startedAt = this.now();

    let opened!: () => void;
    const openedPromise = new Promise<void>((resolve) => { opened = resolve; });
    let finish!: (result: Omit<TurnResult, "reply" | "toolCalls" | "elapsedMs">) => void;
    const finished = new Promise<Omit<TurnResult, "reply" | "toolCalls" | "elapsedMs">>((resolve) => { finish = resolve; });
    let epoch: string | null = null;

    const connection = createSseConnection({
      url: `${this.options.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      headers: this.options.headers,
      fetch: this.options.fetch,
      lastEventId: before.lastEventId,
      onOpen: () => opened(),
      onEpoch: (next) => {
        // Event ids and live turns do not survive a server restart.
        if (epoch !== null && epoch !== next) finish({ status: "error", error: "pi-agent-server 重启了，这一轮的结果未知，请用 pi_get_session 查看记录" });
        epoch = next;
      },
      onNoLiveStream: () => finish({ status: "error", error: "这个会话没有可订阅的事件流（当前身份可能只有只读权限）" }),
      onEvent: (event) => {
        if (eventRequestId(event) !== requestId) return;
        switch (event.type) {
          case "queued":
            progress.phase = "queued";
            progress.queuePosition = event.position;
            break;
          case "status":
            progress.phase = "running";
            delete progress.queuePosition;
            break;
          case "tool_start":
            if (!event.parentToolCallId) {
              progress.toolCalls += 1;
              progress.lastTool = event.toolName;
            }
            break;
          case "completed":
            finish({ status: "completed" });
            break;
          case "aborted":
            finish({ status: "aborted" });
            break;
          case "error":
            finish({ status: "error", error: event.message });
            break;
        }
      },
    });

    try {
      await withTimeout(openedPromise, this.options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS, "连接会话事件流超时");
      const submitted = (await api.sendMessage(sessionId, { requestId, prompt })) as { status?: string; position?: number } | undefined;
      if (submitted?.status === "queued") {
        progress.phase = "queued";
        progress.queuePosition = submitted.position;
      }
    } catch (error) {
      connection.close();
      throw describeSubmitError(error);
    }

    const turn: Turn = { sessionId, startedAt, progress, settled: null, result: Promise.resolve(null as never) };
    turn.result = finished.then(async (end) => {
      connection.close();
      const result: TurnResult = {
        ...end,
        reply: await this.readReply(sessionId),
        toolCalls: progress.toolCalls,
        elapsedMs: this.now() - startedAt,
      };
      turn.settled = result;
      setTimeout(() => this.turns.delete(requestId), this.options.keepFinishedMs ?? DEFAULT_KEEP_FINISHED_MS).unref?.();
      return result;
    });
    this.turns.set(requestId, turn);
  }

  /** Whether this process is following (or recently followed) the turn. */
  has(requestId: string): boolean {
    return this.turns.has(requestId);
  }

  sessionOf(requestId: string): string | undefined {
    return this.turns.get(requestId)?.sessionId;
  }

  /** Wait up to `waitMs` for the turn; returns its progress when it is still going. */
  async wait(requestId: string, waitMs: number, signal?: AbortSignal): Promise<TurnSnapshot> {
    const turn = this.turns.get(requestId);
    if (!turn) throw new Error(`桥接没有在跟踪 requestId ${requestId}（可能是桥接重启过），请用 pi_get_session 查看记录`);
    if (!turn.settled && waitMs > 0) await raceWait(turn.result, waitMs, signal);
    const base = { requestId, sessionId: turn.sessionId };
    if (turn.settled) return { ...base, done: true, ...turn.settled };
    return { ...base, done: false, elapsedMs: this.now() - turn.startedAt, ...turn.progress };
  }

  private async readReply(sessionId: string): Promise<string | null> {
    try {
      return lastReply(await this.options.api.exportSession(sessionId));
    } catch {
      return null;
    }
  }
}

/** The last assistant message after the last user message. */
export function lastReply(exported: Export): string | null {
  const timeline = exported.timeline;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]!;
    if (item.type !== "message") continue;
    if (item.role === "user") return null;
    if (item.text.trim()) return item.text;
  }
  return null;
}

function eventRequestId(event: SseEvent): string | undefined {
  return "requestId" in event && typeof event.requestId === "string" ? event.requestId : undefined;
}

function describeSubmitError(error: unknown): Error {
  if (error instanceof ApiError) {
    if (error.status === 404) return new Error("会话不存在，或者当前身份看不到它");
    if (error.status === 409) return new Error(`提交被拒绝：${error.message}`);
    if (error.status === 429) return new Error(`服务繁忙：${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function raceWait(promise: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
      new Promise<void>((resolve) => { onAbort = resolve; signal?.addEventListener("abort", onAbort, { once: true }); }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
