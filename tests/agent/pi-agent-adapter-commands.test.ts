import { describe, expect, it, vi } from "vitest";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import { FAILBACK_HOST_TRANSPORT_EVENT, type FailbackHostTransport } from "../../src/agent/failback-host-transport.js";
import { projectExportSnapshot } from "../../src/agent/session-export.js";
import type { CommandOutputEvent } from "../../src/shared/events.js";
import type { CommandEvent } from "../../src/agent/pi-agent-adapter.js";

/** Mirrors the SDK runner: no UI by default; command contexts read whatever UI is current. */
type FakeUI = {
  notify(message: string, type?: string): void;
  setWidget(key: string, lines: string[]): void;
  select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  custom(factory: unknown): Promise<unknown>;
  theme: { fg(color: string, text: string): string };
};
function extensionSession(commands: Record<string, (args: string, ctx: { hasUI: boolean; ui: FakeUI }) => Promise<void>>) {
  const noUI = { notify: () => {}, select: async () => undefined, confirm: async () => false, theme: { fg: (_color: string, text: string) => text } };
  const runner = {
    uiContext: noUI as object, mode: "json" as string,
    hasHandlers: () => false, emit: async () => {},
    getCommand: (name: string) => commands[name] ? { handler: commands[name] } : undefined,
    setUIContext(ui: object | undefined, mode = "print") { runner.uiContext = ui ?? noUI; runner.mode = mode; },
    createCommandContext: () => ({ hasUI: runner.uiContext !== noUI, ui: runner.uiContext }),
  };
  const entries: Record<string, unknown>[] = [];
  const sessionManager = {
    getBranch: () => entries,
    appendCustomEntry: (customType: string, data: unknown) => {
      const id = `e${entries.length + 1}`;
      entries.push({ type: "custom", customType, data, id, parentId: null, timestamp: "2026-10-19T10:00:00.000Z" });
      return id;
    },
    getEntry: (id: string) => entries.find(entry => entry.id === id),
  };
  const session = {
    messages: [], extensionRunner: runner, sessionManager,
    prompt: async () => {}, steer: async () => {}, followUp: async () => {}, abort: async () => {}, navigateTree: async () => {},
    setModel: async () => {}, setThinkingLevel: () => {}, subscribe: () => () => {}, dispose: () => {},
  } as unknown as AgentSessionLike;
  return { adapter: new PiAgentAdapter(session), runner, noUI, entries };
}

/** Session whose compaction asks the failback host transport, as model-failback's session_before_compact does. */
function setup() {
  const handlers = new Map<string, (data: unknown) => void>();
  const source = { on: (channel: string, handler: (data: unknown) => void) => { handlers.set(channel, handler); return () => handlers.delete(channel); } };
  let transport: FailbackHostTransport | undefined;
  let release: (() => void) | undefined;
  const seen: boolean[] = [];
  const session = {
    messages: [], calls: [] as string[],
    prompt: async () => {}, steer: async () => {}, followUp: async () => {}, abort: async () => {}, navigateTree: async () => {},
    setModel: async () => {}, setThinkingLevel: () => {}, subscribe: () => () => {}, dispose: () => {},
    compact: async () => {
      seen.push(transport!.cancelled());
      await new Promise<void>(resolve => { release = resolve; });
      if (transport!.cancelled()) throw new Error("Compaction cancelled");
      return { tokensBefore: 100, estimatedTokensAfter: 20 };
    },
    abortCompaction: () => release?.(),
  } as unknown as AgentSessionLike;
  const adapter = new PiAgentAdapter(session, undefined, source);
  handlers.get(FAILBACK_HOST_TRANSPORT_EVENT)?.({ version: 1, accept: (t: FailbackHostTransport) => { transport = t; } });
  return { adapter, seen, transport: () => transport!, finish: () => release?.() };
}

describe("PiAgentAdapter host commands", () => {
  it("keeps an idle /compact live for extensions until it is aborted", async () => {
    const { adapter, seen, transport, finish } = setup();
    expect(transport().cancelled()).toBe(true);
    const done = adapter.runCommand({ command: "compact" });
    await Promise.resolve();
    expect(seen).toEqual([false]);
    finish();
    await expect(done).resolves.toEqual({ command: "compact", tokensBefore: 100, tokensAfter: 20 });
    expect(transport().cancelled()).toBe(true);

    const aborted = adapter.runCommand({ command: "compact" });
    await Promise.resolve();
    adapter.abortCommand();
    await expect(aborted).rejects.toThrow("Compaction cancelled");
    adapter.dispose();
  });
});

