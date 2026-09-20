import { describe, it, expect, vi } from "vitest";
import { SessionRuntime, getExpireHandler } from "../../src/runtime/session-runtime.js";
import {
  ConcurrencyController,
  type ConcurrencyConfig,
} from "../../src/core/concurrency-control.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { ImageInput } from "../../src/agent/agent-adapter.js";
import type { SseEvent } from "../../src/agent/events.js";
import type { ObservabilityEvent, ObservabilityPort } from "../../src/application/ports/index.js";
import { TURN_ERROR_CODES } from "../../src/application/ports/session-runtime-port.js";
import { JPEG_2X2_BASE64, PNG_2X2_BASE64 } from "../helpers/image-fixtures.js";

const baseConfig: ConcurrencyConfig = {
  globalLimit: 2,
  perUserLimit: 2,
  perUserQueueLimit: 2,
  globalQueueLimit: 4,
  queueTimeoutMs: 5000,
};

/** 等待后台流式任务完成（submitMessage 立即返回决策后，runStreamingTask 在微任务中继续）。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 真实墙钟等待（时间预算用例用真实 timer，见 session-runtime 的 armTurnDeadline 注释）。 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 可控 adapter：prompt 先按基线行为发射预设事件（重置丢弃标记），再挂起直到 finishStream() 释放
 * （模拟真实异步流式结束，便于观察 streaming 中间态；也让 abort 后可直接 enqueue 下一轮事件）。 */
class ManualAdapter extends MockAgentAdapter {
  private release?: () => void;

  override async prompt(text: string, options?: { images?: ImageInput[] }): Promise<void> {
    await super.prompt(text, options);
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  finishStream(): void {
    this.release?.();
  }
}

/** prompt 直接抛错的 adapter：验证失败路径（合成 error）。 */
class ThrowingAdapter extends MockAgentAdapter {
  override async prompt(text: string): Promise<void> {
    this.calls.push({ method: "prompt", text });
    throw new Error("模型挂了");
  }
}

/** prompt 挂起、abort 抛错的 adapter：验证 abort 失败 → poisoned 会话拒绝复用。 */
class AbortThrowingAdapter extends ManualAdapter {
  override async abort(): Promise<void> {
    this.calls.push({ method: "abort" });
    throw new Error("abort 失败");
  }
}

/** abort 挂起，便于验证 aborting 窗口中的 requestId 精确关联。 */
class AbortPendingAdapter extends ManualAdapter {
  private releaseAbort?: () => void;

  override async abort(): Promise<void> {
    this.calls.push({ method: "abort" });
    await new Promise<void>((resolve) => {
      this.releaseAbort = resolve;
    });
  }

  finishAbort(): void {
    this.releaseAbort?.();
  }
}

class CollectingObservability implements ObservabilityPort {
  readonly events: ObservabilityEvent[] = [];
  observe(event: ObservabilityEvent): void {
    this.events.push(event);
  }
}

function makeRuntime(opts: {
  config?: ConcurrencyConfig;
  concurrency?: ConcurrencyController;
  sessionId?: string;
  adapter?: MockAgentAdapter;
  observability?: ObservabilityPort;
  now?: () => number;
} = {}) {
  const events: SseEvent[] = [];
  const concurrency =
    opts.concurrency ?? new ConcurrencyController(opts.config ?? baseConfig);
  const adapter = opts.adapter ?? new MockAgentAdapter();
  const sessionId = opts.sessionId ?? "session-1";
  const runtime = new SessionRuntime({
    sessionId,
    ownerKey: "owner-1",
    concurrency,
    adapter,
    now: opts.now ?? (() => 0),
    onEvent: (e) => events.push(e),
    observability: opts.observability,
  });
  return { runtime, events, concurrency, adapter, sessionId };
}

describe("SessionRuntime（needs.md §4.2 会话任务编排）", () => {
  describe("submitMessage：幂等与状态机", () => {
    it("idle submit 成功进 streaming，SDK 事件翻译输出、完成合成 completed 并回 idle", async () => {
      const adapter = new MockAgentAdapter([
        { type: "agent_start" },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
        },
        { type: "agent_end", messages: [], willRetry: false },
      ]);
      const { runtime, events, concurrency } = makeRuntime({ adapter });

      const d = await runtime.submitMessage({
        requestId: "r1",
        userId: "user-1",
        prompt: "你好",
      });
      await flush();

      expect(d).toEqual({ kind: "run" });
      expect(events).toEqual([
        { type: "status", phase: "agent_start", requestId: "r1" },
        { type: "text_delta", text: "hi", requestId: "r1" },
        { type: "completed", requestId: "r1" },
      ]);
      expect(runtime.state).toBe("idle"); // 流式结束 → release 回 idle
      expect(concurrency.activeCount()).toBe(0); // 槽位已释放
      expect(adapter.calls).toEqual([{ method: "prompt", text: "你好" }]);
    });

    it("SDK 事件翻译全链路：工具/文本/状态事件正确输出，无关事件忽略", async () => {
      const adapter = new MockAgentAdapter([
        { type: "agent_start" },
        { type: "turn_start" },
        {
          type: "tool_execution_start",
          toolCallId: "c1",
          toolName: "read",
          args: { path: "a.txt" },
        },
        {
          type: "tool_execution_update",
          toolCallId: "c1",
          toolName: "read",
          args: {},
          partialResult: { lines: ["a"] },
        },
        {
          type: "tool_execution_end",
          toolCallId: "c1",
          toolName: "read",
          result: { text: "内容" },
          isError: false,
        },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" },
        },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "思考中" },
        },
        { type: "message_start", message: {} },
        { type: "agent_end", messages: [], willRetry: false },
      ]);
      const { runtime, events } = makeRuntime({ adapter });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      await flush();

      expect(events).toEqual([
        { type: "status", phase: "agent_start", requestId: "r1" },
        { type: "status", phase: "turn_start", requestId: "r1" },
        { type: "tool_start", toolCallId: "c1", toolName: "read", args: { path: "a.txt" }, requestId: "r1" },
        { type: "tool_update", toolCallId: "c1", toolName: "read", partialResult: { lines: ["a"] }, requestId: "r1" },
        { type: "tool_end", toolCallId: "c1", toolName: "read", result: { text: "内容" }, isError: false, requestId: "r1" },
        { type: "text_delta", text: "你好", requestId: "r1" },
        { type: "thinking_delta", text: "思考中", requestId: "r1" },
        { type: "completed", requestId: "r1" }, // agent_end 由编排层合成，不重复转发
      ]);
    });

