// MockAgentAdapter：AgentAdapter 的可控 mock 实现（docs/architecture.md §2）。
// - 按预设顺序发射 SDK 事件：构造或 enqueue 预设事件，prompt/steer/followUp 触发时按序投递给订阅者；
// - 记录调用：calls 按序记录 prompt/steer/followUp/abort 及参数；
// - 支持 abort：abort() 置 aborted 标记、清空未发射的预设事件（模拟 SDK 中止后不再出流）。

import type { AgentAdapter, ImageInput } from "./agent-adapter.js";
import type { AgentSdkEvent } from "./events.js";

export type AdapterCall =
  | { method: "prompt"; text: string; images?: ImageInput[] }
  | { method: "steer"; text: string }
  | { method: "followUp"; text: string }
  | { method: "abort" }
  | { method: "navigateTree"; targetId: string }
  | { method: "dispose" };

export class MockAgentAdapter implements AgentAdapter {
  private listeners = new Set<(event: AgentSdkEvent) => void>();
  private pending: AgentSdkEvent[] = [];
  private emittedEvents: AgentSdkEvent[] = [];
  private abortedFlag = false;
  /** abort 后置真：丢弃残余事件（手动 emit 的迟到事件），模拟真实 SDK 的中止后事件丢弃；prompt 开始恢复。 */
  private discard = false;

  /** 调用记录（按调用顺序）。 */
  readonly calls: AdapterCall[] = [];

  /** exportSession 返回的可配置导出数据（默认空消息列表）。 */
  exportData: unknown = [];

  constructor(presetEvents: readonly AgentSdkEvent[] = [], exportData?: unknown) {
    this.pending = [...presetEvents];
    if (exportData !== undefined) this.exportData = exportData;
  }

  /** 追加预设事件，下次 prompt/steer/followUp 时按序发射。 */
  enqueue(...events: AgentSdkEvent[]): this {
    this.pending.push(...events);
    return this;
  }

  async prompt(text: string, options?: { images?: ImageInput[] }): Promise<void> {
    this.discard = false; // 新 run 开始：恢复事件传递
    this.calls.push(
      options?.images === undefined
        ? { method: "prompt", text }
        : { method: "prompt", text, images: options.images },
    );
    this.flush();
  }

  async steer(text: string): Promise<void> {
    this.calls.push({ method: "steer", text });
    this.flush();
  }

  async followUp(text: string): Promise<void> {
    this.calls.push({ method: "followUp", text });
    this.flush();
  }

  async abort(): Promise<void> {
    this.calls.push({ method: "abort" });
    this.abortedFlag = true;
    // 中止后不再发射剩余预设事件（aborted SSE 事件由服务层合成）。
    this.pending = [];
    this.discard = true;
  }

  async navigateTree(targetId: string): Promise<void> {
    this.calls.push({ method: "navigateTree", targetId });
  }

  /** 释放资源：清空监听器与待发射事件（dispose 后不再向外投递）。 */
  dispose(): void {
    this.calls.push({ method: "dispose" });
    this.listeners.clear();
    this.pending = [];
  }

  /** 手动投递单个事件给所有订阅者。 */
  emit(event: AgentSdkEvent): void {
    this.deliver(event);
  }

  subscribe(listener: (event: AgentSdkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 已发射的事件（按发射顺序）。 */
  get emitted(): readonly AgentSdkEvent[] {
    return this.emittedEvents;
  }

  get aborted(): boolean {
    return this.abortedFlag;
  }

  /** 导出会话数据：返回可配置的 exportData（默认空消息列表）。 */
  async exportSession(): Promise<unknown> {
    return this.exportData;
  }

  private flush(): void {
    while (this.pending.length > 0) {
      const event = this.pending.shift()!;
      this.deliver(event);
    }
  }

  private deliver(event: AgentSdkEvent): void {
    if (this.discard) return; // 丢弃 abort 后的残余事件
    this.emittedEvents.push(event);
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}
