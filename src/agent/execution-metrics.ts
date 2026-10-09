import { randomUUID } from "node:crypto";
import type { ExecutionSnapshot } from "../core/usage-snapshot.js";

export const EXECUTION_METRICS_TYPE = "pi-agent-server:execution-metrics:v1";
type RecordData = { version: 1; kind: "baseline"; complete: boolean } |
  { version: 1; kind: "loop"; loopId: string } |
  { version: 1; kind: "turn"; loopId: string; turnId: string; ordinal: number };
type Entry = { type?: string; customType?: string; data?: unknown; message?: { role?: string } };
export type MetricsManager = {
  getEntries(): unknown[];
  appendCustomEntry(customType: string, data: unknown): string;
};

/** Session-wide accounting, not active-branch context. Scan once on open, O(1) thereafter. */
export class ExecutionMetrics {
  private readonly loops = new Set<string>();
  private readonly turns = new Set<string>();
  private complete = false;
  private baseline = false;
  private historical = false;
  private failed = false;
  private loopId: string | null = null;
  private ordinal = 0;
  private readonly observed = new WeakSet<object>();
  constructor(private readonly manager?: MetricsManager, entries = manager?.getEntries() ?? []) {
    for (const entry of entries) this.restore(entry);
  }
  private restore(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const entry = raw as Entry;
    if (entry.type === "message" && entry.message?.role !== "system" ||
        entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary") this.historical = true;
    if (entry.type !== "custom" || entry.customType !== EXECUTION_METRICS_TYPE) return;
    const d = entry.data as Partial<RecordData> | null;
    if (!d || d.version !== 1) { this.failed = true; return; }
    if (d.kind === "baseline") {
      if (!this.baseline) this.complete = d.complete === true;
      this.baseline = true;
    } else if (d.kind === "loop" && typeof d.loopId === "string") this.loops.add(d.loopId);
    else if (d.kind === "turn" && typeof d.loopId === "string" && typeof d.turnId === "string" && Number.isSafeInteger(d.ordinal) && d.ordinal! > 0) {
      this.loops.add(d.loopId); this.turns.add(d.turnId);
    } else this.failed = true;
  }
  /** A host invocation is only a candidate until the SDK actually starts. */
  begin(): void { this.loopId = null; this.ordinal = 0; }
  end(): void { this.loopId = null; }
  observe(event: { type: string }): void {
    if (event.type !== "agent_start" && event.type !== "turn_start") return;
    if (this.observed.has(event)) return;
    this.observed.add(event);
    if (!this.manager || this.failed) return;
    if (!this.baseline) {
      this.append({ version: 1, kind: "baseline", complete: !this.historical });
      this.baseline = true; this.complete = !this.historical;
    }
    if (!this.loopId) {
      this.loopId = randomUUID();
      this.append({ version: 1, kind: "loop", loopId: this.loopId });
      this.loops.add(this.loopId);
    }
    if (event.type === "turn_start") {
      const turnId = randomUUID();
      this.append({ version: 1, kind: "turn", loopId: this.loopId, turnId, ordinal: ++this.ordinal });
      this.turns.add(turnId);
    }
  }
  private append(data: RecordData): void {
    try { this.manager!.appendCustomEntry(EXECUTION_METRICS_TYPE, data); }
    catch { this.failed = true; }
  }
  snapshot(): ExecutionSnapshot {
    const known = !this.failed && (this.baseline || !!this.manager && !this.historical);
    const complete = known && (this.complete || !this.baseline && !this.historical);
    return { scope: "allEntries", coverage: complete ? "complete" : known ? "recorded" : "unknown",
      totalLoops: complete ? this.loops.size : null, totalTurns: complete ? this.turns.size : null,
      recordedLoops: known ? this.loops.size : null, recordedTurns: known ? this.turns.size : null };
  }
}

export function projectExecutionSnapshot(entries: unknown[]): ExecutionSnapshot {
  // Read-only exports know whether the file is genuinely empty, without appending a baseline.
  const manager: MetricsManager = { getEntries: () => entries, appendCustomEntry: () => { throw new Error("read only"); } };
  return new ExecutionMetrics(manager).snapshot();
}
