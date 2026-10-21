import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../helpers/ip-access.js";
import { identityKey } from "../../src/core/user-identity.js";
import { DEFAULT_PROJECT_ID } from "../../src/shared/project-identity.js";
import { ConversationStorageRegistry } from "../../src/application/ports/conversation-port.js";
import type { NativeSessionPort } from "../../src/application/ports/native-session-port.js";
import type { SubagentSnapshot } from "../../src/shared/subagents.js";
const OWNER = "10.0.0.1";
const snapshot = (tag: string): SubagentSnapshot => ({ sessionId: "steps", runs: [{ id: tag, runId: "1", agent: "worker", task: tag, startedAt: 1, status: "completed", revision: 1 }] });
async function fixture(nativeSessions?: NativeSessionPort, shared = false) {
  const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/steps-server-test" });
  await sessions.create({ id: "steps", ownerKey: identityKey({ kind: "ip", ip: OWNER }), projectId: DEFAULT_PROJECT_ID, title: "steps", createdAt: 1, updatedAt: 1, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: "creation", capabilityVersions: null, ...(shared ? { origin: "native" as const, visibility: "shared" as const } : {}) });
  const adapter = new MockAgentAdapter();
  const live = vi.fn(() => snapshot("live"));
  const steer = vi.fn(async (): Promise<import("../../src/shared/subagents.js").SubagentSteerAck> => ({ ok: true }));
  Object.assign(adapter, { getSubagents: live, steerSubagent: steer });
  const createAdapter = vi.fn(async () => adapter);
  const readSubagents = vi.fn(async () => snapshot("cold"));
  const storage = new ConversationStorageRegistry();
  storage.register({ agentKind: "pi", conversationFormat: "pi-jsonl-v3", readSubagents, readExport: async () => { throw new Error("steps must not use chat timeline"); }, planCleanup: () => null });
  const app = buildApp({ sessions, projects, conversationStorage: storage, nativeSessions, defaultProjectCwd: "/tmp/steps-server-test", createAdapter, ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: "10.0.0.3", role: "viewer" }, { ip: "10.0.0.4", role: "operator" }]) }) });
  const get = (ip = OWNER, id = "steps") => app.inject({ method: "GET", url: `/v1/sessions/${id}/subagents`, remoteAddress: ip });
  const activate = () => app.inject({ method: "POST", url: "/v1/sessions/steps/messages", remoteAddress: OWNER, payload: { requestId: "activate", prompt: "offline" } });
  const postSteer = (payload: unknown, ip = OWNER, id = "steps") => app.inject({ method: "POST", url: `/v1/sessions/${id}/subagents/child/steer`, remoteAddress: ip, payload: payload as object });
  return { app, sessions, live, steer, readSubagents, createAdapter, get, activate, postSteer };
}
describe("GET subagent authorization/read-only", () => {
  it("returns cold projection without creating runtime; missing/other owner indistinguishable and operator denied", async () => {
    const f = await fixture();
    try {
      expect((await f.get()).json()).toEqual(snapshot("cold"));
      expect(f.createAdapter).not.toHaveBeenCalled();
      expect(f.live).not.toHaveBeenCalled();
      const missing = await f.get(OWNER, "missing"), denied = await f.get("10.0.0.2");
      expect(missing.statusCode).toBe(404); expect(denied.statusCode).toBe(404); expect(denied.body).toBe(missing.body);
      expect((await f.get("10.0.0.4")).statusCode).toBe(403);
      expect(f.readSubagents).toHaveBeenCalledTimes(1);
    } finally { await f.app.close(); }
  });
  it("prefers live even if runtime appears while cold read is awaiting", async () => {
    const f = await fixture();
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    f.readSubagents.mockImplementation(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return snapshot("cold"); });
    try {
      const response = f.get();
      await entered;
      await f.activate(); release();
      expect((await response).json()).toEqual(snapshot("live"));
      expect((await f.get()).json()).toEqual(snapshot("live"));
      expect(f.readSubagents).toHaveBeenCalledTimes(1);
      expect(f.createAdapter).toHaveBeenCalledTimes(1);
    } finally { release?.(); await f.app.close(); }
  });
  it("native shared viewer requires current source capability and rejects revocation during cold read", async () => {
    let allowed = true;
    const native: NativeSessionPort = { discover: async () => [], allows: async () => allowed, cwdIdentity: async () => null, outputGuard: async () => () => allowed };
    const f = await fixture(native, true);
    try {
      expect((await f.get("10.0.0.3")).statusCode).toBe(200);
      f.readSubagents.mockImplementation(async () => { await Promise.resolve(); allowed = false; return snapshot("secret"); });
      const response = await f.get("10.0.0.3");
      expect(response.statusCode).toBe(404); expect(response.body).not.toContain("secret");
      expect(f.createAdapter).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it("rechecks ownership after cold await and source capability after synchronous live read", async () => {
    let allowed = true;
    const native: NativeSessionPort = { discover: async () => [], allows: async () => allowed, hasSourceClaim: async () => true, cwdIdentity: async () => null, outputGuard: async () => () => allowed };
    const f = await fixture(native);
    try {
      await f.activate();
      f.live.mockImplementation(() => { allowed = false; return snapshot("secret"); });
      expect((await f.get()).statusCode).toBe(404);
    } finally { await f.app.close(); }
    const cold = await fixture();
    try {
      cold.readSubagents.mockImplementation(async () => { await cold.sessions.delete("steps"); return snapshot("secret"); });
      expect((await cold.get()).statusCode).toBe(404);
      expect(cold.createAdapter).not.toHaveBeenCalled();
    } finally { await cold.app.close(); }
  });
});
describe("POST subagent steer", () => {
  it("hands a person's steer to the live runtime; 202 is admission, not delivery", async () => {
    const f = await fixture();
    try {
      await f.activate();
      const response = await f.postSteer({ text: "只检查侧栏" });
      expect(response.statusCode).toBe(202); expect(response.body).toBe("");
      expect(f.steer).toHaveBeenCalledWith("child", "只检查侧栏");
    } finally { await f.app.close(); }
  });
  it("never creates a runtime: a cold session has no running child to steer", async () => {
    const f = await fixture();
    try {
      const response = await f.postSteer({ text: "只检查侧栏" });
      expect(response.statusCode).toBe(409); expect(response.json().code).toBe("SUBAGENT_STEER_UNAVAILABLE");
      expect(f.createAdapter).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it("maps each refusal to a stable code", async () => {
    const f = await fixture();
    try {
      await f.activate();
      for (const [reason, status, code] of [["not-found", 409, "SUBAGENT_NOT_RUNNING"], ["not-running", 409, "SUBAGENT_NOT_RUNNING"],
        ["no-channel", 409, "SUBAGENT_STEER_UNAVAILABLE"], ["failed", 409, "SUBAGENT_STEER_FAILED"], ["invalid", 400, undefined]] as const) {
        f.steer.mockResolvedValueOnce({ ok: false, reason });
        const response = await f.postSteer({ text: "x" });
        expect(response.statusCode).toBe(status); expect(response.json().code).toBe(code);
      }
    } finally { await f.app.close(); }
  });
  it("rejects blank text before reaching the runtime; other owners see 404 and viewers 403", async () => {
    const f = await fixture();
    try {
      await f.activate();
      expect((await f.postSteer({ text: "   " })).statusCode).toBe(400);
      expect((await f.postSteer({})).statusCode).toBe(400);
      expect((await f.postSteer({ text: "x" }, "10.0.0.2")).statusCode).toBe(404);
      expect((await f.postSteer({ text: "x" }, "10.0.0.3")).statusCode).toBe(403);
      expect(f.steer).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
});
