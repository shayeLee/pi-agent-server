import { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortTrace, installAbortTrace, traceSessionLifecycle, withAbortTrace } from "../../src/core/abort-trace.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("opt-in abort diagnostics do not change cancellation", () => {
  it("does nothing by default", () => {
    vi.stubEnv("PI_ABORT_TRACE", "");
    const kill = process.kill;
    const session = { abort: vi.fn() };
    const original = session.abort;
    const release = installAbortTrace();
    traceSessionLifecycle(session, "s");
    expect(session.abort).toBe(original);
    expect(process.kill).toBe(kill);
    release();
  });
  it("captures kill origin and context, forwards exactly once and restores on last close", () => {
    vi.stubEnv("PI_ABORT_TRACE", "1");
    const output: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => { output.push(String(chunk)); return true; });
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const childKill = vi.spyOn(ChildProcess.prototype, "kill").mockReturnValue(false);
    const first = installAbortTrace(); const second = installAbortTrace();
    try {
      withAbortTrace("s1", () => { expect(process.kill(-12345, "SIGTERM")).toBe(true); });
      const child = new ChildProcess();
      expect(child.kill("SIGKILL")).toBe(false);
      process.kill(12345, 0);
      expect(processKill).toHaveBeenCalledTimes(2);
      expect(childKill).toHaveBeenCalledOnce();
      const rows = output.map(line => JSON.parse(line));
      expect(rows.find(row => row.event === "process.kill")).toMatchObject({ sessionId: "s1", targetPid: -12345, signal: "SIGTERM", stack: expect.any(String) });
      expect(rows.filter(row => row.event === "process.kill")).toHaveLength(1);
      first(); expect(process.kill).not.toBe(processKill);
    } finally { first(); second(); }
    expect(process.kill).toBe(processKill);
    expect(ChildProcess.prototype.kill).toBe(childKill);
  });
  it("preserves method receiver, arguments, return values, thrown errors and Promise identity", async () => {
    vi.stubEnv("PI_ABORT_TRACE", "1");
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const done = Promise.resolve("aborted"); const error = new Error("test error");
    const session = { value: 4, abort(_value: string) { expect(this.value).toBe(4); return done; }, reload() { throw error; }, dispose() { return this.value; } };
    traceSessionLifecycle(session, "s1");
    expect(session.abort("a")).toBe(done);
    expect(() => session.reload()).toThrow(error);
    expect(session.dispose()).toBe(4);
    await done;
  });
  it("does not interfere when diagnostics cannot write", () => {
    vi.stubEnv("PI_ABORT_TRACE", "1");
    vi.spyOn(process.stderr, "write").mockImplementation(() => { throw new Error("unwritable fixture"); });
    expect(() => abortTrace("fixture")).not.toThrow();
    const session = { abort: vi.fn(() => 7) };
    traceSessionLifecycle(session, "s");
    expect(session.abort()).toBe(7);
  });
});