describe("PiAgentAdapter extension commands", () => {
  it("collects what a command shows, records it in the session, and restores the UI", async () => {
    const { adapter, runner, noUI, entries } = extensionSession({
      "antigravity.usage": async (args, ctx) => {
        expect(ctx.hasUI).toBe(true);
        ctx.ui.notify(ctx.ui.theme.fg("accent", "\x1b[32mGemini pool: 80%\x1b[0m"), "info");
        ctx.ui.setWidget("usage", ["5h: 12/50", "weekly: 3/200"]);
        ctx.ui.notify(`args=${args}`, "warning");
        expect(await ctx.ui.custom(() => null)).toBeUndefined();
      },
    });
    const published: CommandOutputEvent[] = [];
    adapter.subscribeCommandEvents(event => { if (event.type === "command_output") published.push(event); });
    const result = await adapter.runCommand({ command: "extension", name: "antigravity.usage", args: " all " });
    const output = [
      { level: "info", text: "Gemini pool: 80%" },
      { level: "info", text: "5h: 12/50\nweekly: 3/200" },
      { level: "warning", text: "args=all" },
      { level: "warning", text: expect.stringContaining("终端界面") },
    ];
    expect(result).toEqual({ command: "extension", name: "antigravity.usage", output });
    expect(runner.uiContext).toBe(noUI);
    expect(runner.mode).toBe("json");
    expect(entries).toHaveLength(1);
    expect(published).toEqual([{ type: "command_output", version: 1, name: "antigravity.usage", args: "all", output, failed: false, entryId: "e1", timestamp: "2026-10-19T10:00:00.000Z" }]);
    // 记录在会话里，导出历史时也在；它不是消息，不会进模型上下文。
    expect(projectExportSnapshot([], entries as never).timeline).toEqual([
      expect.objectContaining({ id: "command:e1", type: "command_output", name: "antigravity.usage", order: 0 }),
    ]);
    adapter.dispose();
  });

  it("records a command that throws as failed output, and rejects unknown commands", async () => {
    const { adapter, runner, noUI } = extensionSession({ broken: async () => { throw new Error("No Antigravity credentials"); } });
    await expect(adapter.runCommand({ command: "extension", name: "broken" })).resolves.toEqual({
      command: "extension", name: "broken", output: [{ level: "error", text: "No Antigravity credentials" }],
    });
    expect(runner.uiContext).toBe(noUI);
    await expect(adapter.runCommand({ command: "extension", name: "missing" })).rejects.toThrow("/missing");
    adapter.dispose();
  });

  it("stops waiting for a command after three minutes and ignores what it shows later", async () => {
    vi.useFakeTimers();
    try {
      let late: (() => void) | undefined;
      const { adapter, runner, noUI, entries } = extensionSession({
        slow: (_args, ctx) => new Promise<void>(resolve => { late = () => { ctx.ui.notify("late"); resolve(); }; }),
      });
      const result = adapter.runCommand({ command: "extension", name: "slow" });
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await expect(result).resolves.toEqual({ command: "extension", name: "slow", output: [{ level: "error", text: expect.stringContaining("3 分钟") }] });
      expect(runner.uiContext).toBe(noUI);
      late!();
      expect((entries[0]!.data as { output: unknown[]; failed: boolean })).toMatchObject({ output: [expect.anything()], failed: true });
      adapter.dispose();
    } finally { vi.useRealTimers(); }
  });
});

