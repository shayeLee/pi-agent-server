// What one caller sees of the run activity (docs/companion-butler.md §4.2): the hub's raw changes,
// kept only for sessions this caller can read, with each session's project and title. Access is
// checked on every read, so a session that was deleted or stopped being shared drops out.

import type { RawActivity, RunActivityHub } from "./run-activity-hub.js";
import type { ActivityEvent, ActivityResult, ActivityRun, ActivitySnapshot } from "../shared/activity.js";

type Subject = { projectId: string; title: string };
export type ActivitySubjectLookup = (ownerKey: string, sessionId: string) => Promise<Subject | null>;

/** At most this many recent results per reply. */
export const ACTIVITY_RECENT_LIMIT = 200;

export class ActivityService {
  constructor(private readonly hub: RunActivityHub, private readonly subject: ActivitySubjectLookup) {}

  /** The caller's running sessions and recent results; `lastId` marks where the stream continues. */
  async snapshot(ownerKey: string): Promise<ActivitySnapshot & { lastId: number }> {
    const raw = this.hub.snapshot();
    const lookup = this.cachedLookup(ownerKey);
    const running: ActivityRun[] = [];
    for (const run of raw.running) {
      const subject = await lookup(run.sessionId);
      if (subject) running.push({ sessionId: run.sessionId, ...subject, startedAt: run.startedAt });
    }
    const recent: ActivityResult[] = [];
    for (const activity of raw.recent) {
      if (recent.length >= ACTIVITY_RECENT_LIMIT) break;
      const subject = await lookup(activity.sessionId);
      const event = subject && toEvent(activity, subject);
      if (event && event.kind !== "started") recent.push(event);
    }
    return { lastId: raw.lastId, running, recent };
  }

  /** One change as this caller sees it; `null` when the session is not theirs to see. */
  async view(ownerKey: string, activity: RawActivity): Promise<ActivityEvent | null> {
    const subject = await this.subject(ownerKey, activity.sessionId);
    return subject && toEvent(activity, subject);
  }

  subscribe(listener: (activity: RawActivity) => void): () => void {
    return this.hub.subscribe(listener);
  }

  /** One lookup per session within a single reply. */
  private cachedLookup(ownerKey: string): (sessionId: string) => Promise<Subject | null> {
    const cache = new Map<string, Promise<Subject | null>>();
    return sessionId => {
      let found = cache.get(sessionId);
      if (!found) {
        found = this.subject(ownerKey, sessionId);
        cache.set(sessionId, found);
      }
      return found;
    };
  }
}

function toEvent(activity: RawActivity, subject: Subject): ActivityEvent {
  const base = { id: activity.id, at: activity.at, sessionId: activity.sessionId, projectId: subject.projectId, title: subject.title };
  if (activity.kind === "started") return { ...base, kind: "started" };
  return {
    ...base,
    kind: activity.kind,
    durationMs: activity.durationMs ?? 0,
    ...(activity.message ? { message: activity.message } : {}),
  };
}
