import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DeepSeekV4DsmlTextToolParser } from "../../src/provider-adapters/deepseek-v4/dsml-text-tool-parser.js";

type Fixture = {
  chunks: string[];
  expected: { name: string; arguments: Record<string, string> };
};

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/deepseek-v4/opencode-flash-free-dsml.json", import.meta.url), "utf8"),
) as Fixture;

function parse(chunks: string[]) {
  const parser = new DeepSeekV4DsmlTextToolParser();
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.finish()];
}

describe("DeepSeekV4DsmlTextToolParser", () => {
  it("解析实际 opencode Flash Free DSML 帧", () => {
    const raw = fixture.chunks.join("");
    expect(parse(fixture.chunks)).toEqual([
      { type: "tool_call", name: fixture.expected.name, arguments: fixture.expected.arguments, raw },
    ]);
  });

  it("支持任意字符边界切分", () => {
    const raw = fixture.chunks.join("");
    for (let split = 1; split < raw.length; split++) {
      expect(parse([raw.slice(0, split), raw.slice(split)])).toEqual([
        { type: "tool_call", name: "bash", arguments: fixture.expected.arguments, raw },
      ]);
    }
  });

  it("拒绝不完整和重复参数帧", () => {
    expect(parse([fixture.chunks[0]!])).toEqual([{ type: "protocol_error", code: "incomplete_tool_markup" }]);
    expect(
      parse([
        '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="bash"><｜｜DSML｜｜parameter name="command">a</｜｜DSML｜｜parameter><｜｜DSML｜｜parameter name="command">b</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>',
      ]),
    ).toEqual([{ type: "protocol_error", code: "malformed_tool_markup" }]);
  });
});
