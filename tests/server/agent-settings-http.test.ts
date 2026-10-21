import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { AgentSettingsFile } from "../../src/settings/agent-settings-file.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess, USER_IP_A } from "../helpers/ip-access.js";

const ADMIN_IP = "10.0.0.9";
const VIEWER_IP = "10.0.0.8";

async function setup(withSettings = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-agent-settings-http-"));
  const settingsPath = path.join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ theme: "dark", modelThinkingLevels: { "fixture/a": "high" } }, null, 2));
  const agentSettings = new AgentSettingsFile(settingsPath);
  const { projects, sessions } = await makeInitializedMemoryDb({ cwd: dir });
  const app = buildApp({
    sessions, projects, defaultProjectCwd: dir, createAdapter: async () => new MockAgentAdapter(),
    ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: ADMIN_IP, role: "admin" }, { ip: VIEWER_IP, role: "viewer" }]) }),
    ...(withSettings ? { agentSettings } : {}),
  });
  const get = (remoteAddress: string) => app.inject({ method: "GET", url: "/v1/settings", remoteAddress });
  const put = (body: unknown, remoteAddress = ADMIN_IP) => app.inject({
    method: "PUT", url: "/v1/settings", remoteAddress, headers: { "content-type": "application/json" }, payload: JSON.stringify(body),
  });
  const hash = async () => (await get(ADMIN_IP)).json().file.hash as string;
  const file = () => JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  return { app, settingsPath, get, put, hash, file };
}

describe("Agent settings routes", () => {
  it("shows everyone the values and only admins the file", async () => {
    const { app, get, settingsPath } = await setup();
    try {
      const viewer = await get(VIEWER_IP);
      expect(viewer.statusCode).toBe(200);
      expect(viewer.json()).toEqual({
        canEdit: false, values: { autoCompaction: true, autoRetry: true, maxRetries: 3, modelThinkingLevels: { "fixture/a": "high" } },
        defaults: { autoCompaction: true, autoRetry: true, maxRetries: 3 },
      });
      const admin = await get(ADMIN_IP);
      expect(admin.headers["cache-control"]).toBe("private, no-store");
      expect(admin.json()).toMatchObject({ canEdit: true, file: { path: settingsPath, hash: expect.any(String) } });
    } finally { await app.close(); }
  });

  it("lets only admins save, keeping the file's other fields", async () => {
    const { app, put, hash, file } = await setup();
    try {
      expect((await put({ hash: await hash(), values: { autoCompaction: false } }, USER_IP_A)).statusCode).toBe(403);
      const saved = await put({ hash: await hash(), values: { autoCompaction: false, maxRetries: 0, modelThinkingLevels: { "fixture/b": "off" } } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().values).toEqual({ autoCompaction: false, autoRetry: true, maxRetries: 0, modelThinkingLevels: { "fixture/b": "off" } });
      expect(file()).toEqual({ theme: "dark", modelThinkingLevels: { "fixture/b": "off" }, compaction: { enabled: false }, retry: { maxRetries: 0 } });
    } finally { await app.close(); }
  });

  it("answers 409 for a stale hash and 400 for invalid values", async () => {
    const { app, put, hash, file } = await setup();
    try {
      expect((await put({ hash: "stale", values: { autoRetry: false } })).json()).toMatchObject({ statusCode: 409, code: "settings_changed" });
      expect((await put({ hash: await hash(), values: { maxRetries: 11 } })).statusCode).toBe(400);
      expect((await put({ hash: await hash(), values: { modelThinkingLevels: { "fixture/a": "extreme" } } })).statusCode).toBe(400);
      expect((await put({ hash: await hash(), values: { modelThinkingLevels: { nomodel: "low" } } })).json()).toMatchObject({ code: "settings_invalid" });
      expect(file()).toEqual({ theme: "dark", modelThinkingLevels: { "fixture/a": "high" } });
    } finally { await app.close(); }
  });

  it("lists each model's own thinking level with the models", async () => {
    const { app } = await setup();
    try {
      const models = await app.inject({ method: "GET", url: "/v1/models", remoteAddress: VIEWER_IP });
      expect(models.json().modelThinkingLevels).toEqual({ "fixture/a": "high" });
    } finally { await app.close(); }
  });

  it("says when the service has no Agent settings", async () => {
    const { app, get } = await setup(false);
    try {
      expect((await get(ADMIN_IP)).json()).toMatchObject({ statusCode: 404, code: "settings_not_configured" });
      expect((await app.inject({ method: "GET", url: "/v1/models", remoteAddress: ADMIN_IP })).json().modelThinkingLevels).toEqual({});
    } finally { await app.close(); }
  });
});
