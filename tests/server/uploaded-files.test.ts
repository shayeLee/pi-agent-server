import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { UploadService } from "../../src/application/upload-service.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { payloadFingerprint } from "../../src/core/payload-fingerprint.js";
import { KyselyUploadedFileRepository } from "../../src/storage/kysely-uploaded-file-repository.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess, USER_IP_A, USER_IP_B } from "../helpers/ip-access.js";
import type { IpAccessPolicy } from "../../src/core/ip-access-policy.js";
import type { SqliteTestStorage } from "../helpers/sqlite.js";

const rootDirs: string[] = [];
afterEach(() => { for (const dir of rootDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function fixture(policy?: IpAccessPolicy, concurrency?: ConcurrencyController,
  quota: { ownerMaxBytes: number; globalMaxBytes: number } = {
    ownerMaxBytes: 512 * 1024 * 1024, globalMaxBytes: 1024 * 1024 * 1024,
  }) {
  const raw = mkdtempSync(path.join(tmpdir(), "pi-upload-http-"));
  rootDirs.push(raw);
  const root = realpathSync(raw);
  const storage = await makeInitializedMemoryDb();
  const repo = new KyselyUploadedFileRepository(storage.kysely);
  const adapters = new Map<string, MockAgentAdapter>();
  const uploads = new UploadService(repo, storage.projects,
    { storageRoot: path.join(root, "uploads"), agentVisibleRoot: path.join(root, "agent-mount") }, quota);
  const app = buildApp({
    sessions: storage.sessions, projects: storage.projects, idempotencyRepo: storage.idempotency,
    uploads,
    defaultProjectCwd: root, ipAccess: makeTestIpAccess({ policy }), concurrency,
    createAdapter: async (id) => { const adapter = new MockAgentAdapter(); adapters.set(id, adapter); return adapter; },
  });
  return { app, storage, repo, adapters, uploads, root };
}
async function stop(app: FastifyInstance, storage: SqliteTestStorage) { await app.close(); await storage.close(); }

async function upload(app: FastifyInstance, options: {
  ip?: string; projectId?: string; key?: string; name?: string; kind?: string; mime?: string; bytes?: Buffer;
} = {}) {
  return app.inject({ method: "POST", url: "/v1/files", remoteAddress: options.ip ?? USER_IP_A,
    headers: { "content-type": "application/octet-stream", "x-upload-project-id": options.projectId ?? DEFAULT_PROJECT_ID,
      "x-upload-key": options.key ?? randomUUID(), "x-upload-name": encodeURIComponent(options.name ?? "notes.txt"),
      "x-upload-kind": options.kind ?? "text", "x-upload-type": options.mime ?? "text/plain" },
    payload: options.bytes ?? Buffer.from("trusted contents"),
  });
}
async function session(app: FastifyInstance, ip = USER_IP_A, createRequestId?: string) {
  const res = await app.inject({ method: "POST", url: "/v1/sessions", remoteAddress: ip,
    headers: { "content-type": "application/json" }, payload: JSON.stringify({ createRequestId }) });
  expect([200, 201]).toContain(res.statusCode);
  return res.json() as { id: string };
}
async function send(app: FastifyInstance, id: string, fileIds?: string[], prompt = "read these", requestId = randomUUID(), ip = USER_IP_A) {
  return app.inject({ method: "POST", url: `/v1/sessions/${id}/messages`, remoteAddress: ip,
    headers: { "content-type": "application/json" }, payload: JSON.stringify({ requestId, prompt, fileIds }) });
}

describe("non-image upload and message authorization", () => {
  it("uploads original text before creating a session; repeats same key without writing another file", async () => {
    const { app, storage, repo, root } = await fixture();
    try {
      const key = randomUUID();
      const first = await upload(app, { key });
      expect(first.statusCode).toBe(201);
      const again = await upload(app, { key });
      expect(again.statusCode).toBe(201);
      expect(again.json().fileId).toBe(first.json().fileId);
      expect(readdirSync(path.join(root, "uploads"))).toHaveLength(1);
      expect((await repo.findById(first.json().fileId))?.sessionId).toBeNull();
      expect((await upload(app, { key, bytes: Buffer.from("different") })).statusCode).toBe(409);
    } finally { await stop(app, storage); }
  });

  it("requires configured authentication and rejects viewer uploads", async () => {
    const policy = makePolicy([
      { ip: USER_IP_A, tokenRequired: true, tokens: ["upload-secret"] },
      { ip: USER_IP_B, role: "viewer" },
    ]);
    const { app, storage } = await fixture(policy);
    try {
      expect((await upload(app)).statusCode).toBe(401);
      expect((await upload(app, { ip: USER_IP_B })).statusCode).toBe(403);
    } finally { await stop(app, storage); }
  });

  it("denies unadmitted and other owners or projects without creating files", async () => {
    const { app, storage, repo } = await fixture();
    try {
      expect((await upload(app, { ip: "203.0.113.9" })).statusCode).toBe(403);
      const p = randomUUID();
      await storage.projects.create({ id: p, ownerKey: "ip:10.0.0.2", name: "foreign", cwd: "/foreign", createdAt: 1 });
      expect((await upload(app, { projectId: p })).statusCode).toBe(404);
      const owned = await upload(app);
      const sid = await session(app, USER_IP_B);
      expect((await send(app, sid.id, [owned.json().fileId], "read", randomUUID(), USER_IP_B)).statusCode).toBe(404);
      expect((await repo.findById(owned.json().fileId))?.sessionId).toBeNull();
    } finally { await stop(app, storage); }
  });

  it("rejects a same-owner upload from a different project before any Agent call", async () => {
    const { app, storage, repo, adapters } = await fixture();
    try {
      const extraProject = randomUUID();
      await storage.projects.create({ id: extraProject, ownerKey: identityKey({ kind: "ip", ip: USER_IP_A }), name: "extra", cwd: "/extra", createdAt: 1 });
      const uploaded = await upload(app, { projectId: extraProject });
      expect(uploaded.statusCode).toBe(201);
      const sid = await session(app);
      expect((await send(app, sid.id, [uploaded.json().fileId])).statusCode).toBe(404);
      expect((await repo.findById(uploaded.json().fileId))?.sessionId).toBeNull();
      expect(adapters.get(sid.id)?.calls.filter((c) => c.method === "prompt") ?? []).toHaveLength(0);
    } finally { await stop(app, storage); }
  });

  it("enforces cumulative owner quota before storing bytes, without deleting prior originals", async () => {
    const { app, storage, root } = await fixture(undefined, undefined, { ownerMaxBytes: 20, globalMaxBytes: 100 });
    try {
      const first = await upload(app);
      expect(first.statusCode).toBe(201);
      expect((await upload(app, { name: "another.txt" })).statusCode).toBe(507);
      expect(readdirSync(path.join(root, "uploads"))).toHaveLength(1);
    } finally { await stop(app, storage); }
  });

  it("rejects fake names, MIME/content tricks, executables, archives, and oversize originals", async () => {
    const { app, storage } = await fixture();
    try {
      expect((await upload(app, { name: "../report.txt" })).statusCode).toBe(400);
      expect((await upload(app, { name: "report.pdf", kind: "pdf", mime: "application/pdf", bytes: Buffer.from("not a PDF") })).statusCode).toBe(400);
      expect((await upload(app, { name: "program.exe", kind: "code", mime: "text/plain" })).statusCode).toBe(400);
      expect((await upload(app, { name: "data.zip" })).statusCode).toBe(400);
      expect((await upload(app, { bytes: Buffer.alloc(20 * 1024 * 1024 + 1, 65) })).statusCode).toBe(413);
    } finally { await stop(app, storage); }
  });

  it("never invokes the agent on forged file IDs, and claims all files atomically", async () => {
    const { app, storage, repo, adapters } = await fixture();
    try {
      const file = (await upload(app)).json();
      const sid = await session(app);
      expect((await send(app, sid.id, [file.fileId, randomUUID()], "/fake/path")).statusCode).toBe(404);
      expect((await repo.findById(file.fileId))?.sessionId).toBeNull();
      expect(adapters.get(sid.id)?.calls.filter((c) => c.method === "prompt") ?? []).toHaveLength(0);
      const accepted = await send(app, sid.id, [file.fileId]);
      expect(accepted.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const calls = adapters.get(sid.id)?.calls.filter((c) => c.method === "prompt") ?? [];
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls[0])).toContain(file.agentPath);
      expect((await repo.findById(file.fileId))?.sessionId).toBe(sid.id);
      const other = await session(app);
      expect((await send(app, other.id, [file.fileId])).statusCode).toBe(409);
    } finally { await stop(app, storage); }
  });

  it("a persisted unknown request reservation never re-executes or falsely claims files", async () => {
    const { app, storage, repo, adapters, uploads } = await fixture();
    try {
      const file = (await upload(app)).json();
      const sid = await session(app);
      const requestId = randomUUID();
      const fileIds = [file.fileId];
      const inspected = await uploads.prepareForMessage({ ownerKey: identityKey({ kind: "ip", ip: USER_IP_A }),
        projectId: DEFAULT_PROJECT_ID, sessionId: sid.id, prompt: "q", fileIds }, false);
      expect(inspected.kind).toBe("prepared");
      if (inspected.kind !== "prepared") return;
      const fingerprint = payloadFingerprint({ prompt: inspected.prompt, fileIds });
      expect((await storage.idempotency.reserve(sid.id, requestId, fingerprint)).kind).toBe("owner");
      const response = await send(app, sid.id, fileIds, "q", requestId);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("REQUEST_STATUS_UNKNOWN");
      expect((await repo.findById(file.fileId))?.sessionId).toBeNull();
      expect(adapters.get(sid.id)?.calls.filter((c) => c.method === "prompt") ?? []).toHaveLength(0);
    } finally { await stop(app, storage); }
  });

  it("queue-capacity rejection never binds an otherwise valid file or calls the Agent", async () => {
    const concurrency = new ConcurrencyController({ globalLimit: 0, perUserLimit: 0,
      perUserQueueLimit: 0, globalQueueLimit: 0, queueTimeoutMs: 1000 });
    const { app, storage, repo, adapters } = await fixture(undefined, concurrency);
    try {
      const file = (await upload(app)).json();
      const sid = await session(app);
      expect((await send(app, sid.id, [file.fileId])).statusCode).toBe(429);
      expect((await repo.findById(file.fileId))?.sessionId).toBeNull();
      expect(adapters.get(sid.id)?.calls.filter((c) => c.method === "prompt") ?? []).toHaveLength(0);
    } finally { await stop(app, storage); }
  });

  it("same requestId with same file IDs does not invoke Pi twice; mismatched file IDs conflict", async () => {
    const { app, storage, adapters, repo } = await fixture();
    try {
      const f1 = (await upload(app)).json();
      const f2 = (await upload(app)).json();
      const sid = await session(app);
      const requestId = randomUUID();
      expect((await send(app, sid.id, [f1.fileId], "q", requestId)).statusCode).toBe(202);
      expect([200, 202]).toContain((await send(app, sid.id, [f1.fileId], "q", requestId)).statusCode);
      expect((await send(app, sid.id, [f2.fileId], "q", requestId)).statusCode).toBe(409);
      expect((await repo.findById(f2.fileId))?.sessionId).toBeNull();
      expect(adapters.get(sid.id)?.calls.filter((c) => c.method === "prompt")).toHaveLength(1);
    } finally { await stop(app, storage); }
  });

  it("session deletion does not clean uploaded originals or metadata", async () => {
    const { app, storage, repo, root } = await fixture();
    try {
      const file = (await upload(app)).json();
      const sid = await session(app);
      expect((await send(app, sid.id, [file.fileId])).statusCode).toBe(202);
      const deleted = await app.inject({ method: "DELETE", url: `/v1/sessions/${sid.id}`, remoteAddress: USER_IP_A });
      expect(deleted.statusCode).toBe(204);
      expect((await repo.findById(file.fileId))?.sessionId).toBe(sid.id);
      expect(readdirSync(path.join(root, "uploads"))).toHaveLength(1);
    } finally { await stop(app, storage); }
  });

  it("first-send stages recover without a duplicate session and five files are accepted", async () => {
    const { app, storage, adapters } = await fixture();
    try {
      const files: string[] = [];
      for (let i = 0; i < 5; i++) files.push((await upload(app, { name: `file-${i}.txt` })).json().fileId);
      const createKey = randomUUID();
      const sid = await session(app, USER_IP_A, createKey);
      const requestId = randomUUID();
      expect((await send(app, sid.id, [...files.slice(0, 4), randomUUID()], "review", requestId)).statusCode).toBe(404);
      expect((await session(app, USER_IP_A, createKey)).id).toBe(sid.id);
      expect((await send(app, sid.id, files, "review", requestId)).statusCode).toBe(202);
      expect([200, 202]).toContain((await send(app, sid.id, files, "review", requestId)).statusCode);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(adapters.get(sid.id)?.calls.filter((c) => c.method === "prompt")).toHaveLength(1);
    } finally { await stop(app, storage); }
  });

  it("rejects six references and a valid batch exceeding 50 MiB before binding any file", async () => {
    const { app, storage, repo } = await fixture();
    try {
      const one = (await upload(app)).json();
      const sid = await session(app);
      expect((await send(app, sid.id, Array(6).fill(one.fileId))).statusCode).toBe(400);
      expect((await repo.findById(one.fileId))?.sessionId).toBeNull();
      const large = Buffer.alloc(18 * 1024 * 1024, 65);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const response = await upload(app, { name: `large-${i}.txt`, bytes: large });
        expect(response.statusCode).toBe(201);
        ids.push(response.json().fileId);
      }
      expect((await send(app, sid.id, ids)).statusCode).toBe(400);
      for (const id of ids) expect((await repo.findById(id))?.sessionId).toBeNull();
    } finally { await stop(app, storage); }
  });
});