describe("PiAgentAdapter extension command dialogs", () => {
  /** Runs `name` and collects the prompt events every page would receive. */
  function start(commands: Parameters<typeof extensionSession>[0], name: string) {
    const session = extensionSession(commands);
    const events: CommandEvent[] = [];
    session.adapter.subscribeCommandEvents(event => events.push(event));
    const result = session.adapter.runCommand({ command: "extension", name });
    return { ...session, events, result };
  }
  const opened = async (adapter: PiAgentAdapter) => {
    await vi.waitFor(() => expect(adapter.getCommandPrompt()).not.toBeNull());
    return adapter.getCommandPrompt()!;
  };

  it("asks every page, takes the first valid answer, and closes the question for all", async () => {
    const { adapter, events, result } = start({
      "workbuddy": async (_args, ctx) => {
        const plan = await ctx.ui.select("Plan", ["free", "all"]);
        const sure = await ctx.ui.confirm("Switch?", `to ${plan}`);
        const note = await ctx.ui.input("Note", "optional");
        ctx.ui.notify(`plan=${plan} sure=${sure} note=${note}`);
      },
    }, "workbuddy");
    const select = await opened(adapter);
    expect(select).toMatchObject({ command: "workbuddy", kind: "select", title: "Plan", options: ["free", "all"], expiresAt: expect.any(Number) });
    expect(events).toContainEqual({ type: "command_prompt", prompt: select });
    expect(adapter.answerCommandPrompt({ promptId: select.promptId, value: "paid" })).toBe("invalid");
    expect(adapter.answerCommandPrompt({ promptId: select.promptId, confirmed: true })).toBe("invalid");
    expect(adapter.answerCommandPrompt({ promptId: select.promptId, value: "all" })).toBe("ok");
    // 第二个页面晚了一步。
    expect(adapter.answerCommandPrompt({ promptId: select.promptId, value: "free" })).toBe("stale");
    expect(events).toContainEqual({ type: "command_prompt_closed", promptId: select.promptId, reason: "answered" });

    const confirm = await opened(adapter);
    expect(confirm).toMatchObject({ kind: "confirm", title: "Switch?", message: "to all" });
    expect(adapter.answerCommandPrompt({ promptId: confirm.promptId, confirmed: true })).toBe("ok");
    const input = await opened(adapter);
    expect(input).toMatchObject({ kind: "input", placeholder: "optional" });
    expect(adapter.answerCommandPrompt({ promptId: input.promptId, cancel: true })).toBe("ok");
    expect(events).toContainEqual({ type: "command_prompt_closed", promptId: input.promptId, reason: "cancelled" });

    await expect(result).resolves.toEqual({ command: "extension", name: "workbuddy", output: [{ level: "info", text: "plan=all sure=true note=undefined" }] });
    expect(adapter.getCommandPrompt()).toBeNull();
    adapter.dispose();
  });

  it("closes a question when the extension cancels it or its own timeout passes", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { adapter, events, result } = start({
        pick: async (_args, ctx) => {
          ctx.ui.notify(`first=${await ctx.ui.select("First", ["a"], { signal: controller.signal })}`);
          ctx.ui.notify(`second=${await ctx.ui.select("Second", ["b"], { timeout: 30_000 })}`);
        },
      }, "pick");
      const first = await opened(adapter);
      controller.abort();
      const second = await opened(adapter);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(result).resolves.toMatchObject({ output: [
        { level: "info", text: "first=undefined" },
        { level: "warning", text: expect.stringContaining("Second") },
        { level: "info", text: "second=undefined" },
      ] });
      expect(events.filter(event => event.type === "command_prompt_closed")).toEqual([
        { type: "command_prompt_closed", promptId: first.promptId, reason: "cancelled" },
        { type: "command_prompt_closed", promptId: second.promptId, reason: "timeout" },
      ]);
      adapter.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("does not count time spent waiting for an answer against the command limit", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, result } = start({ slow: async (_args, ctx) => { ctx.ui.notify(`got ${await ctx.ui.confirm("Go?", "")}`); } }, "slow");
      const prompt = await opened(adapter);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(adapter.answerCommandPrompt({ promptId: prompt.promptId, confirmed: true })).toBe("ok");
      await expect(result).resolves.toMatchObject({ output: [{ level: "info", text: "got true" }] });
      adapter.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("cancels an open question when the session goes away", async () => {
    const { adapter, events, result } = start({ ask: async (_args, ctx) => { ctx.ui.notify(String(await ctx.ui.input("Name"))); } }, "ask");
    const prompt = await opened(adapter);
    adapter.dispose();
    await expect(result).resolves.toMatchObject({ output: [{ level: "info", text: "undefined" }] });
    expect(events).toContainEqual({ type: "command_prompt_closed", promptId: prompt.promptId, reason: "cancelled" });
  });
});
