import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, SubagentRun, SubagentSnapshot } from "pi-agent-server/client";
import { RETRY_MS, WATCHDOG_MS, useSubagents, type SubagentFeedOptions } from "./useSubagents.js";

const run = (status: SubagentRun["status"]): SubagentRun => ({ id: "r", runId: "1", agent: "worker", task: "t", startedAt: 0, status, revision: 1 });
const snapshot = (...statuses: SubagentRun["status"][]): SubagentSnapshot => ({ sessionId: "s", runs: statuses.map((status, i) => ({ ...run(status), id: `r${i}` })) });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function setup(responses: Array<SubagentSnapshot | Error>, options: Partial<SubagentFeedOptions> = {}) {
  const getSubagents = vi.fn(async (_session: string, _runId?: string) => {
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  const api = { getSubagents } as unknown as ApiClient;
  const props: SubagentFeedOptions = { runId: null, visible: true, live: false, signal: null, ...options };
  const hook = renderHook((current: SubagentFeedOptions) => useSubagents(api, "s", current), { initialProps: props });
  let position = 0;
  /** The server pushed subagents_changed. */
  const signal = async () => { props.signal = `s:${++position}`; hook.rerender({ ...props }); await tick(0); };
  return { getSubagents, hook, signal };
}

describe("useSubagents reads", () => {
  it("reads a settled session once and then stays quiet", async () => {
    const { getSubagents } = setup([snapshot("completed", "failed", "stopped")]);
    await tick(0);
    await tick(WATCHDOG_MS * 4);
    expect(getSubagents).toHaveBeenCalledTimes(1);
  });

  it("reads on each subagents_changed and never polls between signals", async () => {
    const { getSubagents, signal } = setup([snapshot("running")]);
    await tick(0);
    await tick(WATCHDOG_MS - 1);
    expect(getSubagents).toHaveBeenCalledTimes(1);
    await signal();
    expect(getSubagents).toHaveBeenCalledTimes(2);
    await signal();
    expect(getSubagents).toHaveBeenCalledTimes(3);
  });

  it("falls back to one read after a quiet stretch while a child still runs (builds without transcript events)", async () => {
    const { getSubagents } = setup([snapshot("running"), snapshot("completed")]);
    await tick(0);
    await tick(WATCHDOG_MS);
    expect(getSubagents).toHaveBeenCalledTimes(2);
    // Settled now: no further fallback reads.
    await tick(WATCHDOG_MS * 4);
    expect(getSubagents).toHaveBeenCalledTimes(2);
  });

  it("retries a failed read", async () => {
    const { getSubagents } = setup([new Error("offline"), snapshot("completed")]);
    await tick(0);
    await tick(RETRY_MS);
    expect(getSubagents).toHaveBeenCalledTimes(2);
    await tick(WATCHDOG_MS * 4);
    expect(getSubagents).toHaveBeenCalledTimes(2);
  });
});

describe("shared feed for the Inspector and the live panel", () => {
  const conversation = (id: string, tools: string[]) => ({ run: { ...run("running"), id }, messages: [], inputs: [],
    timeline: tools.map(t => ({ kind: "tool", id: t, call: { toolCallId: t, toolName: "bash", args: { command: t }, isError: false, done: true } })) });

  it("serves the list, the open conversation and the live panel from one list read per signal", async () => {
    let revision = 1;
    const getSubagents = vi.fn(async (_session: string, runId?: string) => runId
      ? { sessionId: "s", runs: [], conversation: conversation(runId, ["a", "b"]) }
      : { sessionId: "s", runs: [{ ...run("running"), id: "r0", revision }, { ...run("running"), id: "r1", revision: 1 }] });
    const api = { getSubagents } as unknown as ApiClient;
    const props: SubagentFeedOptions = { runId: "r0", visible: true, live: true, signal: "s:0" };
    const hook = renderHook((current: SubagentFeedOptions) => useSubagents(api, "s", current), { initialProps: props });
    await tick(0);
    const lists = () => getSubagents.mock.calls.filter(call => call[1] === undefined).length;
    const detailsFor = (id: string) => getSubagents.mock.calls.filter(call => call[1] === id).length;
    expect(lists()).toBe(1);
    // r0 is both open and live: one detail read serves both.
    expect(detailsFor("r0")).toBe(1);
    expect(detailsFor("r1")).toBe(1);
    expect(hook.result.current.conversation?.run.id).toBe("r0");
    expect(hook.result.current.live.map(item => [item.run.id, item.actions.map(a => a.id)])).toEqual([["r0", ["a", "b"]], ["r1", ["a", "b"]]]);
    // Unchanged runs are not read again; a moved revision is.
    hook.rerender({ ...props, signal: "s:1" }); await tick(0);
    expect(lists()).toBe(2);
    expect(detailsFor("r0")).toBe(1);
    revision = 2;
    hook.rerender({ ...props, signal: "s:2" }); await tick(0);
    expect(detailsFor("r0")).toBe(2);
    expect(detailsFor("r1")).toBe(1);
  });

  it("feeds no live panel unless the parent turn is streaming", async () => {
    const { getSubagents, hook } = setup([snapshot("running")], { visible: false });
    await tick(0);
    expect(hook.result.current.runs).toHaveLength(1);
    expect(hook.result.current.live).toEqual([]);
    // Without the panel or an open conversation, no per-run detail is read.
    expect(getSubagents.mock.calls.every(call => call[1] === undefined)).toBe(true);
  });
});
