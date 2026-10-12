import type { ControlQueueItem, ControlIdentity } from "../shared/control-queue.js";

/** Only public core APIs. Session.clearQueue loses images/custom messages and is not suitable here. */
export type ResidentQueueAgent = {
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  steer(message: any): void;
  followUp(message: any): void;
  peekQueuedMessages(): object[];
  clearSteeringQueue(): void;
  clearFollowUpQueue(): void;
};
type Queues = { steer: object[]; followUp: object[] };
export class ResidentControlQueue {
  private readonly tracked = new Map<object, ControlIdentity>();
  constructor(private readonly agent: ResidentQueueAgent,
    private readonly enqueueSteer: (message: object) => void,
    private readonly enqueueFollowUp: (message: object) => void,
    private readonly onUnrecoverable: (error: Error) => void) {}
  track(message: object, identity: ControlIdentity): void { this.tracked.set(message, identity); }

  /**
   * Supported core contract: synchronous, non-reentrant methods; peek is non-destructive,
   * all-mode returns steering if nonempty, otherwise follow-up; enqueue preserves references.
   * Recovery supports transient throws BEFORE side effects (one retry). Arbitrary throws
   * after unknown side effects cannot be made atomic through these public APIs. Recovery
   * failures are surfaced, never suppressed; onUnrecoverable must stop/poison the run.
   * If marker inspection is impossible we clear
   * steering fail-closed rather than let the synthetic marker execute (objects may be lost).
   */
  private access<T>(action: (queues: Queues) => T): T {
    const a = this.agent, sm = a.steeringMode, fm = a.followUpMode;
    const marker = { role: "user", content: "", timestamp: 0 };
    const errors: unknown[] = [];
    let steer: object[] | undefined, followUp: object[] | undefined;
    let steeringCleared = false, followUpCleared = false, markerAttempted = false;
    let result!: T, restored = false, unrecoverable = false;
    const recover = (operation: () => void): void => {
      try { operation(); } catch (error) {
        errors.push(error);
        try { operation(); } catch (retryError) { errors.push(retryError); unrecoverable = true; }
      }
    };
    try {
      a.steeringMode = "all"; a.followUpMode = "all";
      markerAttempted = true;
      this.enqueueSteer(marker);
      const marked = a.peekQueuedMessages();
      // Save originals BEFORE validation or clearing, including unsupported marker position.
      if (marked.includes(marker)) steer = marked.filter(message => message !== marker);
      if (marked.at(-1) !== marker) throw new Error("Unsupported resident queue semantics");
      steeringCleared = true; a.clearSteeringQueue();
      followUp = a.peekQueuedMessages();
      followUpCleared = true; a.clearFollowUpQueue();
      const queues = { steer: [...steer!], followUp: [...followUp] };
      result = action(queues);
      // Restore the edited queues. If restoration fails, roll back to originals below.
      for (const message of queues.followUp) this.enqueueFollowUp(message);
      for (const message of queues.steer) this.enqueueSteer(message);
      markerAttempted = false;
      restored = true;
    } catch (error) {
      errors.push(error);
      if (markerAttempted && !steeringCleared) {
        if (!steer) recover(() => {
          const marked = a.peekQueuedMessages();
          if (!marked.includes(marker)) {
            markerAttempted = false; // supported peek proves enqueue had no effect
            return;
          }
          steer = marked.filter(message => message !== marker);
        });
        if (markerAttempted) steeringCleared = true;
      }
      if (followUpCleared) recover(() => a.clearFollowUpQueue());
      if (steeringCleared) recover(() => a.clearSteeringQueue());
      // Independent recovery: one broken queue must not skip the other or mode restoration.
      if (followUpCleared && followUp) for (const message of followUp) recover(() => this.enqueueFollowUp(message));
      if (steeringCleared && steer) for (const message of steer) recover(() => this.enqueueSteer(message));
    } finally {
      recover(() => { a.steeringMode = sm; });
      recover(() => { a.followUpMode = fm; });
    }
    // Even a recovered mode-setter error must not report a failed mutation that actually
    // committed. Originals remain available until every stage, including mode restore, ends.
    if (errors.length && restored) {
      recover(() => a.clearSteeringQueue());
      recover(() => a.clearFollowUpQueue());
      for (const message of followUp!) recover(() => this.enqueueFollowUp(message));
      for (const message of steer!) recover(() => this.enqueueSteer(message));
    }
    if (unrecoverable) {
      const failure = new AggregateError(errors, "Resident queue recovery unavailable; current run must be stopped");
      try { this.onUnrecoverable(failure); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Resident queue access/recovery failed");
    return result;
  }
  /** All resident objects, including untracked extension/custom messages. */
  pendingMessages(): Queues { return this.access(queues => ({ steer: [...queues.steer], followUp: [...queues.followUp] })); }
  snapshot(): ControlQueueItem[] {
    return this.access(queues => {
      const resident = new Set([...queues.steer, ...queues.followUp]);
      for (const message of this.tracked.keys()) if (!resident.has(message)) this.tracked.delete(message);
      return (["steer", "followUp"] as const).flatMap(kind => queues[kind].flatMap(message => {
        const identity = this.tracked.get(message);
        if (!identity) return [];
        const content = (message as { content?: unknown }).content;
        const blocks = Array.isArray(content) ? content : [];
        return [{ id: identity.controlId, acknowledgementId: identity.acknowledgementId, kind,
          text: typeof content === "string" ? content : blocks.filter(b => b.type === "text").map(b => b.text).join(""),
          hasImages: blocks.some(b => b.type === "image"), status: "queued" as const }];
      }));
    });
  }
  mutate(identity: ControlIdentity, operation: "delete" | "promote"): boolean {
    let deleted: object | undefined;
    const changed = this.access(queues => {
      for (const kind of ["steer", "followUp"] as const) {
        const index = queues[kind].findIndex(message => {
          const tracked = this.tracked.get(message);
          return tracked?.controlId === identity.controlId && tracked.requestId === identity.requestId &&
            tracked.acknowledgementId === identity.acknowledgementId;
        });
        if (index < 0) continue;
        if (operation === "promote" && kind !== "followUp") return false;
        const [message] = queues[kind].splice(index, 1);
        if (operation === "promote") queues.steer.push(message!);
        else deleted = message;
        return true;
      }
      return false;
    });
    if (deleted) this.tracked.delete(deleted);
    return changed;
  }
}
