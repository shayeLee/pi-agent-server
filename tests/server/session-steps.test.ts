import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { projectColdSessionSteps } from "../../src/agent/session-steps-projector.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../helpers/ip-access.js";
import { identityKey } from "../../src/core/user-identity.js";
import { DEFAULT_PROJECT_ID } from "../../src/shared/project-identity.js";
import { ConversationStorageRegistry } from "../../src/application/ports/conversation-port.js";
import type { NativeSessionPort } from "../../src/application/ports/native-session-port.js";
import type { SessionStepsSnapshot } from "../../src/shared/session-steps.js";
const OWNER = "10.0.0.1";
const snapshot = (projectionId: string): SessionStepsSnapshot => ({ sessionId: "steps", projectionId, revision: 1, steps: [{ id: "step", kind: "assistant_text", content: projectionId, status: "completed", source: "observed" }] });
async function fixture(nativeSessions?: NativeSessionPort, shared = false) {
  const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/steps-server-test" });
  await sessions.create({ id: "steps", ownerKey: identityKey({ kind: "ip", ip: OWNER }), projectId: DEFAULT_PROJECT_ID, title: "steps", createdAt: 1, updatedAt: 1, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null, modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: "creation", capabilityVersions: null, ...(shared ? { origin: "native" as const, visibility: "shared" as const } : {}) });
  const adapter = new MockAgentAdapter();
  const live = vi.fn(() => snapshot("live"));
  Object.assign(adapter, { getSessionSteps: live });
  const createAdapter = vi.fn(async () => adapter);
  const readSteps = vi.fn(async () => snapshot("cold"));
  const storage = new ConversationStorageRegistry();
  storage.register({ agentKind: "pi", conversationFormat: "pi-jsonl-v3", readSteps, readExport: async () => { throw new Error("steps must not use chat timeline"); }, planCleanup: () => null });
  const app = buildApp({ sessions, projects, conversationStorage: storage, nativeSessions, defaultProjectCwd: "/tmp/steps-server-test", createAdapter, ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: "10.0.0.3", role: "viewer" }, { ip: "10.0.0.4", role: "operator" }]) }) });
  const get = (ip = OWNER, id = "steps") => app.inject({ method: "GET", url: `/v1/sessions/${id}/steps`, remoteAddress: ip });
  const activate = () => app.inject({ method: "POST", url: "/v1/sessions/steps/messages", remoteAddress: OWNER, payload: { requestId: "activate", prompt: "offline" } });
  return { app, sessions, live, readSteps, createAdapter, get, activate };
}
describe("GET session steps authorization/read-only", () => {
  it("returns cold projection without creating runtime; missing/other owner indistinguishable and operator denied", async () => {
    const f = await fixture();
    try {
      expect((await f.get()).json()).toEqual(snapshot("cold"));
      expect(f.createAdapter).not.toHaveBeenCalled();
      expect(f.live).not.toHaveBeenCalled();
      const missing = await f.get(OWNER, "missing"), denied = await f.get("10.0.0.2");
      expect(missing.statusCode).toBe(404); expect(denied.statusCode).toBe(404); expect(denied.body).toBe(missing.body);
      expect((await f.get("10.0.0.4")).statusCode).toBe(403);
      expect(f.readSteps).toHaveBeenCalledTimes(1);
    } finally { await f.app.close(); }
  });
  it("repeated cold GET retains identity/revision; append advances revision without a new generation", async () => {
    const f = await fixture();
    const branch: any[] = [{ type: "message", id: "cold-root", message: { role: "user", content: "root" } }];
    f.readSteps.mockImplementation(async () => projectColdSessionSteps("steps", structuredClone(branch)));
    try {
      const first = (await f.get()).json();
      expect((await f.get()).json()).toEqual(first);
      branch.push({ type: "message", id: "cold-append", parentId: "cold-root", message: { role: "assistant", content: [{ type: "text", text: "append" }] } });
      const append = (await f.get()).json();
      expect(append.projectionId).toBe(first.projectionId);
      expect(append.revision).toBeGreaterThan(first.revision);
      expect((await f.get()).json()).toEqual(append);
      expect(f.createAdapter).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it("prefers live even if runtime appears while cold read is awaiting", async () => {
    const f = await fixture();
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    f.readSteps.mockImplementation(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return snapshot("cold"); });
    try {
      const response = f.get();
      await entered;
      await f.activate(); release();
      expect((await response).json()).toEqual(snapshot("live"));
      expect((await f.get()).json()).toEqual(snapshot("live"));
      expect(f.readSteps).toHaveBeenCalledTimes(1);
      expect(f.createAdapter).toHaveBeenCalledTimes(1);
    } finally { release?.(); await f.app.close(); }
  });
  it("native shared viewer requires current source capability and rejects revocation during cold read", async () => {
    let allowed = true;
    const native: NativeSessionPort = { discover: async () => [], allows: async () => allowed, cwdIdentity: async () => null, outputGuard: async () => () => allowed };
    const f = await fixture(native, true);
    try {
      expect((await f.get("10.0.0.3")).statusCode).toBe(200);
      f.readSteps.mockImplementation(async () => { await Promise.resolve(); allowed = false; return snapshot("secret"); });
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
      cold.readSteps.mockImplementation(async () => { await cold.sessions.delete("steps"); return snapshot("secret"); });
      expect((await cold.get()).statusCode).toBe(404);
      expect(cold.createAdapter).not.toHaveBeenCalled();
    } finally { await cold.app.close(); }
  });
});
