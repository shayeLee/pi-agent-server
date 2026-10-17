// Real SDK session with the host's MCP wiring: catalog → project settings → stdio transport →
// MCP + codemode extensions. An offline faux model asks codemode to call the fixture's tool.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createMcpToolBoundaryExtension } from "../../src/agent/mcp-tool-boundary.js";
import { resolveSdkToolConfig } from "../../src/agent/tool-selection.js";
import { translateSdkEvent } from "../../src/agent/translate.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";
import { createMcpHost } from "../../src/mcp/host.js";
import { effectiveMcpServerEntries } from "../../src/mcp/project-settings.js";
import { loadSessionResourceLoader } from "../../src/server/provider-extensions.js";

const FIXTURE = resolve("tests/fixtures/mcp-stdio-server.mjs");
// MCP results without an output schema resolve to the tool result object.
const SCRIPT = "const r = await tools.mcp__fixture__whoami({});\nreturn r.content[0].text;";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-mcp-session-"));
  process.env.PI_MCP_TEST_SENTINEL = "service-only";
});
afterEach(() => {
  delete process.env.PI_MCP_TEST_SENTINEL;
  rmSync(root, { recursive: true, force: true });
});

async function runSession(tools: readonly string[] | undefined) {
  const catalogFile = join(root, "catalog.json");
  const secretsFile = join(root, "secrets.json");
  writeFileSync(secretsFile, JSON.stringify({ FIXTURE_TOKEN: "from-secrets" }));
  chmodSync(secretsFile, 0o600);
  writeFileSync(catalogFile, JSON.stringify({ version: 1, servers: { fixture: {
    command: process.execPath, args: [FIXTURE, "${PROJECT_CWD}"], env: { FIXTURE_TOKEN: "${secret:FIXTURE_TOKEN}" }, description: "Test fixture",
  } } }));
  const host = createMcpHost({ catalogFile, secretsFile, logPath: join(root, "mcp.log"), maxStdioProcesses: 2 });
  const entries = effectiveMcpServerEntries(host.catalog, [{ serverName: "fixture", enabled: true, exposure: null, hiddenTools: [], updatedAt: 1, updatedBy: "ip:1" }]);

  const faux = createFauxCore({ provider: "faux-mcp", models: [{ id: "m", name: "offline", reasoning: false, contextWindow: 8192, maxTokens: 512 }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: SCRIPT }, { id: "call-1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const loader = await loadSessionResourceLoader(runtime, {
    extensionCwd: root, agentDir: root,
    extensionFactories: [
      pi => pi.registerProvider("faux-mcp", { api: faux.api, baseUrl: "http://127.0.0.1:1", apiKey: "offline", models: faux.models, streamSimple: faux.streamSimple }),
      ...(tools ? [createMcpToolBoundaryExtension(tools)] : []),
      ...host.sessionExtensions(entries),
    ],
  });
  const { session } = await createAgentSession({
    cwd: root, agentDir: root, resourceLoader: loader, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(root),
    model: runtime.getModel("faux-mcp", "m")!,
    ...resolveSdkToolConfig(tools ? { tools } : {}, undefined),
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe(event => { events.push(event); });
  try {
    await session.bindExtensions({ mode: "json" });
    await session.prompt("go");
    await session.waitForIdle();
    const result = session.messages.find(message => message.role === "toolResult" && message.toolCallId === "call-1");
    const text = result && "content" in result && Array.isArray(result.content)
      ? result.content.map(block => (block.type === "text" ? block.text : "")).join("")
      : "";
    return { text, isError: result && "isError" in result ? result.isError : undefined, events, host };
  } finally {
    session.dispose();
  }
}

it("runs a codemode script that calls an MCP tool with catalog secrets and a minimal environment", async () => {
  const { text, isError, events, host } = await runSession(undefined);
  expect(isError).toBe(false);
  expect(text).toContain('"token":"from-secrets"');
  expect(text).toContain('"leaked":null');
  expect(text).toContain(`"arg":${JSON.stringify(root)}`);
  // Nested calls reach SSE with their parent id.
  const nested = events.map(event => translateSdkEvent(event as AgentSdkEvent))
    .filter(event => event?.type === "tool_start" && event.toolName === "mcp__fixture__whoami");
  expect(nested).toEqual([expect.objectContaining({ parentToolCallId: "call-1" })]);
  expect(host.gate.running).toBe(0);
}, 30_000);

it("keeps MCP tools out of reach from codemode when the allowlist has no mcp__ entry", async () => {
  const { text, isError } = await runSession(["codemode"]);
  expect(isError).toBe(true);
  expect(text).not.toContain("from-secrets");
}, 30_000);
