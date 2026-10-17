// Real SDK regression: isolated resources/credentials, no model requests or business storage.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { resolveSdkToolConfig } from "../../src/agent/tool-selection.js";

function tool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name, label: name, description: "Offline fixture",
    parameters: { type: "object", properties: {} } as ToolDefinition["parameters"],
    execute: async () => ({ content: [], details: undefined }), ...extra,
  };
}

it.each([{ defaultTools: undefined }, { defaultTools: ["read", "grep"] }, { defaultTools: [] }])("default snapshot $defaultTools preserves extension/custom registration, exposure and dynamic activation", async ({ defaultTools }) => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-sdk-"));
  const settings = SettingsManager.inMemory(defaultTools === undefined ? {} : { defaultTools });
  let api: ExtensionAPI | undefined;
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => {
      api = pi;
      pi.registerTool(tool("initial_extension"));
      pi.registerTool(tool("inactive_extension", { defaultActive: false }));
      pi.on("session_start", () => {
        pi.registerTool(tool("late_extension"));
        // Same public exposure mechanism used by MCP, without connecting a server.
        for (const exposure of ["direct", "codemode", "deferred", "hidden"] as const) {
          pi.registerTool(tool(`mcp__fixture__${exposure}`, { exposure }));
        }
      });
    }],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    ({ session } = await createAgentSession({
      cwd: root, agentDir: root, resourceLoader: loader, modelRuntime: runtime,
      settingsManager: settings, sessionManager: SessionManager.inMemory(root),
      ...resolveSdkToolConfig({}, settings.getDefaultTools()), customTools: [tool("custom_tool")],
    }));
    const defaults = defaultTools ?? ["read", "bash", "edit", "write"];
    expect(session.getActiveToolNames()).toEqual([...defaults, "initial_extension", "custom_tool"]);
    await session.bindExtensions({ mode: "json" });
    expect(session.getActiveToolNames()).toEqual([...defaults, "initial_extension", "custom_tool", "late_extension", "mcp__fixture__direct"]);
    expect(session.getAllTools()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "mcp__fixture__codemode", exposure: "codemode" }),
      expect.objectContaining({ name: "mcp__fixture__deferred", exposure: "deferred" }),
      expect.objectContaining({ name: "mcp__fixture__hidden", exposure: "hidden" }),
    ]));
    api!.setActiveTools(["ls", "inactive_extension", "mcp__fixture__deferred", "mcp__fixture__codemode", "mcp__fixture__hidden"]);
    expect(session.getActiveToolNames()).toEqual(["ls", "inactive_extension", "mcp__fixture__deferred", "mcp__fixture__codemode"]);
    api!.registerTool(tool("runtime_extension"));
    expect(session.getActiveToolNames()).toContain("runtime_extension");

    // Deliberate host contract: defaults are a creation snapshot, not SDK reload increments.
    settings.applyOverrides({ defaultTools: ["+find"] });
    await session.reload();
    expect(session.getActiveToolNames()).not.toContain("find");
    expect(session.getActiveToolNames()).toContain("inactive_extension");
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { name: "historical read-only tools", history: ["read"] },
  { name: "historical empty tools", history: [] },
  { name: "historical old-plugin-only tools", history: ["old_plugin"] },
])("real SDK restores current defaults and registrations with $name", async ({ history }) => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-history-sdk-"));
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => pi.registerTool(tool("current_extension"))],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    const settings = SettingsManager.inMemory();
    const manager = SessionManager.inMemory(root);
    manager.appendMessage({
      role: "system", content: "historical tool snapshot",
      toolsAdded: history.map(name => ({ name, description: name, parameters: { type: "object", properties: {} } })),
      timestamp: 0,
    });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    ({ session } = await createAgentSession({
      cwd: root, agentDir: root, resourceLoader: loader, modelRuntime: runtime,
      settingsManager: settings, sessionManager: manager,
      ...resolveSdkToolConfig({}, undefined), customTools: [tool("current_custom")],
    }));
    expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "current_extension", "current_custom"]);
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a real SDK session constrained by an explicit whitelist despite historical tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-whitelist-sdk-"));
  const manager = SessionManager.inMemory(root);
  manager.appendMessage({
    role: "system", content: "historical tool snapshot",
    toolsAdded: ["bash", "old_plugin"].map(name => ({ name, description: name, parameters: { type: "object", properties: {} } })),
    timestamp: 0,
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const settings = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [pi => pi.registerTool(tool("current_extension"))],
    });
    await loader.reload();
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    ({ session } = await createAgentSession({
      cwd: root, agentDir: root, resourceLoader: loader, modelRuntime: runtime,
      settingsManager: settings, sessionManager: manager,
      ...resolveSdkToolConfig({ tools: ["read"] }, undefined), customTools: [tool("current_custom")],
    }));
    expect(session.getActiveToolNames()).toEqual(["read"]);
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { tools: [] }, { tools: ["read", "mcp__fixture__*"] }, { noTools: "all" as const }, { noTools: "builtin" as const },
])("preserves explicit host options unchanged: %j", config => {
  expect(resolveSdkToolConfig(config, ["bash"])).toEqual(config);
});

it("excludes MCP tools from an exact allowlist without mcp__ entries", () => {
  expect(resolveSdkToolConfig({ tools: ["read", "read_mcp_resource"] }, ["bash"])).toEqual({
    tools: ["read", "read_mcp_resource"],
    excludeTools: ["mcp__*", "list_mcp_resources", "list_mcp_resource_templates"],
  });
});

it.each([
  { name: "without mcp__ entries", tools: ["read", "codemode"], registered: [] },
  { name: "with an mcp__ entry", tools: ["read", "mcp__fixture__codemode"], registered: ["mcp__fixture__codemode"] },
])("real SDK allowlist $name keeps only authorized MCP tools registered", async ({ tools, registered }) => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-mcp-sdk-"));
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => {
      pi.on("session_start", () => {
        for (const exposure of ["direct", "codemode", "deferred", "hidden"] as const) {
          pi.registerTool(tool(`mcp__fixture__${exposure}`, { exposure }));
        }
        pi.registerTool(tool("list_mcp_resources", { exposure: "codemode" }));
      });
    }],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    ({ session } = await createAgentSession({
      cwd: root, agentDir: root, resourceLoader: loader, modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(root),
      ...resolveSdkToolConfig({ tools }, undefined),
    }));
    await session.bindExtensions({ mode: "json" });
    const mcpTools = session.getAllTools().map(entry => entry.name).filter(name => name.includes("mcp"));
    expect(mcpTools).toEqual(registered);
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
