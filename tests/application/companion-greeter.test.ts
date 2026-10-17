import { describe, expect, it } from "vitest";
import { CompanionGreeter, CompanionGreetingError, greetingPrompt, parseGreeting, type CompanionGreetingInput } from "../../src/application/companion-greeter.js";

const input: CompanionGreetingInput = {
  ownerKey: "ip:10.0.0.1", projectId: "p1", projectName: "我的仓库",
  persona: { name: "小派", style: "lively" }, dayPart: "morning",
  recent: { title: "修复登录", minutesAgo: 5 },
  commands: [{ name: "review", description: "审查当前改动" }],
};
const reply = JSON.stringify({ greeting: "早呀！我的仓库今天也要加油～", hint: "接着修复登录吧" });

describe("companion greeting", () => {
  it("gives the model only the caller's facts and the persona", () => {
    const { systemPrompt, prompt } = greetingPrompt(input);
    expect(systemPrompt).toContain("小派");
    expect(prompt).toContain("我的仓库");
    expect(prompt).toContain("修复登录");
    expect(prompt).toContain("/review（审查当前改动）");
  });

  it("accepts the JSON object, even fenced, and rejects anything unusable", () => {
    expect(parseGreeting("```json\n" + reply + "\n```")).toEqual({ greeting: "早呀！我的仓库今天也要加油～", hint: "接着修复登录吧" });
    expect(parseGreeting(JSON.stringify({ greeting: "“你好”", hint: "试试 `/review`" }))).toEqual({ greeting: "你好", hint: "试试 /review" });
    for (const text of ["你好", "{}", JSON.stringify({ greeting: "x".repeat(41), hint: "y" }), JSON.stringify({ greeting: "<b>hi</b>", hint: "y" })]) {
      expect(() => parseGreeting(text)).toThrow(CompanionGreetingError);
    }
  });

  it("asks once per context: concurrent callers share a request and repeats hit the cache until it expires", async () => {
    let calls = 0;
    let clock = 0;
    const greeter = new CompanionGreeter({ complete: async () => { calls += 1; return reply; }, ttlMs: 1000, now: () => clock });
    await Promise.all([greeter.greet(input), greeter.greet(input)]);
    await greeter.greet({ ...input, recent: { title: "修复登录", minutesAgo: 30 } });
    expect(calls).toBe(1);
    await greeter.greet({ ...input, persona: { name: "小派", style: "formal" } });
    expect(calls).toBe(2);
    clock = 1001;
    await greeter.greet(input);
    expect(calls).toBe(3);
  });

  it("does not cache failures", async () => {
    let fail = true;
    const greeter = new CompanionGreeter({ complete: async () => { if (fail) throw new Error("down"); return reply; } });
    await expect(greeter.greet(input)).rejects.toThrow("down");
    fail = false;
    await expect(greeter.greet(input)).resolves.toMatchObject({ hint: "接着修复登录吧" });
  });
});
