import { useEffect, useState } from "react";
import { SseHttpError, createSseConnection, type ActivityEvent, type ActivityResult, type ActivityRun, type ActivityStreamMessage } from "pi-agent-server/client";

/** How many ended runs the page keeps; the server sends at most 200 on connect. */
export const ACTIVITY_RECENT_KEEP = 50;

export type Activity = {
  /** Running now, by session id. */
  running: ReadonlyMap<string, ActivityRun>;
  /** Ended runs, newest first. */
  recent: readonly ActivityResult[];
  /** The latest change seen live on this page (never one from a snapshot); `null` until one comes. */
  latest: ActivityEvent | null;
};

const EMPTY: Activity = { running: new Map(), recent: [], latest: null };

export function applyActivityMessage(state: Activity, message: ActivityStreamMessage): Activity {
  if (message.type === "activity_snapshot") {
    return { running: new Map(message.running.map(run => [run.sessionId, run])), recent: message.recent.slice(0, ACTIVITY_RECENT_KEEP), latest: state.latest };
  }
  const event = message.event;
  const running = new Map(state.running);
  if (event.kind === "started") {
    running.set(event.sessionId, { sessionId: event.sessionId, projectId: event.projectId, title: event.title, startedAt: event.at });
    return { running, recent: state.recent, latest: event };
  }
  running.delete(event.sessionId);
  return { running, recent: [event, ...state.recent].slice(0, ACTIVITY_RECENT_KEEP), latest: event };
}

/**
 * Runs across every session this person can see (docs/companion-butler.md §4), from
 * `/v1/activity/events`. Each (re)connect starts from a fresh snapshot. A new login starts over.
 */
export function useActivity(options: { authGeneration?: number; onAuthExpired?: () => void }): Activity {
  const [activity, setActivity] = useState<Activity>(EMPTY);
  const { authGeneration, onAuthExpired } = options;
  useEffect(() => {
    setActivity(EMPTY);
    const connection = createSseConnection<ActivityStreamMessage>({
      url: "/v1/activity/events",
      onEvent: message => {
        if (message.type !== "activity_snapshot" && message.type !== "activity") return;
        setActivity(state => applyActivityMessage(state, message));
      },
      // A server without the activity feed answers 404: stop instead of retrying forever.
      onError: error => { if (error instanceof SseHttpError && error.status === 404) connection.close(); },
      ...(onAuthExpired ? { onAuthExpired } : {}),
    });
    return () => connection.close();
  }, [authGeneration]);
  return activity;
}
