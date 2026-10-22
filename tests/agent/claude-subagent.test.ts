import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { ClaudeEventBridge, InputChannel, listenForSteering, queryOptions, runClaude, writeSkillPlugin, subscriptionEnvironment, type QueryFactory, type RunnerEvent } from "../../integrations/agent-team/claude-sdk/runner.js";
import { agentBackend, claudeInvocation, loadClaudeWorker } from "../../integrations/agent-team/claude-backend.js";
import { TranscriptJournal } from "../../integrations/agent-team/transcript.js";
import { projectSubagents, subagentUsage } from "../../src/agent/subagent-transcript.js";

const config = { task: "inspect", cwd: "/fixture", executable: "/fixture/claude" };
const assistant = (uuid: string, id: string, content: unknown[], usage = { input_tokens: 4, output_tokens: 2 }) =>
  ({ type: "assistant", uuid, parent_tool_use_id: null, message: { id, model: "fixture-model", content, usage } });
const success = { type: "result", subtype: "success", is_error: false, result: "done", uuid: "terminal" };
const fakeQuery = (messages: any[], after?: () => void) => {
  const close = vi.fn();
  const query = vi.fn(() => ({ close, async *[Symbol.asyncIterator]() { yield* messages; after?.(); } })) as unknown as QueryFactory;
  return { query, close };
};