    it("重复 requestId 且载荷相同返回 done，不重复执行", async () => {
      const adapter = new MockAgentAdapter([
        { type: "agent_end", messages: [], willRetry: false },
      ]);
      const { runtime, events } = makeRuntime({ adapter });

      const d1 = await runtime.submitMessage({
        requestId: "r1",
        userId: "user-1",
        prompt: "首次",
      });
      await flush();
      expect(d1).toEqual({ kind: "run" });
      expect(events).toEqual([{ type: "completed", requestId: "r1" }]);

      const d2 = await runtime.submitMessage({
        requestId: "r1",
        userId: "user-1",
        prompt: "首次",
      });
      expect(d2).toEqual({ kind: "done", result: { status: "completed" } });
      expect(adapter.calls).toEqual([{ method: "prompt", text: "首次" }]); // 未重复执行
      expect(events).toEqual([{ type: "completed", requestId: "r1" }]); // 未新增事件
    });

    it("重复 requestId 但载荷不同：payload-mismatch，不返回旧结果也不执行", async () => {
      const adapter = new MockAgentAdapter([
        { type: "agent_end", messages: [], willRetry: false },
      ]);
      const { runtime } = makeRuntime({ adapter });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "首次" });
      await flush();

      const differentPrompt = await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "不同" });
      expect(differentPrompt).toEqual({ kind: "conflict", reason: "payload-mismatch" });
      // 载荷指纹不同（包括图片）同样识别
      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "首次" });
      const differentImages = await runtime.submitMessage({
        requestId: "r1",
        userId: "user-1",
        prompt: "首次",
        images: [{ mediaType: "image/png", base64: PNG_2X2_BASE64 }],
      });
      expect(differentImages).toEqual({ kind: "conflict", reason: "payload-mismatch" });
      expect(adapter.calls).toEqual([{ method: "prompt", text: "首次" }]); // 只有首次执行
    });

    it("运行期同 requestId 不同载荷并发提交：不共享 in-flight，返回 payload-mismatch", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      expect(runtime.state).toBe("streaming");

      const d = await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "不同" });
      expect(d).toEqual({ kind: "conflict", reason: "payload-mismatch" });
      expect(adapter.calls.filter((c) => c.method === "prompt")).toHaveLength(1);

      await runtime.abort();
    });

    it("运行期同 requestId 重试（processing）：streaming 时返回 run（已接受，不重复执行）", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      expect(runtime.state).toBe("streaming");

      // 丢失 202 后重试：processing 占位应返回「已接受」，不重复执行
      const d = await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      expect(d).toEqual({ kind: "run" });
      expect(adapter.calls.filter((c) => c.method === "prompt")).toHaveLength(1);

      await runtime.abort();
    });

    it("运行期同 requestId 重试（processing）：queued 时返回 queued（省略 position）", async () => {
      const concurrency = new ConcurrencyController({ ...baseConfig, perUserLimit: 1 });
      concurrency.submit("other:task", "user-1", 0); // 占用唯一槽位
      const { runtime } = makeRuntime({ concurrency });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      expect(runtime.state).toBe("queued");

      const d = await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      expect(d).toEqual({ kind: "queued" }); // 省略 position，不伪造队列位置

      await runtime.abort();
    });

    it("带 parentId 提交：先 navigateTree 再 prompt（从历史节点重跑）", async () => {
      const adapter = new MockAgentAdapter([
        { type: "agent_end", messages: [], willRetry: false },
      ]);
      const { runtime } = makeRuntime({ adapter });

      const d = await runtime.submitMessage({
        requestId: "r1",
        userId: "user-1",
        prompt: "重新生成",
        parentId: "a1b2c3d4",
      });
      await flush();

      expect(d).toEqual({ kind: "run" });
      expect(adapter.calls).toEqual([
        { method: "navigateTree", targetId: "a1b2c3d4" },
        { method: "prompt", text: "重新生成" },
      ]);
    });

    it("非 idle（排队中）submit 返回 conflict", async () => {
      const concurrency = new ConcurrencyController({ ...baseConfig, perUserLimit: 1 });
      concurrency.submit("other:task", "user-1", 0); // 占用 user-1 唯一槽位
      const { runtime } = makeRuntime({ concurrency });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "p1" });
      expect(runtime.state).toBe("queued");

      const d = await runtime.submitMessage({ requestId: "r2", userId: "user-1", prompt: "p2" });
      expect(d).toEqual({ kind: "conflict", reason: "active" });

      await runtime.abort(); // 清理排队任务
    });

    it("非 idle（流式中）submit 返回 conflict", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });

      const run = runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "p1" });
      expect(runtime.state).toBe("streaming");

      const d = await runtime.submitMessage({ requestId: "r2", userId: "user-1", prompt: "p2" });
      expect(d).toEqual({ kind: "conflict", reason: "active" });

      await runtime.abort();
      await flush(); // 等 fire-and-forget settle 完成（release→idle）
      adapter.finishStream();
      await run;
      expect(runtime.state).toBe("idle");
    });
  });

  describe("并发控制接入", () => {
    it("超出并发上限排队：合成 queued 事件、返回排队决策", async () => {
      const concurrency = new ConcurrencyController({ ...baseConfig, perUserLimit: 1 });
      concurrency.submit("other:task", "user-1", 0); // 占用 user-1 唯一槽位
      const { runtime, events, adapter } = makeRuntime({ concurrency });

      const d = await runtime.submitMessage({
        requestId: "r1",
        userId: "user-1",
        prompt: "排队的问题",
      });

      expect(d).toEqual({ kind: "queued", position: 1 });
      expect(runtime.state).toBe("queued");
      expect(events).toEqual([{ type: "queued", position: 1, requestId: "r1" }]);
      expect(adapter.calls).toEqual([]); // 未开始执行

      await runtime.abort();
    });

    it("每用户队列满返回 rejected(user-queue-full)，状态回 idle", async () => {
      const concurrency = new ConcurrencyController({
        globalLimit: 1,
        perUserLimit: 1,
        perUserQueueLimit: 1,
        globalQueueLimit: 2,
        queueTimeoutMs: 5000,
      });
      concurrency.submit("t0", "user-1", 0); // run
      concurrency.submit("q1", "user-1", 0); // queue（每用户队列已满）
      const { runtime } = makeRuntime({ concurrency });

      const d = await runtime.submitMessage({
        requestId: "r1",
        userId: "user-1",
        prompt: "p",
      });
      expect(d).toEqual({ kind: "rejected", reason: "user-queue-full" });
      expect(runtime.state).toBe("idle");
    });

    it("全局队列满返回 rejected(global-overload)，状态回 idle", async () => {
      const concurrency = new ConcurrencyController({
        globalLimit: 1,
        perUserLimit: 1,
        perUserQueueLimit: 2,
        globalQueueLimit: 1,
        queueTimeoutMs: 5000,
      });
      concurrency.submit("t0", "user-0", 0); // run（全局占满）
      concurrency.submit("q1", "user-2", 0); // queue（全局队列已满）
      const { runtime } = makeRuntime({ concurrency });

      const d = await runtime.submitMessage({
        requestId: "r1",
        userId: "user-1",
        prompt: "p",
      });
      expect(d).toEqual({ kind: "rejected", reason: "global-overload" });
      expect(runtime.state).toBe("idle");
    });

    it("排队超时：expireQueued 触发 handleExpired，清理排队、合成 error、释放幂等", async () => {
      const concurrency = new ConcurrencyController({
        globalLimit: 1,
        perUserLimit: 1,
        perUserQueueLimit: 2,
        globalQueueLimit: 4,
        queueTimeoutMs: 1000,
      });
      const { runtime, events, sessionId } = makeRuntime({ concurrency });

      // 占用唯一槽位
      concurrency.submit("holder:task", "user-1", 0);
      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "排队" });
      expect(runtime.state).toBe("queued");

      // 时钟前进超过 queueTimeoutMs，扫描出过期任务并触发处理
      const taskId = `${sessionId}:r1`;
      expect(concurrency.expireQueued(1000)).toContain(taskId);
      getExpireHandler(taskId)?.();

      expect(runtime.state).toBe("idle");
      expect(concurrency.queuedCount()).toBe(0);
      expect(events).toContainEqual({ type: "error", message: "排队超时", requestId: "r1" });
    });
  });

  describe("steer / followUp / abort 控制", () => {
    it("idle 时 steer/followUp/abort 返回 conflict（409 语义）", async () => {
      const { runtime } = makeRuntime();
      expect(await runtime.steer("x")).toEqual({ kind: "conflict" });
      expect(await runtime.followUp("x")).toEqual({ kind: "conflict" });
      expect(await runtime.abort()).toEqual({ kind: "conflict" });
    });

    it("排队中 steer/followUp 返回 conflict", async () => {
      const concurrency = new ConcurrencyController({ ...baseConfig, perUserLimit: 1 });
      concurrency.submit("other:task", "user-1", 0);
      const { runtime } = makeRuntime({ concurrency });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "p" });
      expect(runtime.state).toBe("queued");

      expect(await runtime.steer("改")).toEqual({ kind: "conflict" });
      expect(await runtime.followUp("追加")).toEqual({ kind: "conflict" });

      await runtime.abort();
    });

    it("流式中 steer/followUp 转发 adapter 并保持 streaming", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });

      const run = runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "问题" });
      expect(runtime.state).toBe("streaming");

      expect(await runtime.steer("打断")).toEqual({ kind: "ok" });
      expect(await runtime.followUp("追加指令")).toEqual({ kind: "ok" });
      expect(adapter.calls).toEqual([
        { method: "prompt", text: "问题" },
        { method: "steer", text: "打断" },
        { method: "followUp", text: "追加指令" },
      ]);
      expect(runtime.state).toBe("streaming"); // 控制不改变状态

      adapter.finishStream();
      await run;
    });

    it("abort queued：取消排队、状态回 idle、合成 aborted 事件", async () => {
      const concurrency = new ConcurrencyController({ ...baseConfig, perUserLimit: 1 });
      concurrency.submit("other:task", "user-1", 0);
      const { runtime, events, adapter } = makeRuntime({ concurrency });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "p" });
      expect(runtime.state).toBe("queued");

      const d = await runtime.abort();
      expect(d).toEqual({ kind: "ok" });
      expect(runtime.state).toBe("idle");
      expect(concurrency.queuedCount()).toBe(0); // 排队任务已从队列移除
      expect(adapter.calls).toEqual([]);
      expect(events).toEqual([{ type: "queued", position: 1, requestId: "r1" }, { type: "aborted", requestId: "r1" }]);
    });

    it("指定不匹配 requestId 的 abort 不取消 queued/streaming 任务，且零 adapter.abort/aborted 事件", async () => {
      const queuedConcurrency = new ConcurrencyController({ ...baseConfig, perUserLimit: 1 });
      queuedConcurrency.submit("other:task", "user-1", 0);
      const { runtime: queuedRuntime, events: queuedEvents, adapter: queuedAdapter } = makeRuntime({ concurrency: queuedConcurrency });
      await queuedRuntime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "p" });

      expect(await queuedRuntime.abort("other-request")).toEqual({ kind: "conflict" });
      expect(queuedRuntime.state).toBe("queued");
      expect(queuedAdapter.calls).toEqual([]);
      expect(queuedEvents).toEqual([{ type: "queued", position: 1, requestId: "r1" }]);
      await queuedRuntime.abort("r1");

      const streamingAdapter = new ManualAdapter();
      const { runtime: streamingRuntime, events: streamingEvents } = makeRuntime({ adapter: streamingAdapter });
      const run = streamingRuntime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "p" });

      expect(await streamingRuntime.abort("other-request")).toEqual({ kind: "conflict" });
      expect(streamingRuntime.state).toBe("streaming");
      expect(streamingAdapter.calls).toEqual([{ method: "prompt", text: "p" }]);
      expect(streamingEvents).toEqual([]);
      await streamingRuntime.abort("r1");
      streamingAdapter.finishStream();
      await run;
    });

    it("aborting 中不匹配 requestId 不重复调用 adapter.abort 或发射 aborted", async () => {
      const adapter = new AbortPendingAdapter();
      const { runtime, events } = makeRuntime({ adapter });
      const run = runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "p" });

      const firstAbort = runtime.abort("r1");
      expect(adapter.calls).toEqual([
        { method: "prompt", text: "p" },
        { method: "abort" },
      ]);
      expect(await runtime.abort("other-request")).toEqual({ kind: "conflict" });
      expect(adapter.calls).toEqual([
        { method: "prompt", text: "p" },
        { method: "abort" },
      ]);
      expect(events).toEqual([]);

      adapter.finishAbort();
      await firstAbort;
      await flush();
      expect(events).toEqual([{ type: "aborted", requestId: "r1" }]);
      adapter.finishStream();
      await run;
    });

    it("abort streaming：adapter.abort、terminal→release 回 idle、合成 aborted、释放槽位", async () => {
      const adapter = new ManualAdapter();
      const { runtime, events, concurrency } = makeRuntime({ adapter });

      const run = runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      expect(runtime.state).toBe("streaming");

      const d = await runtime.abort();
      expect(d).toEqual({ kind: "ok" });
      expect(adapter.aborted).toBe(true);
      await flush(); // 等待 fire-and-forget settle 完成
      expect(runtime.state).toBe("idle");
      expect(events).toEqual([{ type: "aborted", requestId: "r1" }]);
      expect(concurrency.activeCount()).toBe(0);

      adapter.finishStream();
      await run;
    });

    it("单 turn 工具错误超过预算上限：自动中止并结算为 error（防无限工具循环）", async () => {
      const adapter = new ManualAdapter();
      const { runtime, events, concurrency } = makeRuntime({ adapter });

      const run = runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      expect(runtime.state).toBe("streaming");

      // 手动投递超过上限（9 > 8）的 tool_execution_end isError 事件
      for (let i = 0; i < 9; i++) {
        adapter.emit({
          type: "tool_execution_end",
          toolCallId: `t${i}`,
          toolName: "bash",
          result: "Tool bash not found",
          isError: true,
        });
      }

      await flush(); // 等待预算触发 abort + settle 完成
      expect(adapter.aborted).toBe(true);
      expect(runtime.state).toBe("idle");
      expect(events).toContainEqual({ type: "error", message: "连续工具调用失败次数超限", requestId: "r1" });
      expect(events).not.toContainEqual({ type: "aborted" });
      expect(concurrency.activeCount()).toBe(0);

      adapter.finishStream();
      await run;
    });

    it("abort 抛错 → poisoned：后续提交返回 conflict(poisoned) 且槽位释放", async () => {
      const adapter = new AbortThrowingAdapter();
      const { runtime, concurrency } = makeRuntime({ adapter });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      const d = await runtime.abort();
      expect(d).toEqual({ kind: "ok" });
      await flush();

      const next = await runtime.submitMessage({ requestId: "r2", userId: "user-1", prompt: "再来" });
      expect(next).toEqual({ kind: "conflict", reason: "poisoned" });
      expect(concurrency.activeCount()).toBe(0);

      adapter.finishStream(); // 清理挂起的 prompt
      await flush();
    });
  });

  describe("完成与排队任务接续执行", () => {
    it("complete 后回 idle 并释放槽位，排队任务出队接续执行", async () => {
      const concurrency = new ConcurrencyController({
        ...baseConfig,
        globalLimit: 1,
        perUserLimit: 1,
      });
      const adapterA = new ManualAdapter();
      const adapterB = new MockAgentAdapter([
        { type: "agent_start" },
        { type: "agent_end", messages: [], willRetry: false },
      ]);
      const eventsA: SseEvent[] = [];
      const eventsB: SseEvent[] = [];
      const rtA = new SessionRuntime({
        sessionId: "session-A",
        ownerKey: "owner-1",
        concurrency,
        adapter: adapterA,
        now: () => 0,
        onEvent: (e) => eventsA.push(e),
      });
      const rtB = new SessionRuntime({
        sessionId: "session-B",
        ownerKey: "owner-1",
        concurrency,
        adapter: adapterB,
        now: () => 0,
        onEvent: (e) => eventsB.push(e),
      });

      // A 流式运行中（占用全局唯一槽位）
      const runA = rtA.submitMessage({ requestId: "a1", userId: "user-1", prompt: "A的问题" });
      expect(rtA.state).toBe("streaming");

      // B 因并发超限排队
      const dB = await rtB.submitMessage({
        requestId: "b1",
        userId: "user-1",
        prompt: "B的问题",
      });
      expect(dB).toEqual({ kind: "queued", position: 1 });
      expect(rtB.state).toBe("queued");
      expect(eventsB).toEqual([{ type: "queued", position: 1, requestId: "b1" }]);
      expect(adapterB.calls).toEqual([]);

      // A 流式结束 → 释放槽位 → B 出队接续执行
      adapterA.finishStream();
      await runA;
      await flush();
      expect(rtA.state).toBe("idle");
      expect(eventsA).toEqual([{ type: "completed", requestId: "a1" }]);

      expect(adapterB.calls).toEqual([{ method: "prompt", text: "B的问题" }]);
      expect(rtB.state).toBe("idle");
      expect(eventsB).toEqual([
        { type: "queued", position: 1, requestId: "b1" },
        { type: "status", phase: "agent_start", requestId: "b1" },
        { type: "completed", requestId: "b1" },
      ]);
      expect(concurrency.activeCount()).toBe(0); // 槽位已全部释放
      expect(concurrency.queuedCount()).toBe(0);
    });
  });

  describe("失败路径", () => {
    it("adapter.prompt 抛错：合成 error 事件、状态回 idle、释放槽位", async () => {
      const adapter = new ThrowingAdapter();
      const { runtime, events, concurrency, adapter: used } = makeRuntime({ adapter });

      const d = await runtime.submitMessage({
        requestId: "r1",
        userId: "user-1",
        prompt: "q",
      });
      await flush();

      expect(d).toEqual({ kind: "run" });
      expect(events).toEqual([{ type: "error", message: "模型挂了", requestId: "r1" }]);
      expect(runtime.state).toBe("idle");
      expect(concurrency.activeCount()).toBe(0);
      expect(used.calls).toEqual([{ method: "prompt", text: "q" }]);
    });

    it("agent_end 终态 stopReason=error：prompt resolve 后合成 error（非 completed）", async () => {
      // 真实 SDK 失败不会 reject prompt，而是把失败编入 agent_end 的 stopReason
      const adapter = new MockAgentAdapter([
        {
          type: "agent_end",
          messages: [{ role: "assistant", stopReason: "error", errorMessage: "API 错误" }],
          willRetry: false,
        },
      ]);
      const { runtime, events, concurrency } = makeRuntime({ adapter });

      const d = await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      await flush();

      expect(d).toEqual({ kind: "run" });
      expect(events).toEqual([{ type: "error", message: "API 错误", requestId: "r1" }]);
      expect(runtime.state).toBe("idle");
      expect(concurrency.activeCount()).toBe(0);
    });

    it("agent_end 终态 stopReason=aborted：prompt resolve 后合成 aborted", async () => {
      const adapter = new MockAgentAdapter([
        {
          type: "agent_end",
          messages: [{ role: "assistant", stopReason: "aborted" }],
          willRetry: false,
        },
      ]);
      const { runtime, events } = makeRuntime({ adapter });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      await flush();

      expect(events).toEqual([{ type: "aborted", requestId: "r1" }]);
      expect(runtime.state).toBe("idle");
    });

    it("agent_end 终态 stopReason=stop：prompt resolve 后合成 completed", async () => {
      const adapter = new MockAgentAdapter([
        {
          type: "agent_end",
          messages: [{ role: "assistant", stopReason: "stop" }],
          willRetry: false,
        },
      ]);
      const { runtime, events } = makeRuntime({ adapter });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      await flush();

      expect(events).toEqual([{ type: "completed", requestId: "r1" }]);
      expect(runtime.state).toBe("idle");
    });

    it("agent_end 终态 stopReason=length：maxTokens 截断合成 error（非 completed）", async () => {
      const adapter = new MockAgentAdapter([
        {
          type: "agent_end",
          messages: [{ role: "assistant", stopReason: "length" }],
          willRetry: false,
        },
      ]);
      const { runtime, events } = makeRuntime({ adapter });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      await flush();

      expect(events).toEqual([{ type: "error", message: "回答被 token 上限截断", requestId: "r1" }]);
      expect(runtime.state).toBe("idle");
    });

    it("连续任务：首任务 error 的终态不污染次任务（次任务无 agent_end 仍 completed）", async () => {
      const adapter = new MockAgentAdapter();
      const { runtime, events } = makeRuntime({ adapter });

      // 首任务：error 终态
      adapter.enqueue({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "首任务失败" }],
        willRetry: false,
      });
      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q1" });
      await flush();
      expect(events).toEqual([{ type: "error", message: "首任务失败", requestId: "r1" }]);

      // 次任务（同一 runtime）：无 agent_end，终态应已清空 → completed，而非沿用 error
      await runtime.submitMessage({ requestId: "r2", userId: "user-1", prompt: "q2" });
      await flush();
      expect(events).toEqual([
        { type: "error", message: "首任务失败", requestId: "r1" },
        { type: "completed", requestId: "r2" },
      ]);
      expect(runtime.state).toBe("idle");
    });
  });

  describe("submitMessage 图片输入透传", () => {
    it("提交 images 时 adapter.prompt 收到 images", async () => {
      const adapter = new MockAgentAdapter();
      const { runtime } = makeRuntime({ adapter });
      const images = [
        { mediaType: "image/png", base64: PNG_2X2_BASE64 },
        { mediaType: "image/jpeg", base64: JPEG_2X2_BASE64 },
      ];

      const d = await runtime.submitMessage({
        requestId: "r1",
        userId: "user-1",
        prompt: "看图",
        images,
      });
      await flush();

      expect(d).toEqual({ kind: "run" });
      expect(adapter.calls).toEqual([{ method: "prompt", text: "看图", images }]);
    });

    it("不带 images 时 adapter.prompt 记录不含 images 字段", async () => {
      const adapter = new MockAgentAdapter();
      const { runtime } = makeRuntime({ adapter });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "文字" });
      await flush();

      expect(adapter.calls).toEqual([{ method: "prompt", text: "文字" }]);
    });

    it("排队出队后 images 一并透传到 adapter.prompt", async () => {
      const concurrency = new ConcurrencyController({
        ...baseConfig,
        globalLimit: 1,
        perUserLimit: 1,
      });
      const adapterA = new ManualAdapter();
      const adapterB = new MockAgentAdapter();
      const eventsB: SseEvent[] = [];
      const rtA = new SessionRuntime({
        sessionId: "session-A",
        ownerKey: "owner-1",
        concurrency,
        adapter: adapterA,
        now: () => 0,
        onEvent: () => {},
      });
      const rtB = new SessionRuntime({
        sessionId: "session-B",
        ownerKey: "owner-1",
        concurrency,
        adapter: adapterB,
        now: () => 0,
        onEvent: (e) => eventsB.push(e),
      });

      const runA = rtA.submitMessage({ requestId: "a1", userId: "user-1", prompt: "A的问题" });
      expect(rtA.state).toBe("streaming");

      const images = [{ mediaType: "image/png", base64: PNG_2X2_BASE64 }];
      const dB = await rtB.submitMessage({
        requestId: "b1",
        userId: "user-1",
        prompt: "B看图",
        images,
      });
      expect(dB).toEqual({ kind: "queued", position: 1 });
      expect(adapterB.calls).toEqual([]);

      adapterA.finishStream();
      await runA;
      await flush();

      expect(adapterB.calls).toEqual([{ method: "prompt", text: "B看图", images }]);
      expect(rtB.state).toBe("idle");
    });
  });

  describe("runTurn：requestId 专属结果与 per-turn 取消", () => {
    it("只返回本 requestId 的助手文本，不依赖 session 级事件流", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });

      const pending = runtime.runTurn({ requestId: "r1", prompt: "生成" });
      await flush();
      adapter.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" },
      });
      adapter.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
      adapter.finishStream();

      await expect(pending).resolves.toEqual({ status: "completed", text: "你好" });
      expect(runtime.state).toBe("idle");
    });

    it("session 正忙时返回 busy，且不启动新任务", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });

      const first = runtime.runTurn({ requestId: "r1", prompt: "第一次" });
      await flush();
      await expect(runtime.runTurn({ requestId: "r2", prompt: "第二次" })).resolves.toEqual({
        status: "busy",
      });
      // 第一个任务仍在 streaming，绝不被误杀、也未被第二次覆盖。
      expect(runtime.state).toBe("streaming");
      expect(adapter.calls.filter((call) => call.method === "prompt")).toEqual([
        { method: "prompt", text: "第一次" },
      ]);
      expect(adapter.aborted).toBe(false);

      adapter.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
      adapter.finishStream();
      await expect(first).resolves.toEqual({ status: "completed", text: "" });
    });

    it("signal abort 只终止本 requestId 的 task", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });
      const controller = new AbortController();

      const pending = runtime.runTurn({ requestId: "r1", prompt: "本轮", signal: controller.signal });
      await flush();
      expect(runtime.state).toBe("streaming");
      controller.abort();

      await expect(pending).resolves.toEqual({ status: "aborted" });
      expect(adapter.aborted).toBe(true);
      expect(runtime.state).toBe("idle");
    });

    it("其他 requestId 的 signal abort 不误杀当前 streaming 任务", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });

      const holder = runtime.runTurn({ requestId: "holder", prompt: "占用" });
      await flush();
      const controller = new AbortController();
      // 第二次 runTurn 因 session 正忙返回 busy，其 signal 与本 session 的当前 task 无关。
      await expect(
        runtime.runTurn({ requestId: "other", prompt: "其他", signal: controller.signal }),
      ).resolves.toEqual({ status: "busy" });
      controller.abort();
      await flush();

      expect(runtime.state).toBe("streaming");
      expect(adapter.aborted).toBe(false);

      adapter.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
      adapter.finishStream();
      await expect(holder).resolves.toEqual({ status: "completed", text: "" });
    });

    it("进入时 signal 已 aborted：不提交、不触发模型", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });
      const controller = new AbortController();
      controller.abort();

      await expect(
        runtime.runTurn({ requestId: "r1", prompt: "不应执行", signal: controller.signal }),
      ).resolves.toEqual({ status: "aborted" });
      expect(adapter.calls.filter((call) => call.method === "prompt")).toHaveLength(0);
    });

    it("超过 maxAssistantTextLength 时中止本轮并返回 error", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });

      const pending = runtime.runTurn({ requestId: "r1", prompt: "p", maxAssistantTextLength: 5 });
      await flush();
      adapter.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "123456" },
      });

      await expect(pending).resolves.toEqual({
        status: "error",
        message: "助手输出超过宿主上限",
        code: TURN_ERROR_CODES.assistantTextBudget,
      });
      expect(adapter.aborted).toBe(true);

      // 缺陷回归：同一 requestId 重放必须还原**首次返回**的 error+code。
      // 助手文本 overflow 走的是 aborted outcome，若幂等记录按 outcome 分支写，
      // 会把 error+code 错记为 { status: "aborted" }，导致重放结果与首次不一致。
      await expect(runtime.runTurn({ requestId: "r1", prompt: "p", maxAssistantTextLength: 5 })).resolves.toEqual({
        status: "error",
        message: "助手输出超过宿主上限",
        code: TURN_ERROR_CODES.assistantTextBudget,
      });
    });

    it("工具次数与墙钟预算的 error 都能被同一 requestId 重放原样还原", async () => {
      // 工具次数预算：先验证一类，再单独验证墙钟（两者走不同的 code 分支）。
      const toolAdapter = new ManualAdapter();
      const { runtime: toolRuntime } = makeRuntime({ adapter: toolAdapter });

      const pending = toolRuntime.runTurn({ requestId: "r-tools", prompt: "p", maxToolCallsPerTurn: 1 });
      await flush();
      for (let i = 0; i < 2; i++) {
        toolAdapter.emit({
          type: "tool_execution_end",
          toolCallId: `c${i}`,
          toolName: "read",
          result: {},
          isError: false,
        });
      }
      const first = await pending;
      expect(first).toEqual({
        status: "error",
        message: "本轮工具调用次数超过上限",
        code: TURN_ERROR_CODES.toolBudget,
      });
      // 重放：终态与首次逐字段一致。
      await expect(toolRuntime.runTurn({ requestId: "r-tools", prompt: "p", maxToolCallsPerTurn: 1 })).resolves.toEqual(first);

      // 墙钟预算：必须同样能被重放还原（否则「只测了工具预算」会漏掉 duration 分支）。
      const timeAdapter = new ManualAdapter();
      const { runtime: timeRuntime } = makeRuntime({ adapter: timeAdapter });
      const timePending = timeRuntime.runTurn({ requestId: "r-time", prompt: "p", maxTurnDurationMs: 10 });
      await flush();
      const timeFirst = await timePending;
      expect(timeFirst).toEqual({
        status: "error",
        message: "本轮耗时超过上限",
        code: TURN_ERROR_CODES.durationBudget,
      });
      await expect(timeRuntime.runTurn({ requestId: "r-time", prompt: "p", maxTurnDurationMs: 10 })).resolves.toEqual(timeFirst);
    });

    it("工具调用次数达到 maxToolCallsPerTurn 即中止，返回带工具预算 code 的 error", async () => {
      const adapter = new ManualAdapter();
      const { runtime, events, concurrency } = makeRuntime({ adapter });

      const pending = runtime.runTurn({ requestId: "r1", prompt: "p", maxToolCallsPerTurn: 2 });
      await flush();
      // 成功与失败都算一次调用：3 次成功调用即超过上限 2。
      for (let i = 0; i < 3; i++) {
        adapter.emit({
          type: "tool_execution_end",
          toolCallId: `t${i}`,
          toolName: "read",
          result: {},
          isError: false,
        });
      }

      await expect(pending).resolves.toEqual({
        status: "error",
        message: "本轮工具调用次数超过上限",
        code: TURN_ERROR_CODES.toolBudget,
      });
      expect(adapter.aborted).toBe(true);
      expect(runtime.state).toBe("idle");
      expect(events).toContainEqual({
        type: "error",
        message: "本轮工具调用次数超过上限",
        requestId: "r1",
      });
      expect(concurrency.activeCount()).toBe(0);
      adapter.finishStream();
    });

    it("工具调用次数未达上限不中止（回归护栏）", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });

      const pending = runtime.runTurn({ requestId: "r1", prompt: "p", maxToolCallsPerTurn: 3 });
      await flush();
      // 恰好 3 次调用 == 上限：不超限，不中止。
      for (let i = 0; i < 3; i++) {
        adapter.emit({
          type: "tool_execution_end",
          toolCallId: `t${i}`,
          toolName: "read",
          result: {},
          isError: false,
        });
      }
      expect(adapter.aborted).toBe(false);
      expect(runtime.state).toBe("streaming");

      adapter.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
      adapter.finishStream();
      await expect(pending).resolves.toEqual({ status: "completed", text: "" });
    });

    it("耗时超过 maxTurnDurationMs 即中止，返回带墙钟预算 code 的 error", async () => {
      const adapter = new ManualAdapter();
      const { runtime, concurrency } = makeRuntime({ adapter });

      // 真实墙钟 timer：模型完全不产生事件（静默挂起）时也能触发，事件驱动退路做不到这一点。
      const pending = runtime.runTurn({ requestId: "r1", prompt: "p", maxTurnDurationMs: 10 });
      await flush();
      expect(runtime.state).toBe("streaming");
      await sleep(60);

      await expect(pending).resolves.toEqual({
        status: "error",
        message: "本轮耗时超过上限",
        code: TURN_ERROR_CODES.durationBudget,
      });
      expect(adapter.aborted).toBe(true);
      expect(runtime.state).toBe("idle");
      expect(concurrency.activeCount()).toBe(0);
      adapter.finishStream();
    });

    it("多个预算在同一事件同时置位：按固定优先级 工具次数 > 工具错误 返回 code", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });

      // 第 9 次 isError 调用同时越两个上限：工具次数（9 > 8）与工具错误（9 > 8）。
      // 两者在同一次 tool_end 里置位，abort 快照按固定优先级取工具次数预算。
      const pending = runtime.runTurn({ requestId: "r1", prompt: "p", maxToolCallsPerTurn: 8 });
      await flush();
      for (let i = 0; i < 9; i++) {
        adapter.emit({
          type: "tool_execution_end",
          toolCallId: `t${i}`,
          toolName: "bash",
          result: "Tool bash not found",
          isError: true,
        });
      }

      await expect(pending).resolves.toEqual({
        status: "error",
        message: "本轮工具调用次数超过上限",
        code: TURN_ERROR_CODES.toolBudget,
      });
      expect(adapter.aborted).toBe(true);
      adapter.finishStream();
    });

    it("abort 等待期间新置位的预算不篡改已快照的墙钟原因（快照语义固定）", async () => {
      // abort 挂起，制造「墙钟预算先触发 abort、工具次数预算在 abort 等待期间又置位」的稳定窗口。
      const adapter = new AbortPendingAdapter();
      const { runtime } = makeRuntime({ adapter });

      const pending = runtime.runTurn({ requestId: "r1", prompt: "p", maxTurnDurationMs: 10, maxToolCallsPerTurn: 2 });
      await flush();
      // 先来 1 次调用（未超上限），再等墙钟超限触发 abort（快照时仅墙钟置位）。
      adapter.emit({ type: "tool_execution_end", toolCallId: "t0", toolName: "read", result: {}, isError: false });
      await sleep(60);
      // abort 等待期间（aborting 窗口）继续投递调用，使工具次数预算也置位。
      for (let i = 1; i < 4; i++) {
        adapter.emit({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "read", result: {}, isError: false });
      }
      adapter.finishAbort();

      // 原因在进入 streaming 分支时已快照：后到的工具次数预算不得把原因改写。
      await expect(pending).resolves.toEqual({
        status: "error",
        message: "本轮耗时超过上限",
        code: TURN_ERROR_CODES.durationBudget,
      });
      adapter.finishStream();
    });

    it("不传新预算参数时行为与改动前一致：无墙钟 timer、无工具次数限制（回归护栏）", async () => {
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });

      // 断言方式：直接统计本轮是否武装了**墙钟 deadline timer** —— 「无 timer」才是契约本身。
      // 早期实现用 sleep(60) 证明，但错误实现武装 300 秒 timer 也会通过，那不是真验证。
      // 不能断言「setTimeout 完全未被调用」：并发控制器等会调度 0ms 微任务定时器；
      // 这里只排除「像预算那样的大延迟」（生产默认 300s，任何现实预算都 ≥ 1 分钟）。
      // 不用假定时器：它会干扰本文件其它依赖真实定时器/微任务的用例。
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const pending = runtime.runTurn({ requestId: "r1", prompt: "p" });
      await flush();
      const deadlineLikeCalls = setTimeoutSpy.mock.calls.filter(([, delay]) =>
        typeof delay === "number" && Number.isFinite(delay) && delay >= 60_000,
      );
      expect(deadlineLikeCalls).toEqual([]);
      expect(adapter.aborted).toBe(false);
      expect(runtime.state).toBe("streaming");

      // 大量工具调用也不得触发次数预算（未传 maxToolCallsPerTurn → 无限制）。
      for (let i = 0; i < 80; i++) {
        adapter.emit({
          type: "tool_execution_end",
          toolCallId: `t${i}`,
          toolName: "read",
          result: {},
          isError: false,
        });
      }
      expect(adapter.aborted).toBe(false);
      expect(runtime.state).toBe("streaming");

      adapter.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
      adapter.finishStream();
      await expect(pending).resolves.toEqual({ status: "completed", text: "" });
      setTimeoutSpy.mockRestore();
    });
  });

  describe("P7b turn 事件 requestId 关联与跨请求隔离", () => {
    it("所有 turn 相关事件（含 usage）都携带当前 requestId", async () => {
      const adapter = new MockAgentAdapter([
        { type: "agent_start" },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "想" },
        },
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "答" },
        },
        {
          type: "tool_execution_start",
          toolCallId: "c1",
          toolName: "read",
          args: {},
        },
        {
          type: "tool_execution_end",
          toolCallId: "c1",
          toolName: "read",
          result: {},
          isError: false,
        },
        { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }], willRetry: false },
      ]);
      adapter.lastUsage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
      const { runtime, events } = makeRuntime({ adapter });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      await flush();

      // 每一个事件都必须带 requestId=r1（正常 turn 断言存在）。
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event, JSON.stringify(event)).toMatchObject({ requestId: "r1" });
      }
      expect(events.map((e) => e.type)).toEqual([
        "status",
        "thinking_delta",
        "text_delta",
        "tool_start",
        "tool_end",
        "usage",
        "completed",
      ]);
    });

    it("abort streaming 的 aborted 终态绑定被中止请求，且不归属后继请求", async () => {
      const adapter = new ManualAdapter();
      const { runtime, events } = makeRuntime({ adapter });

      const run1 = runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q1" });
      expect(runtime.state).toBe("streaming");
      await runtime.abort();
      await flush();
      adapter.finishStream();
      await run1;
      expect(events).toEqual([{ type: "aborted", requestId: "r1" }]);

      // 后继请求：其事件只能带 r2，旧轮 aborted 不会重绑到新请求。
      adapter.enqueue({ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: false });
      const run2 = runtime.submitMessage({ requestId: "r2", userId: "user-1", prompt: "q2" });
      await flush(); // 等 prompt 开始（预设事件已在本轮发射）
      adapter.finishStream();
      await run2;
      await flush();
      expect(events.slice(1)).toEqual([
        { type: "status", phase: "agent_start", requestId: "r2" },
        { type: "completed", requestId: "r2" },
      ]);
      expect(events.filter((e) => e.requestId === "r2")).toHaveLength(2);
    });

    it("排队超时 error 绑定被超时任务自己的 requestId", async () => {
      const concurrency = new ConcurrencyController({
        globalLimit: 1,
        perUserLimit: 1,
        perUserQueueLimit: 2,
        globalQueueLimit: 4,
        queueTimeoutMs: 1000,
      });
      const { runtime, events, sessionId } = makeRuntime({ concurrency });
      concurrency.submit("holder:task", "user-1", 0);
      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "排队" });
      expect(runtime.state).toBe("queued");

      const taskId = `${sessionId}:r1`;
      expect(concurrency.expireQueued(1000)).toContain(taskId);
      getExpireHandler(taskId)?.();

      expect(runtime.state).toBe("idle");
      expect(events).toEqual([
        { type: "queued", position: 1, requestId: "r1" },
        { type: "error", message: "排队超时", requestId: "r1" },
      ]);
    });

    it("settle 后（idle）到达的 stray SDK 事件被忽略，不绑定任何 requestId", async () => {
      const adapter = new MockAgentAdapter([{ type: "agent_end", messages: [], willRetry: false }]);
      const { runtime, events } = makeRuntime({ adapter });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q" });
      await flush();
      expect(runtime.state).toBe("idle");
      const settled = events.length;

      // 旧流迟到事件（idle 期）：不得被处理，也不得归属为任何 request。
      adapter.emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "迟到" },
      });
      expect(events.length).toBe(settled);
      expect(events.some((e) => e.type === "text_delta")).toBe(false);
    });

    it("同一 runtime 连续两轮：每轮事件只带自己的 requestId（无跨 request 串扰）", async () => {
      const adapter = new MockAgentAdapter();
      const { runtime, events } = makeRuntime({ adapter });

      adapter.enqueue(
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "A" },
        },
        { type: "agent_end", messages: [], willRetry: false },
      );
      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "q1" });
      await flush();

      adapter.enqueue(
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "B" },
        },
        { type: "agent_end", messages: [], willRetry: false },
      );
      await runtime.submitMessage({ requestId: "r2", userId: "user-1", prompt: "q2" });
      await flush();

      expect(events).toEqual([
        { type: "text_delta", text: "A", requestId: "r1" },
        { type: "completed", requestId: "r1" },
        { type: "text_delta", text: "B", requestId: "r2" },
        { type: "completed", requestId: "r2" },
      ]);
    });
  });

  describe("runTurn：预算参数的健壮性（契约固定）", () => {
    it("TURN_ERROR_CODES 是运行时冻结对象：插件拿到同一对象也无法改写", () => {
      // 它经 PluginHostContext.turnErrorCodes 直接交给插件；仅靠 `as const` 只提供编译期只读，
      // 插件意外改写会污染宿主单例并影响其他插件。
      expect(Object.isFrozen(TURN_ERROR_CODES)).toBe(true);
      expect(() => {
        // 严格模式下写冻结对象会抛 TypeError；非严格下静默失败。两者都不应改变值。
        (TURN_ERROR_CODES as unknown as Record<string, string>).toolBudget = "mutated";
      }).toThrow();
      expect(TURN_ERROR_CODES.toolBudget).toBe("turn_tool_budget_exceeded");
    });

    it("非法 maxTurnDurationMs（负数/NaN）不得撤销已有的墙钟预算", async () => {
      // 负数不是「更严的上限」：若参与 Math.min 与重武装判断，会先清掉旧 timer
      // 再因非法值提前 return，把额度变成无限制。
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });

      const pending = runtime.runTurn({ requestId: "r1", prompt: "p", maxTurnDurationMs: 20 });
      await flush();
      // 同 requestId 再用负数登记：必须被当作「未提供」，保留原 20ms 预算。
      const replay = runtime.runTurn({ requestId: "r1", prompt: "p", maxTurnDurationMs: -1 });
      await flush();

      await expect(pending).resolves.toMatchObject({
        status: "error",
        code: TURN_ERROR_CODES.durationBudget,
      });
      await expect(replay).resolves.toMatchObject({
        status: "error",
        code: TURN_ERROR_CODES.durationBudget,
      });
      expect(adapter.aborted).toBe(true);
    });

    it("极大 maxTurnDurationMs 不得因 Node 定时器上限而立即超时", async () => {
      // Node 定时器延迟上限是 2^31-1 ms；超过时 Node 会发 TimeoutOverflowWarning 并把延迟
      // 改成 1ms，使「约 24.8 天」的预算变成「约 1ms 后超时」。必须显式收敛。
      // 用 spy（不替换实现）只记录传给 setTimeout 的延迟：若未收敛会出现 2147483648。
      const adapter = new ManualAdapter();
      const { runtime } = makeRuntime({ adapter });
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const pending = runtime.runTurn({ requestId: "r1", prompt: "p", maxTurnDurationMs: 2_147_483_648 });
      await flush();
      const delays = setTimeoutSpy.mock.calls
        .map(([, delay]) => delay)
        .filter((delay): delay is number => typeof delay === "number" && delay > 0);
      setTimeoutSpy.mockRestore();

      expect(delays.length).toBeGreaterThan(0);
      for (const delay of delays) {
        expect(delay).toBeLessThanOrEqual(2_147_483_647);
      }
      // 大额度不应在毫秒级被误判为超时。
      expect(adapter.aborted).toBe(false);
      expect(runtime.state).toBe("streaming");

      adapter.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
      adapter.finishStream();
      await expect(pending).resolves.toEqual({ status: "completed", text: "" });
    });

    it("同一 requestId 收紧 maxTurnDurationMs 时必须按**剩余额度**重武装 timer", async () => {
      // 契约：重复登记取更严上限。对墙钟而言，若只更新 maxDurationMs 而不重武装 timer，
      // 已武装的 timer 仍按旧（更宽松）额度计时，「更严上限」对墙钟不生效。
      // 关键在于不能重新计时（那会变相放宽），而要用 maxDurationMs - 已消耗时间。
      const adapter = new ManualAdapter();
      let clock = 1_000_000;
      const { runtime } = makeRuntime({ adapter, now: () => clock });

      // 首次登记 10_000ms，此时武装 10_000ms 的 timer。
      const pending = runtime.runTurn({ requestId: "r1", prompt: "p", maxTurnDurationMs: 10_000 });
      await flush();

      // 时间前进 4_000ms，再以同一 requestId 收紧到 6_000ms。
      // 已消耗 4_000ms，因此剩余额度应为 6_000 - 4_000 = 2_000ms。
      clock += 4_000;
      const replay = runtime.runTurn({ requestId: "r1", prompt: "p", maxTurnDurationMs: 6_000 });
      await flush();
      // 若实现错误地「按新上限重新计时」，还需 6_000ms 才会超时；这里推进 2_000ms 就应已超时。
      await sleep(2_200);
      await flush();

      await expect(pending).resolves.toMatchObject({
        status: "error",
        code: TURN_ERROR_CODES.durationBudget,
      });
      await expect(replay).resolves.toMatchObject({
        status: "error",
        code: TURN_ERROR_CODES.durationBudget,
      });
      expect(adapter.aborted).toBe(true);
    });

    it("收紧后的上限已被消耗完时立即超时，不再等待", async () => {
      const adapter = new ManualAdapter();
      let clock = 1_000_000;
      const { runtime } = makeRuntime({ adapter, now: () => clock });

      const pending = runtime.runTurn({ requestId: "r1", prompt: "p", maxTurnDurationMs: 10_000 });
      await flush();
      // 已消耗 8_000ms，再收紧到 5_000ms（remainingMs <= 0）：必须立即按超时处理。
      clock += 8_000;
      const replay = runtime.runTurn({ requestId: "r1", prompt: "p", maxTurnDurationMs: 5_000 });
      await flush();

      await expect(pending).resolves.toMatchObject({
        status: "error",
        code: TURN_ERROR_CODES.durationBudget,
      });
      await expect(replay).resolves.toMatchObject({
        status: "error",
        code: TURN_ERROR_CODES.durationBudget,
      });
    });
  });

  describe("观测订阅口", () => {
    it("正常完成时推送 turn(completed) 与 usage 观测事件", async () => {
      const adapter = new MockAgentAdapter([{ type: "agent_end", messages: [], willRetry: false }]);
      adapter.lastUsage = { promptTokens: 10, completionTokens: 3, totalTokens: 13 };
      const observability = new CollectingObservability();
      const { runtime } = makeRuntime({ adapter, observability });

      await runtime.submitMessage({ requestId: "r1", userId: "user-1", prompt: "hi" });
      await flush();

      expect(observability.events).toEqual([
        { type: "turn", sessionId: "session-1", requestId: "r1", outcome: "completed", durationMs: 0, ttftMs: 0 },
        { type: "usage", sessionId: "session-1", requestId: "r1", promptTokens: 10, completionTokens: 3, totalTokens: 13 },
      ]);
    });

    it("失败时推送 turn(error) 与脱敏 error 观测事件", async () => {
      const observability = new CollectingObservability();
      const { runtime } = makeRuntime({ adapter: new ThrowingAdapter(), observability });

      await runtime.submitMessage({ requestId: "r2", userId: "user-1", prompt: "hi" });
      await flush();

      const turn = observability.events.find((e) => e.type === "turn");
      expect(turn).toMatchObject({ sessionId: "session-1", requestId: "r2", outcome: "error" });
      expect(observability.events).toContainEqual({
        type: "error", sessionId: "session-1", requestId: "r2", message: "模型挂了",
      });
    });
  });
});