import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../../src/server/app.js";
import { steeringSdkFixture } from "../agent/steering-sdk-fixture.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";

it("HTTP authoritative queue GET, correlated/legacy follow-up admission and strict identity conflict/status mapping", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-control-http-"));
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  const f = await steeringSdkFixture(root);
  const consumed = vi.fn();
  f.adapter.subscribeSteeringConsumed(consumed);
  const { sessions, projects } = await makeInitializedMemoryDb({ cwd: root });
  let creations = 0;
  const app = buildApp({ sessions, projects, defaultProjectCwd: root, ipAccess: makeTestIpAccess(),
    defaultModel: null, createAdapter: async () => { creations++; return f.adapter; } });
  const inject = (method: any, url: string, payload?: unknown) => app.inject({ method, url, payload: payload as any, remoteAddress: "10.0.0.1" });
  try {
    const created = await inject("POST", "/v1/sessions", {});
    const id = created.json().id;
    const path = `/v1/sessions/${id}/control-queue`;
    const absent = (await inject("GET", path)).json();
    expect(absent).toEqual({ requestId: null, revision: expect.any(Number), items: [] });
    expect((await inject("GET", path)).json()).toEqual(absent);
    expect(creations).toBe(0); // Reload read never instantiates a SDK runtime.
    expect((await inject("DELETE", `${path}/missing`, { requestId: "run", acknowledgementId: "a" })).statusCode).toBe(409);
    expect(creations).toBe(0);
    expect((await inject("POST", `/v1/sessions/${id}/messages`, { requestId: "run", prompt: "primary" })).statusCode).toBe(202);
    await vi.waitFor(() => expect(f.waits()).toBe(1));
    // Real SDK primary prompt must never be correlated or resident as a control.
    expect((await inject("GET", path)).json()).toMatchObject({ requestId: "run", items: [] });
    expect(f.adapter.getControlQueueItems()).toEqual([]);
    expect(consumed).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(f.session.agent.hasQueuedMessages()).toBe(false);
    expect(f.session.getSteeringMessages()).toEqual([]);
    expect(f.session.messages.filter(message => message.role === "user")).toMatchObject([
      { content: [{ type: "text", text: "primary" }] },
    ]);
    expect(f.session.sessionManager.getBranch().some(entry => entry.type === "custom" &&
      entry.customType === "pi-agent-server.steering-consumed")).toBe(false);
    const input = { text: "same", controlId: "a", requestId: "run", acknowledgementId: "ack" };
    const admitted = await inject("POST", `/v1/sessions/${id}/follow-ups`, input);
    expect(admitted.statusCode).toBe(202); expect(admitted.body).toBe("");
    expect((await inject("GET", path)).json()).toMatchObject({ requestId: "run", items: [{ id: "a", kind: "followUp", acknowledgementId: "ack" }] });
    const mutation = { requestId: "run", acknowledgementId: "ack" };
    expect((await inject("POST", `${path}/a/promote`, mutation)).json().items[0].kind).toBe("steer");
    expect((await inject("POST", `${path}/a/promote`, mutation)).statusCode).toBe(200);
    expect((await inject("DELETE", `${path}/a`, { ...mutation, acknowledgementId: "wrong" })).statusCode).toBe(409);
    expect((await inject("DELETE", `${path}/a`, { requestId: "run" })).statusCode).toBe(400);
    expect((await inject("DELETE", `${path}/a`, mutation)).statusCode).toBe(200);
    expect((await inject("DELETE", `${path}/a`, mutation)).statusCode).toBe(200);
    expect((await inject("POST", `/v1/sessions/${id}/follow-ups`, input)).statusCode).toBe(202);
    expect((await inject("GET", path)).json().items).toEqual([]);
    expect((await inject("POST", `/v1/sessions/${id}/follow-ups`, { text: "legacy" })).statusCode).toBe(204);
    expect((await inject("GET", path)).json().items).toEqual([]); // Uncorrelated SDK items are retained but not exposed.
    expect(f.session.agent.hasQueuedMessages()).toBe(true);
    for (const payload of [{ text: "incomplete", controlId: "only" }, { text: "bad", requestId: "run" }, { text: "bad", acknowledgementId: "ack" }]) {
      expect((await inject("POST", `/v1/sessions/${id}/follow-ups`, payload)).statusCode).toBe(400);
    }
    f.session.agent.clearAllQueues();
    expect((await inject("DELETE", `${path}/a`, mutation)).statusCode).toBe(200); // Successful deletion tombstone.
    expect((await inject("POST", `/v1/sessions/${id}/steer`, { ...input, controlId: "drained" })).statusCode).toBe(202);
    f.session.agent.clearAllQueues(); // Simulate drain before downstream notification.
    expect((await inject("DELETE", `${path}/drained`, mutation)).statusCode).toBe(409);
    expect((await inject("GET", path)).json().items).toEqual([]);
    expect(f.session.agent.hasQueuedMessages()).toBe(false);
    expect((await inject("GET", "/v1/sessions/missing/control-queue")).statusCode).toBe(404);
    expect((await inject("DELETE", "/v1/sessions/missing/control-queue/a", mutation)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: path, remoteAddress: "10.0.0.2" })).statusCode).toBe(404);
    await inject("POST", `/v1/sessions/${id}/abort`);
    expect((await inject("GET", path)).json()).toMatchObject({ requestId: null, items: [] });
    expect((await inject("DELETE", `${path}/a`, mutation)).statusCode).toBe(409);
  } finally { await app.close(); f.adapter.dispose(); network.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
