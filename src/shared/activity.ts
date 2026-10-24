// Runs across all sessions a caller can see (docs/companion-butler.md §4): what is running now and
// how recent runs ended. Only titles, states and a one-line error; never model content.

/** A session whose turn is running now. */
export type ActivityRun = {
  sessionId: string;
  projectId: string;
  title: string;
  startedAt: number;
};

export type ActivityOutcome = "completed" | "failed" | "aborted";

/** How one run ended. `message` is the first line of the error, at most 200 characters. */
export type ActivityResult = {
  id: number;
  at: number;
  sessionId: string;
  projectId: string;
  title: string;
  kind: ActivityOutcome;
  durationMs: number;
  message?: string;
};

/** One change on the activity stream: a run started, or a run ended. */
export type ActivityEvent =
  | { id: number; at: number; sessionId: string; projectId: string; title: string; kind: "started" }
  | ActivityResult;

/** Reply of `GET /v1/activity`; newest results first. */
export type ActivitySnapshot = {
  running: ActivityRun[];
  recent: ActivityResult[];
};

/**
 * `GET /v1/activity/events`: every connection starts with a snapshot, then sends each change
 * after it. A reconnect gets a fresh snapshot, so nothing needs replaying.
 */
export type ActivityStreamMessage =
  | ({ type: "activity_snapshot" } & ActivitySnapshot)
  | { type: "activity"; event: ActivityEvent };
