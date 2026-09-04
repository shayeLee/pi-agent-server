import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { identityKey, type UserIdentity } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb, type SqliteTestStorage } from "../helpers/sqlite.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import { sessionDeleteOperationKey } from "../../src/storage/file-operation-policy.js";

const identity: UserIdentity = { kind: "account", accountId: "http-user" };
const token = "http-token";

it("HTTP DELETE session/project only enqueues file cleanup and never unlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-file-operation-http-"));
  const storage: SqliteTestStorage = await makeInitializedMemoryDb({ cwd: root, dataDir: root });
  let app: FastifyInstance | undefined;
  try {
    const authenticate = async () => identity;
    app = buildApp({
      sessions: storage.sessions,
      projects: storage.projects,
      defaultProjectCwd: root,
      authenticate,
      createAdapter: async () => new MockAgentAdapter(),
    });
    await app.ready();
    const file = join(root, "sessions", "http-session", "history.jsonl");
    mkdirSync(join(root, "sessions", "http-session"), { recursive: true });
    writeFileSync(file, "history\n");
    await storage.sessions.create({
      id: "http-session", ownerKey: identityKey(identity), projectId: DEFAULT_PROJECT_ID, title: "t",
      createdAt: 1, updatedAt: 1, piSessionFile: file, modelProvider: null, modelId: null,
      thinkingLevel: null, systemPrompt: null, capabilityVersions: null,
    });

    const response = await app.inject({ method: "DELETE", url: "/v1/sessions/http-session", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(204);
    expect(existsSync(file)).toBe(true);
    expect(await storage.fileOperations.list()).toEqual([
      expect.objectContaining({ operationKey: sessionDeleteOperationKey("http-session", "sessions/http-session/history.jsonl"), relativePath: "sessions/http-session/history.jsonl", state: "pending" }),
    ]);

    await storage.projects.create({ id: "http-project", name: "P", cwd: root, ownerKey: identityKey(identity), createdAt: 2 });
    const projectFile = join(root, "projects", "http-project", "sessions", "http-project-session", "history.jsonl");
    mkdirSync(join(root, "projects", "http-project", "sessions", "http-project-session"), { recursive: true });
    writeFileSync(projectFile, "history\n");
    await storage.sessions.create({
      id: "http-project-session", ownerKey: identityKey(identity), projectId: "http-project", title: "p", createdAt: 2, updatedAt: 2,
      piSessionFile: projectFile, modelProvider: null, modelId: null, thinkingLevel: null,
      systemPrompt: null, capabilityVersions: null,
    });
    const projectResponse = await app.inject({ method: "DELETE", url: "/v1/projects/http-project", headers: { authorization: `Bearer ${token}` } });
    expect(projectResponse.statusCode).toBe(204);
    expect(existsSync(projectFile)).toBe(true);
    expect(await storage.fileOperations.getByOperationKey(sessionDeleteOperationKey("http-project-session", "projects/http-project/sessions/http-project-session/history.jsonl"))).toMatchObject({
      relativePath: "projects/http-project/sessions/http-project-session/history.jsonl", state: "pending",
    });
  } finally {
    await app?.close();
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
