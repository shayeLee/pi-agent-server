import { describe, expect, it } from "vitest";
import { toolPolicyFromAllowlist } from "../../src/application/ports/index.js";

describe("工具授权策略", () => {
  it("未提供工具时明确允许全部工具（不是空白名单）", () => {
    expect(toolPolicyFromAllowlist().resolve()).toEqual({ kind: "all" });
  });

  it("显式空列表时禁用全部工具", () => {
    expect(toolPolicyFromAllowlist([]).resolve()).toEqual({ kind: "disabled" });
  });

  it("显式工具列表时返回白名单", () => {
    expect(toolPolicyFromAllowlist(["read"]).resolve()).toEqual({
      kind: "allowlist",
      tools: ["read"],
    });
  });
});
