import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createMcpToolBoundaryExtension, isMcpToolAuthorized, mcpExcludeTools } from "../../src/agent/mcp-tool-boundary.js";

describe("mcpExcludeTools", () => {
  it("excludes every MCP tool when the allowlist has no mcp__ entry", () => {
    expect(mcpExcludeTools(["read", "*"])).toEqual(["mcp__*", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
  });

  it("leaves filtering to the SDK when an mcp__ entry is present or tools are disabled", () => {
    expect(mcpExcludeTools(["mcp__github__*"])).toBeUndefined();
    expect(mcpExcludeTools([])).toBeUndefined();
  });
});

describe("isMcpToolAuthorized", () => {
  it.each([
    { tools: ["read"], name: "mcp__github__search", allowed: false },
    { tools: ["*"], name: "mcp__github__search", allowed: false },
    { tools: ["read"], name: "read", allowed: true },
    { tools: ["read_mcp_resource"], name: "read_mcp_resource", allowed: true },
    { tools: ["read"], name: "read_mcp_resource", allowed: false },
    { tools: ["mcp__github__*"], name: "mcp__github__search", allowed: true },
    { tools: ["mcp__github__*"], name: "mcp__jira__search", allowed: false },
    { tools: ["mcp__github__*"], name: "list_mcp_resources", allowed: false },
    { tools: [], name: "mcp__github__search", allowed: false },
  ])("$tools → $name: $allowed", ({ tools, name, allowed }) => {
    expect(isMcpToolAuthorized(tools, name)).toBe(allowed);
  });
});

describe("createMcpToolBoundaryExtension", () => {
  function hook(tools: string[]) {
    let handler: ((event: { toolName: string }) => unknown) | undefined;
    const pi = { on: (event: string, fn: typeof handler) => { if (event === "tool_call") handler = fn; } };
    createMcpToolBoundaryExtension(tools).factory(pi as unknown as ExtensionAPI);
    return handler!;
  }

  it("blocks unauthorized MCP calls, nested ones included", () => {
    const onToolCall = hook(["read", "codemode"]);
    expect(onToolCall({ toolName: "mcp__github__search", parentToolCallId: "call-1" } as { toolName: string })).toMatchObject({ block: true });
    expect(onToolCall({ toolName: "read" })).toBeUndefined();
  });

  it("lets authorized MCP calls through", () => {
    expect(hook(["mcp__github__*"])({ toolName: "mcp__github__search" })).toBeUndefined();
  });
});
