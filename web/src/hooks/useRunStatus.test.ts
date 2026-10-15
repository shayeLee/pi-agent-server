import { describe, expect, it } from "vitest";
import { formatElapsed, nextTrack } from "./useRunStatus.js";

const start = { sessionId: "s1", phase: "idle" as const, startedAt: null, terminal: null };

describe("run status transitions (DESIGN.md §5.2)", () => {
  it("times only a start observed by this page and reports the duration on completion", () => {
    let track = nextTrack(start, "s1", "submitting", false, 1_000);
    track = nextTrack(track, "s1", "streaming", false, 2_000);
    expect(track.startedAt).toBe(2_000);
    track = nextTrack(track, "s1", "completed", false, 320_000);
    expect(track.terminal).toEqual({ kind: "completed", durationMs: 318_000 });
  });

  it("never invents a timer for a run joined mid-way", () => {
    const joined = nextTrack(start, "s1", "streaming", false, 5_000);
    expect(joined.startedAt).toBeNull();
    expect(nextTrack(joined, "s1", "aborted", false, 9_000).terminal).toEqual({ kind: "aborted", durationMs: null });
  });

  it("marks failure only for an error ending a run, and resets on session change", () => {
    const running = nextTrack(nextTrack(start, "s1", "queued", false, 0), "s1", "streaming", false, 10);
    expect(nextTrack(running, "s1", "idle", true, 50).terminal?.kind).toBe("failed");
    expect(nextTrack(running, "s1", "idle", false, 50).terminal).toBeNull();
    expect(nextTrack(running, "s2", "idle", true, 50)).toEqual({ sessionId: "s2", phase: "idle", startedAt: null, terminal: null });
  });

  it("formats elapsed time as a clock", () => {
    expect(formatElapsed(134_000)).toBe("02:14");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });
});
