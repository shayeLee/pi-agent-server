import type { AgentSdkEvent } from "./events.js";

import type { ModelOutputProgress } from "../shared/events.js";
export type { ModelOutputProgress } from "../shared/events.js";

/** Per adapter, at most one dirty trailing timer. 250ms publications plus boundaries/flush. */
export class ModelOutputSampler {
  private ordinal = 0;
  private active = false;
  private first: number | null = null;
  private lastEmission: number | null = null;
  private characters = 0;
  private thinking = false;
  private lastDelta: number | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly now: () => number, private readonly publish?: (progress: ModelOutputProgress) => void) {}
  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private flush(): ModelOutputProgress | null {
    this.cancelTimer();
    if (!this.dirty || this.lastDelta === null || this.first === null) return null;
    this.dirty = false;
    this.lastEmission = this.now();
    const duration = this.lastDelta - this.first;
    const speed = duration >= 10 ? this.characters / 4 / duration * 1000 : null;
    return { ...this.progress("delta", speed !== null && Number.isFinite(speed) && speed > 0 ? speed : null),
      activityAgeMs: Math.max(0, this.lastEmission - this.lastDelta) };
  }
  reset(): void {
    this.cancelTimer(); this.dirty = false; this.lastDelta = null;
    this.ordinal = 0; this.active = false; this.first = null;
    this.lastEmission = null; this.characters = 0; this.thinking = false;
  }
  sample(event: AgentSdkEvent): ModelOutputProgress | null {
    if (!("message" in event) || (event.message as { role?: string } | undefined)?.role !== "assistant") return null;
    if (event.type === "message_start") {
      this.cancelTimer(); this.dirty = false; this.lastDelta = null;
      this.ordinal++; this.active = true; this.first = null; this.lastEmission = null;
      this.characters = 0; this.thinking = false;
      return this.progress("start", null);
    }
    if (event.type === "message_end" && this.active) {
      const trailing = this.flush();
      if (trailing) this.publish?.(trailing);
      this.active = false;
      return this.progress("end", null);
    }
    if (event.type !== "message_update" || !this.active) return null;
    const delta = event.assistantMessageEvent;
    if (!(delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") || !delta.delta.length) return null;
    const now = this.now();
    // JS UTF-16 characters / 4 matches the reference heuristic, including batch/Unicode deltas.
    this.characters += delta.delta.length;
    this.thinking ||= delta.type === "thinking_delta";
    this.first ??= now;
    this.lastDelta = now; this.dirty = true;
    if (this.lastEmission !== null && now - this.lastEmission < 250) {
      if (this.publish && this.timer === undefined) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          const progress = this.flush();
          if (progress && this.active) this.publish?.(progress);
        }, Math.max(0, 250 - (now - this.lastEmission)));
        this.timer.unref?.();
      }
      return null;
    }
    return this.flush();
  }
  private progress(phase: ModelOutputProgress["phase"], speed: number | null): ModelOutputProgress {
    return { ordinal: this.ordinal, phase, tokensPerSecondEstimate: speed, includesThinking: this.thinking };
  }
}
