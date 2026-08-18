import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DeepSeekV4TextToolParser } from "../../src/provider-adapters/deepseek-v4/text-tool-parser.js";

type Fixture = {
  chunks: string[];
  expected: { toolCalls: Array<{ name: string; arguments: Record<string, string> }>; text: string };
};

const observedUseToolFixture = JSON.parse(
  readFileSync(new URL("./fixtures/deepseek-v4/use-tool-bash.json", import.meta.url), "utf8"),
) as Fixture;

function parse(chunks: string[]) {
  const parser = new DeepSeekV4TextToolParser();
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.finish()];
}

describe("DeepSeekV4TextToolParser", () => {
  it("解析真实会话中观察到的 <use_tool> 标记，且支持跨 chunk", () => {
    const events = parse(observedUseToolFixture.chunks);
    expect(events).toEqual([
      {
        type: "tool_call",
        name: observedUseToolFixture.expected.toolCalls[0]?.name,
        arguments: observedUseToolFixture.expected.toolCalls[0]?.arguments,
        raw: observedUseToolFixture.chunks.join(""),
      },
    ]);
  });

  it("任意字符切分都得到相同调用，不泄露工具标记为 text", () => {
    const full = observedUseToolFixture.chunks.join("");
    for (let split = 1; split < full.length; split++) {
      expect(parse([full.slice(0, split), full.slice(split)])).toEqual([
        {
          type: "tool_call",
          name: "bash",
          arguments: { command: "ls -al" },
          raw: observedUseToolFixture.chunks.join(""),
        },
      ]);
    }
  });

  it("保留工具调用前后的普通文本", () => {
    expect(
      parse([
        '执行：<use_tool name="read"><param name="path">a&amp;b.txt</param></use_tool>完成。',
      ]),
    ).toEqual([
      { type: "text", text: "执行：" },
      {
        type: "tool_call",
        name: "read",
        arguments: { path: "a&b.txt" },
        raw: '<use_tool name="read"><param name="path">a&amp;b.txt</param></use_tool>',
      },
      { type: "text", text: "完成。" },
    ]);
  });

  it("拒绝重复参数和不完整标记，且不把原始标记输出为文本", () => {
    expect(
      parse([
        '<use_tool name="bash"><param name="command">a</param><param name="command">b</param></use_tool>',
      ]),
    ).toEqual([{ type: "protocol_error", code: "malformed_tool_markup" }]);
    expect(parse(['<use_tool name="bash"><param name="command">ls'])).toEqual([
      { type: "protocol_error", code: "incomplete_tool_markup" },
    ]);
  });
});
