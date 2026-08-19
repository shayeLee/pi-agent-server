import { describe, expect, it } from "vitest";
import { toolPolicyFromAllowlist } from "../../src/application/ports/index.js";

describe("工具授权策略", () => {
  it("未提供工具时默认只读工具集 read/ls/find/grep", () => {
    expect(toolPolicyFromAllowlist().resolve()).toEqual({
      kind: "allowlist",
      tools: ["read", "ls", "find", "grep"],
    });
  });

  it("显式空列表时禁用全部内置工具", () => {
    expect(toolPolicyFromAllowlist([]).resolve()).toEqual({ kind: "disabled" });
  });

  it("显式工具列表时返回白名单", () => {
    expect(toolPolicyFromAllowlist(["read"]).resolve()).toEqual({
      kind: "allowlist",
      tools: ["read"],
    });
  });
});
