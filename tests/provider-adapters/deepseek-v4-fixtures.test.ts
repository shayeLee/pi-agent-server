import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const fixtureDir = new URL("./fixtures/deepseek-v4/", import.meta.url);

type Fixture = {
  source: string;
  provider: string;
  modelId: string;
  expected: Record<string, unknown>;
};

type ToolMatrix = {
  source: string;
  scenarios: Array<{
    provider: string;
    modelId: string;
    availableTools: string[];
    request: string;
    expected: { kind: "text_refusal" | "native_tool_call"; tool?: string; mentionsUnavailable?: string };
  }>;
};

describe("DeepSeek V4 protocol fixtures", () => {
  it("覆盖直连 DeepSeek 与 OpenCode-Go 的 Flash/Pro 无工具场景", () => {
    const fixtures = readdirSync(fixtureDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) =>
        JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8")) as Fixture,
      );

    expect(fixtures.map((fixture) => `${fixture.provider}/${fixture.modelId}`)).toEqual(
      expect.arrayContaining([
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-pro",
        "opencode-go/deepseek-v4-flash",
        "opencode-go/deepseek-v4-pro",
      ]),
    );
    for (const fixture of fixtures) {
      expect(fixture.source).toContain("Sanitized");
      expect(fixture.expected).not.toEqual({});
    }
  });

  it("覆盖有限工具集中的未授权请求与授权原生调用", () => {
    const matrix = JSON.parse(readFileSync(new URL("./fixtures/deepseek-v4/tool-matrix.json", import.meta.url), "utf8")) as ToolMatrix;
    const modelKeys = [
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "opencode-go/deepseek-v4-flash",
      "opencode-go/deepseek-v4-pro",
    ];

    expect(matrix.source).toContain("Sanitized");
    for (const key of modelKeys) {
      const [provider, modelId] = key.split("/");
      expect(
        matrix.scenarios.some(
          (scenario) =>
            scenario.provider === provider &&
            scenario.modelId === modelId &&
            scenario.availableTools.join(",") === "read" &&
            scenario.request === "bash pwd" &&
            scenario.expected.kind === "text_refusal",
        ),
      ).toBe(true);
      expect(
        matrix.scenarios.some(
          (scenario) =>
            scenario.provider === provider &&
            scenario.modelId === modelId &&
            scenario.expected.kind === "native_tool_call" &&
            scenario.expected.tool === "read",
        ),
      ).toBe(true);
    }
  });
});
