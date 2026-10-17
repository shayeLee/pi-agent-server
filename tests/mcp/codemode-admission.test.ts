import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CodemodeGate, createCodemodeAdmissionExtension, withCodemodeTimeout } from "../../src/mcp/codemode-admission.js";

describe("withCodemodeTimeout", () => {
  it("adds an options line when the script has none", () => {
    expect(withCodemodeTimeout("return 1", 1000)).toBe('// @options: {"timeout_ms":1000}\nreturn 1');
  });

  it("clamps a longer timeout and keeps other options", () => {
    expect(withCodemodeTimeout('// @options: {"max_output_tokens": 50, "timeout_ms": 999999}\nreturn 1', 1000))
      .toBe('// @options: {"max_output_tokens":50,"timeout_ms":1000}\nreturn 1');
    expect(withCodemodeTimeout('// @options: {"timeout_ms": 10}\nreturn 1', 1000)).toBe('// @options: {"timeout_ms":10}\nreturn 1');
  });

  it("leaves invalid option lines and empty scripts for the SDK to reject", () => {
    expect(withCodemodeTimeout("// @options: nope\nreturn 1", 1000)).toBe("// @options: nope\nreturn 1");
    expect(withCodemodeTimeout("  ", 1000)).toBe("  ");
  });
});

describe("CodemodeGate", () => {
  it("queues beyond capacity and hands slots over in order", async () => {
    const gate = new CodemodeGate(1);
    const first = await gate.acquire(1000);
    const order: string[] = [];
    const second = gate.acquire(1000).then(release => { order.push("second"); return release; });
    const third = gate.acquire(1000).then(release => { order.push("third"); return release; });
    expect(gate.queued).toBe(2);
    first!();
    (await second)!();
    (await third)!();
    expect(order).toEqual(["second", "third"]);
    expect(gate.running).toBe(0);
  });

  it("gives up after the wait or on abort", async () => {
    const gate = new CodemodeGate(1);
    const held = await gate.acquire(1000);
    expect(await gate.acquire(5)).toBeNull();
    const controller = new AbortController();
    const waiting = gate.acquire(1000, controller.signal);
    controller.abort();
    expect(await waiting).toBeNull();
    expect(gate.queued).toBe(0);
    held!();
    expect(gate.running).toBe(0);
  });
});

describe("createCodemodeAdmissionExtension", () => {
  function install(gate: CodemodeGate) {
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    const pi = { on: (event: string, handler: (event: never, ctx: never) => unknown) => { handlers.set(event, handler); } };
    createCodemodeAdmissionExtension({ gate, timeoutMs: 1000, queueWaitMs: 5 }).factory(pi as unknown as ExtensionAPI);
    const call = (event: object) => handlers.get("tool_call")!(event as never, { signal: undefined } as never);
    const end = (toolCallId: string) => handlers.get("tool_execution_end")!({ toolCallId } as never, {} as never);
    return { call, end };
  }

  it("injects a timeout, holds a slot until the call ends, and blocks when busy", async () => {
    const gate = new CodemodeGate(1);
    const { call, end } = install(gate);
    const input = { code: "return 1" };
    expect(await call({ toolName: "codemode", toolCallId: "a", input })).toBeUndefined();
    expect(input.code).toBe('// @options: {"timeout_ms":1000}\nreturn 1');
    expect(gate.running).toBe(1);
    expect(await call({ toolName: "codemode", toolCallId: "b", input: { code: "1" } })).toMatchObject({ block: true });
    expect(await call({ toolName: "read", toolCallId: "c", input: {} })).toBeUndefined();
    end("a");
    end("a");
    expect(gate.running).toBe(0);
  });
});