describe("Claude SDK child (offline only)", () => {
  it("loads independent JSON including its prompt, preserves empty tools and rejects invalid fields", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-config-"));
    try {
      expect(loadClaudeWorker(home)).toBeUndefined();
      const dir = join(home, ".pi", "agent", "claude-agents"); mkdirSync(dir, {recursive: true});
      const file = join(dir, "claude-worker.json");
      const value = {name: "claude-worker", description: "Architecture and frontend", systemPrompt: "./worker.md", tools: [], permissionMode: "acceptEdits"};
      writeFileSync(join(dir, "worker.md"), "Implement the assignment");
      writeFileSync(file, JSON.stringify(value));
      expect(loadClaudeWorker(home)).toMatchObject({backend:"claude", source:"user", tools:[], systemPrompt:"Implement the assignment", claudePermissionMode:"acceptEdits"});
      writeFileSync(file, JSON.stringify({...value, systemPrompt: join(dir, "worker.md")}));
      expect(loadClaudeWorker(home)?.systemPrompt).toBe("Implement the assignment");
      writeFileSync(file, JSON.stringify({...value, systemPrompt: "missing.md"}));
      expect(() => loadClaudeWorker(home)).toThrow("Cannot read Claude systemPrompt file");
      writeFileSync(join(dir, "empty.md"), "  ");
      writeFileSync(file, JSON.stringify({...value, systemPrompt: "empty.md"}));
      expect(() => loadClaudeWorker(home)).toThrow("systemPrompt file is empty");
      for (const [patch, reason] of [[{permissionMode:"typo"}, "permissionMode"], [{tools:"Read"}, "tools"], [{thinking:"high"}, "unknown field thinking"], [{systemPrompt:""}, "systemPrompt"]] as const) {
        writeFileSync(file, JSON.stringify({...value,...patch}));
        expect(() => loadClaudeWorker(home)).toThrow(`Invalid Claude worker configuration: ${file}: ${reason}`);
      }
      writeFileSync(file, "{ not json");
      expect(() => loadClaudeWorker(home)).toThrow("not valid JSON");
    } finally { rmSync(home, {recursive:true, force:true}); }
  });

  it("routes roles without importing or invoking the real SDK", () => {
    expect(agentBackend({ systemPrompt: "" })).toBe("pi");
    expect(agentBackend({ backend: "claude", systemPrompt: "" })).toBe("claude");
    expect(() => agentBackend({ backend: "typo", systemPrompt: "" })).toThrow("Unsupported");
    const invocation = claudeInvocation({ systemPrompt: "role", tools: ["Read"] }, "task $(literal)", "/fixture", { PI_CLAUDE_EXECUTABLE: "/custom/claude" });
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[0]).toMatch(/claude-sdk\/worker.mjs$/);
    expect(invocation.args.join(" ")).not.toContain("task");
    expect(JSON.parse(invocation.input)).toMatchObject({ task: "task $(literal)", executable: "/custom/claude", tools: ["Read"] });
    expect(() => claudeInvocation({ systemPrompt: "", thinkingLevel: "high" }, "task", "/fixture")).toThrow("claudeEffort");
    const withContext = JSON.parse(claudeInvocation({ systemPrompt: "role" }, "task", "/fixture", { PI_CLAUDE_EXECUTABLE: "/custom/claude" },
      { controlSocket: "/fixture/control.sock", skills: [{ name: "dws", path: "/skills/dws/SKILL.md" }], contextFiles: [
        { path: "/pi-agent/AGENTS.md", content: "Answer in Chinese." },   // Pi's global file: Claude never reads it
        { path: "/AGENTS.md", content: "Ancestor rule." },             // Claude loads cwd and ancestors itself
        { path: "/fixture/CLAUDE.md", content: "Never commit." },
        { path: "/fixture/AGENTS.override.md", content: "Override." },
      ] }).input);
    expect(withContext.controlSocket).toBe("/fixture/control.sock");
    expect(withContext.skills).toEqual([{ name: "dws", path: "/skills/dws/SKILL.md" }]);
    expect(withContext.systemPrompt).toBe('role\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="/pi-agent/AGENTS.md">\nAnswer in Chinese.\n</project_instructions>\n\n<project_instructions path="/fixture/AGENTS.override.md">\nOverride.\n</project_instructions>');
  });

  it("isolates subscription routing and uses the explicitly selected native executable", async () => {
    const env = { PATH: "/bin", HOME: "/fixture-home", ANTHROPIC_API_KEY: "secret", ANTHROPIC_BASE_URL: "proxy",
      CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "secret", CLAUDECODE: "1", MODEL_FAILBACK_CHILD: "1" };
    expect(subscriptionEnvironment(env)).toEqual({ PATH: "/bin", HOME: "/fixture-home" });
    expect(env.ANTHROPIC_API_KEY).toBe("secret");
    const options = queryOptions({ ...config, systemPrompt: "role" }, new AbortController(), env);
    expect(options).toMatchObject({ pathToClaudeCodeExecutable: "/fixture/claude", settingSources: ["user", "project", "local"], skills: "all", persistSession: false,
      permissionMode: "dontAsk", tools: ["Read", "Glob", "Grep", "Skill"], includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code" } });
    expect((options.systemPrompt as any).append).toMatch(/^role\n\nYour last reply is returned to the agent that delegated this task as its whole result\./);
    const command = { command: "npm test", timeout: 120000 };
    expect(await options.canUseTool!("Bash", command, {} as any)).toEqual({ behavior: "allow", updatedInput: command });
    expect(() => queryOptions({ ...config, permissionMode: "bypassPermissions" as any }, new AbortController())).toThrow();
    expect(() => queryOptions({ ...config, executable: "claude" }, new AbortController())).toThrow();
  });

  it("persists block-level messages once, associates tool results, and avoids aggregate usage double-counting", async () => {
    const entries: any[] = [];
    const journal = new TranscriptJournal((customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }), () => {});
    journal.start({ id: "1", agent: "claude-worker", task: "inspect", startedAt: 1, backend: "claude", canSteer: false });
    const first = assistant("a1", "m1", [{ type: "text", text: "checking" }]);
    const tool = assistant("a2", "m1", [{ type: "tool_use", id: "call", name: "Read", input: { file_path: "a.ts" } }], { input_tokens: 4, output_tokens: 5 });
    const user = { type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "call", content: "source" }] } };
    const { query, close } = fakeQuery([first, first, tool, user, { ...user, uuid: "u2" },
      { ...assistant("nested", "m99", [{ type: "text", text: "nested" }]), parent_tool_use_id: "call" },
      assistant("a3", "m2", [{ type: "text", text: "done" }]), { ...success, usage: { input_tokens: 800 } }]);
    const events: RunnerEvent[] = [];
    expect(await runClaude(config, query, event => { events.push(event); journal.event("1", event); })).toBe(0);
    journal.finish("1", "completed", { endedAt: 10 });
    const snapshot = projectSubagents("parent", entries);
    const c = projectSubagents("parent", entries, undefined, snapshot.runs[0]!.id).conversation!;
    expect(c.run).toMatchObject({ backend: "claude", canSteer: false, status: "completed" });
    expect(c.messages).toHaveLength(4); // initial, assistant m1, tool result, assistant m2
    expect(c.timeline.filter(i => i.kind === "tool")).toHaveLength(1);
    expect(c.timeline.find(i => i.kind === "tool")).toMatchObject({ call: { toolName: "Read", args: { file_path: "a.ts" }, result: { content: [{ text: "source" }] } } });
    expect(subagentUsage(entries)).toMatchObject({ input: 8, output: 7 });
    expect(c.inputs[0]?.delivery).toBe("delivered");
    expect(events.at(-1)).toEqual({ type: "claude_run_result", status: "completed" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("shows transient deltas without persisting each token", () => {
    const entries: any[] = [], live = new Map();
    const journal = new TranscriptJournal((customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
      (type, data: any) => { if (type.endsWith("-live")) live.set(data.id, structuredClone(data)); });
    journal.start({ id: "1", agent: "claude", task: "task", startedAt: 1 });
    const bridge = new ClaudeEventBridge(event => journal.event("1", event));
    const feed = (event: any) => bridge.accept({ type: "stream_event", event } as any);
    feed({ type: "message_start", message: { id: "m", model: "test" } });
    feed({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 500);
    try { feed({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }); }
    finally { vi.restoreAllMocks(); }
    expect(JSON.stringify(entries)).not.toContain("partial");
    expect(JSON.stringify([...live.values()])).toContain("partial");
    bridge.accept(assistant("a", "m", [{ type: "text", text: "partial complete" }]) as any);
    bridge.accept({ ...success, result: "partial complete" } as any);
    bridge.finish();
    expect(entries.filter(e => e.data.kind === "message" && e.data.payload.complete)).toHaveLength(1);
  });

  it.each([
    ["missing result", [assistant("a", "m", [{ type: "text", text: "looks done" }])]],
    ["SDK error", [{ type: "result", subtype: "error_max_turns", is_error: true }]],
    ["error flag", [{ ...success, is_error: true }]],
    ["empty success", [{ ...success, result: "" }]],
    ["assistant error", [{ ...assistant("a", "m", [{ type: "text", text: "error" }]), error: "rate_limit" }, success]],
  ])("fails closed for %s", async (_name, messages) => {
    const events: RunnerEvent[] = [];
    expect(await runClaude(config, fakeQuery(messages as any[]).query, e => events.push(e))).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "claude_run_result", status: "failed" });
  });

  it("does not report success when the iterator throws after a success result", async () => {
    const { query, close } = fakeQuery([success], () => { throw new Error("secret credential"); });
    const events: RunnerEvent[] = [];
    expect(await runClaude(config, query, e => events.push(e))).toBe(1);
    expect(JSON.stringify(events)).not.toContain("secret credential");
    expect(close).toHaveBeenCalledOnce();
  });

  it("cancellation wins over a late result and closes the SDK handle", async () => {
    const controller = new AbortController();
    const { query, close } = fakeQuery([success], () => controller.abort());
    const events: RunnerEvent[] = [];
    expect(await runClaude(config, query, e => events.push(e), controller)).toBe(130);
    expect(events.at(-1)).toMatchObject({ status: "stopped" });
    expect(close).toHaveBeenCalled();
    const unopened = fakeQuery([success]);
    expect(await runClaude(config, unopened.query, () => {}, controller)).toBe(130);
    expect(unopened.query).not.toHaveBeenCalled();
  });

  it("journal failure closes the SDK rather than completing with an unsaved transcript", async () => {
    const { query, close } = fakeQuery([assistant("a", "m", [{ type: "text", text: "done" }]), success]);
    const events: RunnerEvent[] = [];
    expect(await runClaude(config, query, event => {
      if (event.type === "message_end" && event.message.role === "assistant") throw new Error("disk full");
      events.push(event);
    })).toBe(1);
    expect(close).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ status: "failed" });
  });

  it("keeps the prompt open until every send is answered, and gives up on a send nobody answers", async () => {
    const channel = new InputChannel(20);
    channel.push("task");
    const input = channel[Symbol.asyncIterator]();
    const first = (await input.next()).value!;
    expect(channel.push("steer", "next")).toBe(true);
    channel.settle({ user_message_uuids: [first.uuid], queued_turn_count: 0 });
    expect((await input.next()).value).toMatchObject({ message: { content: "steer" }, priority: "next" });
    // Per-turn bookkeeping is not work: it must not hold the idle fallback off.
    channel.activity({ type: "command_lifecycle", state: "completed" });
    channel.activity({ type: "system", subtype: "post_turn_summary" });
    await expect(input.next()).resolves.toMatchObject({ done: true }); // idle fallback after 20ms
    expect(channel.push("late")).toBe(false);
    const legacy = new InputChannel();
    legacy.push("task");
    legacy.settle({}); // CLIs that echo no uuids end once nothing is queued
    expect(legacy.push("late")).toBe(false);
  });

  it("delivers control-socket steering to the running session and lets the last result decide", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-steer-"));
    const socket = join(dir, "c.sock");
    const steer = (line: string) => new Promise<void>((resolve, reject) => {
      const conn = connect(socket, () => conn.end(line, () => resolve()));
      conn.on("error", reject);
    });
    const seen: any[] = [];
    const close = vi.fn();
    const query = vi.fn(({ prompt }) => ({ close, async *[Symbol.asyncIterator]() {
      let turn = 0;
      for await (const message of prompt) {
        seen.push(message);
        turn++;
        if (turn === 1) {
          await steer('not json\n{"type":"steer","message":""}\n{"type":"steer","message":"also check b.ts"}\n');
          await new Promise(resolve => setTimeout(resolve, 50)); // let the socket server read the line
        }
        yield assistant(`a${turn}`, `m${turn}`, [{ type: "text", text: `reply ${turn}` }]);
        yield turn === 1
          ? { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], uuid: `r${turn}`, user_message_uuids: [message.uuid] }
          : { ...success, result: `reply ${turn}`, uuid: `r${turn}`, user_message_uuids: [message.uuid] };
      }
    } })) as unknown as QueryFactory;
    try {
      const events: RunnerEvent[] = [];
      expect(await runClaude({ ...config, controlSocket: socket }, query, e => events.push(e))).toBe(0);
      expect(seen.map(m => [m.message.content, m.priority])).toEqual([["inspect", undefined], ["also check b.ts", "next"]]);
      expect(events.at(-1)).toEqual({ type: "claude_run_result", status: "completed" });
      await expect(steer('{"type":"steer","message":"too late"}\n')).rejects.toThrow(); // socket closed with the run
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("explains a failed result instead of a generic SDK failure", async () => {
    const events: RunnerEvent[] = [];
    const limit = { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Claude AI usage limit reached"], uuid: "r" };
    expect(await runClaude(config, fakeQuery([limit]).query, e => events.push(e))).toBe(1);
    expect(events.at(-1)).toEqual({ type: "claude_run_result", status: "failed",
      errorMessage: "Claude run failed (error_during_execution): Claude AI usage limit reached" });
    const invalid: RunnerEvent[] = [];
    expect(await runClaude({ ...config, effort: "huge" as any }, fakeQuery([success]).query, e => invalid.push(e))).toBe(1);
    expect(invalid.at(-1)).toMatchObject({ errorMessage: "Unsupported Claude effort" });
  });

  it("listens with the same line protocol as control-ext.js", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-socket-"));
    const channel = new InputChannel();
    const server = listenForSteering(join(dir, "s.sock"), channel);
    const push = vi.spyOn(channel, "push");
    try {
      await new Promise<void>(resolve => server.once("listening", () => resolve()));
      await new Promise<void>(resolve => { const c = connect(join(dir, "s.sock"), () => c.end('{"type":"followUp","message":"after"}\n{"type":"ste', () => resolve())); });
      await vi.waitFor(() => expect(push).toHaveBeenCalledWith("after", "later"));
      expect(push).toHaveBeenCalledOnce();
    } finally { server.close(); channel.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("echoes a taken steer after the tool results, so hosts show it delivered in place", async () => {
    const entries: any[] = [];
    const journal = new TranscriptJournal((customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }), () => {});
    journal.start({ id: "1", agent: "claude-worker", task: "inspect", startedAt: 1, backend: "claude", canSteer: true });
    const dir = mkdtempSync(join(tmpdir(), "claude-echo-"));
    const socket = join(dir, "c.sock");
    const query = (({ prompt }: any) => ({ close() {}, async *[Symbol.asyncIterator]() {
      const input = prompt[Symbol.asyncIterator]();
      const task = (await input.next()).value;
      yield { type: "stream_event", uuid: "s1", event: { type: "message_start", message: { id: "m1", model: "fixture" } } };
      // The person steers while the tool call is still streaming.
      journal.steer("1", "also check b.ts", "user");
      await new Promise<void>(resolve => { const c = connect(socket, () => c.end('{"type":"steer","message":"also check b.ts"}\n', () => resolve())); });
      const steer = (await input.next()).value;
      yield assistant("a1", "m1", [{ type: "tool_use", id: "call", name: "Read", input: { file_path: "a.ts" } }]);
      yield { type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "call", content: "source" }] } };
      yield assistant("a2", "m2", [{ type: "text", text: "checked a.ts and b.ts" }]);
      yield { ...success, result: "checked a.ts and b.ts", user_message_uuids: [task.uuid, steer.uuid] };
    } })) as unknown as QueryFactory;
    try {
      expect(await runClaude({ ...config, controlSocket: socket }, query, event => journal.event("1", event))).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    journal.finish("1", "completed", { endedAt: 10 });
    const id = projectSubagents("parent", entries).runs[0]!.id;
    const c = projectSubagents("parent", entries, undefined, id).conversation!;
    expect(c.inputs.map(i => [i.kind, i.text, i.delivery])).toEqual([["initial", "inspect", "delivered"], ["steer", "also check b.ts", "delivered"]]);
    const order = c.timeline.map(i => i.kind === "message" ? `${i.role}:${i.text}` : i.kind);
    expect(order).toEqual(["user:Task: inspect", "tool", "user:also check b.ts", "assistant:checked a.ts and b.ts"]);
  });

  it("shares Pi skills as a pi: plugin of symlinks, adds the Skill tool, and removes only the links", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-skills-"));
    try {
      mkdirSync(join(dir, "dws", "scripts"), { recursive: true });
      writeFileSync(join(dir, "dws", "SKILL.md"), "---\nname: dws\n---\nUse the CLI.");
      writeFileSync(join(dir, "dws", "scripts", "run.sh"), "echo hi");
      writeFileSync(join(dir, "note.md"), "---\nname: note\n---\nSingle file.");
      const root = writeSkillPlugin([{ name: "dws", path: join(dir, "dws", "SKILL.md") }, { name: "note", path: join(dir, "note.md") },
        { name: "../escape", path: join(dir, "note.md") }, { name: "relative", path: "note.md" }])!;
      expect(JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("pi");
      expect(readFileSync(join(root, "skills", "dws", "scripts", "run.sh"), "utf8")).toBe("echo hi"); // whole dir linked
      expect(readFileSync(join(root, "skills", "note", "SKILL.md"), "utf8")).toContain("Single file.");
      expect(readdirSync(join(root, "skills")).sort()).toEqual(["dws", "note"]);
      const options = queryOptions({ ...config, tools: ["Read", "Bash"] }, new AbortController(), {}, root);
      expect(options).toMatchObject({ tools: ["Read", "Bash", "Skill"], plugins: [{ type: "local", path: root, skipMcpDiscovery: true }] });
      expect(queryOptions({ ...config, tools: [] }, new AbortController(), {}).tools).toEqual([]);
      expect(writeSkillPlugin([])).toBeUndefined();
      // runClaude cleans the plugin up; the skill itself survives.
      let seen: string | undefined;
      const query = vi.fn(({ options }) => { seen = (options.plugins as any)[0].path; return fakeQuery([success]).query({} as any); }) as unknown as QueryFactory;
      expect(await runClaude({ ...config, skills: [{ name: "dws", path: join(dir, "dws", "SKILL.md") }] }, query, () => {})).toBe(0);
      expect(existsSync(seen!)).toBe(false);
      expect(existsSync(join(dir, "dws", "scripts", "run.sh"))).toBe(true);
      rmSync(root, { recursive: true, force: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

