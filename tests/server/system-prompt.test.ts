import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { PiAgentAdapter, type AgentSessionLike } from "../../src/agent/pi-agent-adapter.js";
import { projectSystemPrompt } from "../../src/shared/system-prompt.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../helpers/ip-access.js";
import { identityKey } from "../../src/core/user-identity.js";
import { DEFAULT_PROJECT_ID } from "../../src/shared/project-identity.js";
import type { NativeSessionPort } from "../../src/application/ports/native-session-port.js";

const OWNER = "10.0.0.1";
async function fixture(prompt: string | null = "creation", nativeSessions?: NativeSessionPort, shared = false, historical = false) {
  const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/prompt-test" });
  await sessions.create({ id: "prompt-session", ownerKey: identityKey({ kind: "ip", ip: OWNER }),
    projectId: DEFAULT_PROJECT_ID, title: "prompt", createdAt: 1, updatedAt: 1,
    agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: historical ? "/not-client-supplied/old.jsonl" : null,
    modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: prompt, capabilityVersions: null,
    ...(shared ? { origin: "native" as const, visibility: "shared" as const } : {}) });
  let live: string | null = "dynamic";
  const adapter = new MockAgentAdapter();
  const read = vi.fn(() => live);
  Object.assign(adapter, { getEffectiveSystemPrompt: read });
  const createAdapter = vi.fn(async () => adapter);
  const app = buildApp({ sessions, projects, defaultProjectCwd: "/tmp/prompt-test", nativeSessions, createAdapter,
    ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: "10.0.0.3", role: "viewer" }, { ip: "10.0.0.4", role: "operator" }]) }) });
  const get = (ip = OWNER, id = "prompt-session") => app.inject({ method: "GET", url: `/v1/sessions/${id}/system-prompt`, remoteAddress: ip });
  const activate = () => app.inject({ method: "POST", url: "/v1/sessions/prompt-session/messages", remoteAddress: OWNER,
    payload: { requestId: "read-prompt", prompt: "go" } });
  return { app, sessions, get, activate, createAdapter, read, setLive: (value: string | null) => { live = value; } };
}

describe("read-only system prompt", () => {
  it("reports provenance and preserves null/empty/full strings without fabricated last_sent", () => {
    expect(projectSystemPrompt("", "creation")).toEqual({ source: "live_effective", prompt: "" });
    expect(projectSystemPrompt(null, "")).toEqual({ source: "creation_snapshot", prompt: "" });
    expect(projectSystemPrompt(undefined, null)).toEqual({ source: "unavailable", prompt: null });
    const full = "a".repeat(300_000);
    expect(projectSystemPrompt(full, null).prompt).toBe(full);
  });
  it.each(["creation", "", null])("never creates a runtime for snapshot %j", async prompt => {
    const f = await fixture(prompt);
    try {
      expect((await f.get()).json()).toEqual(projectSystemPrompt(null, prompt));
      expect(f.createAdapter).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it("labels unproven historical data as creation snapshot, without opening its source", async () => {
    const f = await fixture("historical creation", undefined, false, true);
    try {
      expect((await f.get()).json()).toEqual({ source: "creation_snapshot", prompt: "historical creation" });
      expect(f.createAdapter).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it("reads dynamic effective values on each request rather than freezing the creation prompt", async () => {
    const f = await fixture();
    try {
      await f.activate();
      expect((await f.get()).json()).toEqual({ source: "live_effective", prompt: "dynamic" });
      f.setLive("");
      expect((await f.get()).json()).toEqual({ source: "live_effective", prompt: "" });
      f.setLive(null);
      expect((await f.get()).json()).toEqual({ source: "creation_snapshot", prompt: "creation" });
      expect(f.createAdapter).toHaveBeenCalledTimes(1);
    } finally { await f.app.close(); }
  });
  it("uses the SDK public getter, with no model probing or private state", () => {
    let prompt = "extension value";
    const sdk = { get systemPrompt() { return prompt; }, subscribe: () => () => {}, dispose: () => {} } as unknown as AgentSessionLike;
    const adapter = new PiAgentAdapter(sdk);
    expect(adapter.getEffectiveSystemPrompt()).toBe("extension value");
    prompt = "";
    expect(adapter.getEffectiveSystemPrompt()).toBe("");
    adapter.dispose();
  });
  it("same 404 for missing and another owner; operator denied before any read", async () => {
    const f = await fixture();
    try {
      const missing = await f.get(OWNER, "missing");
      const denied = await f.get("10.0.0.2");
      expect(missing.statusCode).toBe(404);
      expect(denied.statusCode).toBe(404);
      expect(denied.body).toBe(missing.body);
      expect((await f.get("10.0.0.4")).statusCode).toBe(403);
      expect(f.createAdapter).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it("rejects a claimed source revoked during async guard preparation", async () => {
    let allowed = true;
    let revoke = true;
    const native: NativeSessionPort = {
      discover: async () => [], allows: async () => allowed, hasSourceClaim: async () => true,
      cwdIdentity: async () => null,
      outputGuard: async () => { await Promise.resolve(); if (revoke) allowed = false; return () => allowed; },
    };
    const f = await fixture("source snapshot", native);
    try {
      expect((await f.get()).statusCode).toBe(404);
      expect(f.read).not.toHaveBeenCalled();
      allowed = true; revoke = false;
      expect((await f.get()).json()).toEqual({ source: "creation_snapshot", prompt: "source snapshot" });
      allowed = false;
      expect((await f.get()).statusCode).toBe(404);
      expect(f.createAdapter).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it("rechecks deletion during asynchronous permission preparation", async () => {
    let remove: () => Promise<unknown> = async () => {};
    const native: NativeSessionPort = { discover: async () => [], allows: async () => true,
      hasSourceClaim: async () => true, cwdIdentity: async () => null,
      outputGuard: async () => { await remove(); return () => true; } };
    const f = await fixture("deleted snapshot", native);
    remove = () => f.sessions.delete("prompt-session");
    try {
      expect((await f.get()).statusCode).toBe(404);
      expect(f.read).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it("allows viewer on a native shared source only while authorized", async () => {
    let allowed = true;
    const native: NativeSessionPort = { discover: async () => [], allows: async () => allowed,
      cwdIdentity: async () => null, outputGuard: async () => () => allowed };
    const f = await fixture("shared prompt", native, true);
    try {
      expect((await f.get("10.0.0.3")).json()).toEqual({ source: "creation_snapshot", prompt: "shared prompt" });
      allowed = false;
      expect((await f.get("10.0.0.3")).statusCode).toBe(404);
      expect(f.createAdapter).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it("rejects source revocation during synchronous live read without falling back", async () => {
    let allowed = true;
    const native: NativeSessionPort = { discover: async () => [], allows: async () => allowed,
      hasSourceClaim: async () => true, cwdIdentity: async () => null, outputGuard: async () => () => allowed };
    const f = await fixture("secret snapshot", native);
    try {
      await f.activate();
      f.read.mockImplementation(() => { allowed = false; return "secret effective"; });
      const response = await f.get();
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("secret");
    } finally { await f.app.close(); }
  });
});
