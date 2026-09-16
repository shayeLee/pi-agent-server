// P8 宿主侧集成演练：所有状态都在临时目录或内存 SQLite 中，Agent 与插件均为 fake。
// 仅验证宿主公开插件契约，不加载、注册或配置任何真实外部插件。

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import { PluginLoader } from "../../src/application/plugins/loader.js";
import { registerPlugins, type PluginHost } from "../../src/server/plugin-host.js";
import type { PluginModule } from "../../src/plugin/index.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import type { AgentSdkEvent } from "../../src/agent/events.js";
import { ConcurrencyController } from "../../src/core/concurrency-control.js";
import { ConversationStorageRegistry, DEFAULT_PROJECT_ID, type ModelCatalogPort } from "../../src/application/ports/index.js";
import { PiJsonlConversationStorage } from "../../src/agent/pi-jsonl-conversation-storage.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makePolicy, makeTestIpAccess } from "../helpers/ip-access.js";
import { PNG_2X2_BASE64 } from "../helpers/image-fixtures.js";
import { openapiV1 } from "../../src/public-api/openapi-v1.js";

const USER_IP = "127.0.0.1";
const VIEWER_IP = "10.0.0.22";
const JSON_HEADERS = { "content-type": "application/json" };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const exportSchema = (openapiV1 as unknown as {
  components: { schemas: { Export: { required: readonly string[]; properties: { lastEventId: { minimum: number } }; additionalProperties: boolean } } };
}).components.schemas.Export;

/** Minimal validator for the checked OpenAPI Export schema used by the JSONL inject drill. */
function matchesExportSchema(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (exportSchema.required.some((name) => !(name in body))) return false;
  if (exportSchema.additionalProperties === false && Object.keys(body).some((name) => name !== "messages" && name !== "timeline" && name !== "lastEventId")) return false;
  return typeof body.lastEventId === "number" && Number.isInteger(body.lastEventId) && body.lastEventId >= exportSchema.properties.lastEventId.minimum;
}

/** fake 模型目录：只承认 fake plugin mode 声明的 fake/fake-model，绝不访问真实供应商。 */
const FAKE_MODEL_CATALOG: ModelCatalogPort = {
  async getAvailable() {
    return [{ provider: "fake", id: "fake-model", name: "fake-model" }];
  },
  async isAvailable(provider, id) {
    return provider === "fake" && id === "fake-model";
  },
};

/**
 * 可控流式 fake adapter：prompt 先同步发预设事件（启动 + text_delta），再挂起直到 finishStream，
 * 便于在任务仍 streaming 时观察 SSE requestId、queued 与精确 abort。
 */
class DrillAdapter extends MockAgentAdapter {
  private release?: () => void;

  constructor(preset: readonly AgentSdkEvent[] = [
    { type: "agent_start" },
    {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "p8 drill" },
    },
  ]) {
    super(preset);
  }

  override async prompt(text: string, options?: { images?: { mediaType: string; base64: string }[] }): Promise<void> {
    this.calls.push(options?.images === undefined
      ? { method: "prompt", text }
      : { method: "prompt", text, images: options.images });
    // 经命名桥接调用 MockAgentAdapter 的 private flush：先投递预设事件，再保持本轮进行中。
    (this as unknown as { flush: () => void }).flush();
    await new Promise<void>((resolve) => { this.release = resolve; });
  }

  finishStream(): void {
    this.release?.();
  }
}

async function post(app: FastifyInstance, url: string, body: unknown, remoteAddress = USER_IP) {
  const response = await app.inject({
    method: "POST",
    url,
    headers: JSON_HEADERS,
    remoteAddress,
    payload: JSON.stringify(body),
  });
  return { statusCode: response.statusCode, body: response.body ? response.json() : undefined };
}

/** 读取真实 SSE socket 至包含 needle；只用于本演练，超时会让断言失败。 */
async function readSseUntil(url: string, needle: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  const response = await fetch(url, { headers: { "last-event-id": "0" }, signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes(needle)) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => {});
  }
  return text;
}

/** 经公开 PluginModule 契约创建的内存 fake plugin；不访问文件系统或外部服务。 */
function fakePlugin(): PluginModule {
  return {
    manifest: {
      id: "p8-drill",
      version: 1,
      modes: [
        {
          id: "p8-mode",
          modelProvider: "fake",
          modelId: "fake-model",
          systemPrompt: "P8 fake mode prompt",
        },
        {
          id: "p8-append",
          modelProvider: "fake",
          modelId: "fake-model",
          appendSystemPrompt: "P8 append fragment",
        },
      ],
    },
    register(context) {
      context.mountRoute({
        method: "GET",
        path: "/status",
        access: "read",
        handler: ({ reply }) => (reply as { code: (status: number) => { send: (body: unknown) => unknown } })
          .code(200).send({ ok: true }),
      });
      context.mountRoute({
        method: "POST",
        path: "/modes/:modeId/sessions",
        access: "write",
        handler: async ({ sessions, request, reply }) => {
          const modeId = (request as { params: { modeId?: unknown } }).params.modeId;
          if (modeId !== "p8-mode" && modeId !== "p8-append") throw new Error("unknown fake mode");
          const reservation = await sessions.reserve({ modeId });
          const session = await sessions.create({ reservation, title: "P8 temporary session" });
          return (reply as { code: (status: number) => { send: (body: unknown) => unknown } })
            .code(201).send({ session });
        },
      });
      context.mountRoute({
        method: "POST",
        path: "/modes/:modeId/sessions/:sessionId/restore",
        access: "write",
        handler: async ({ sessions, request, reply }) => {
          const params = (request as { params: { modeId?: unknown; sessionId?: unknown } }).params;
          if (
            (params.modeId !== "p8-mode" && params.modeId !== "p8-append") ||
            typeof params.sessionId !== "string"
          ) throw new Error("bad fake restore");
          const session = await sessions.restore(params.sessionId);
          if (session === null) throw new Error("missing fake session");
          return (reply as { code: (status: number) => { send: (body: unknown) => unknown } })
            .code(200).send({ session });
        },
      });
    },
  };
}

describe("P8 host integration drill", () => {
  const apps: FastifyInstance[] = [];
  const hosts: PluginHost[] = [];
  const closers: Array<() => Promise<void>> = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close().catch(() => {})));
    await Promise.all(hosts.splice(0).map((host) => host.dispose().catch(() => {})));
    await Promise.all(closers.splice(0).map((close) => close().catch(() => {})));
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("临时 ESM fixture 经公开加载契约解析，阶段一不注册", async () => {
    const temporaryProject = mkdtempSync(path.join(tmpdir(), "p8-esm-load-"));
    directories.push(temporaryProject);
    const entry = path.join(temporaryProject, "fixture.mjs");
    writeFileSync(entry, [
      "export default {",
      '  manifest: { id: "p8-esm-fixture", version: 1 },',
      "  register() { throw new Error('register must not run during loading'); },",
      "};",
      "",
    ].join("\n"), "utf8");

    const loader = new PluginLoader({ projectCwd: temporaryProject });
    const loaded = await loader.load(pathToFileURL(entry).href);

    expect(loaded.manifest).toEqual({ id: "p8-esm-fixture", version: 1 });
    expect(loader.loadedIds()).toEqual(["p8-esm-fixture"]);
    expect(typeof loaded.plugin.register).toBe("function");
    expect(existsSync(entry)).toBe(true);
  });

  it("插件加载失败：固定错误文案、不注册任何插件且不产生副作用", async () => {
    const temporaryProject = mkdtempSync(path.join(tmpdir(), "p8-load-error-"));
    directories.push(temporaryProject);
    const loader = new PluginLoader({ projectCwd: temporaryProject });

    // 不存在的包 specifier：加载失败必须携带固定前缀，且绝不回显无关内容。
    await expect(loader.load("p8-drill-not-installed-package")).rejects.toThrow(/^插件加载失败: /);
    expect(loader.loadedIds()).toEqual([]);

    // 加载失败后同一 loader 仍可正常加载合法插件（失败不污染状态）。
    const loaded = await loader.load(fakePlugin());
    expect(loaded.manifest.id).toBe("p8-drill");
    expect(loader.loadedIds()).toEqual(["p8-drill"]);
    expect(existsSync(temporaryProject)).toBe(true); // 临时目录仅被创建，未被写入任何插件数据
  });

  it("fake plugin + fake adapter：RBAC、mode create/restore、图片、SSE requestId、queued/streaming 与精确 abort", async () => {
    const temporaryProject = mkdtempSync(path.join(tmpdir(), "p8-host-drill-"));
    directories.push(temporaryProject);
    const storage = await makeInitializedMemoryDb({ cwd: temporaryProject });
    const adapters = new Map<string, DrillAdapter>();
    const concurrency = new ConcurrencyController({
      globalLimit: 2,
      perUserLimit: 1,
      perUserQueueLimit: 1,
      globalQueueLimit: 2,
      queueTimeoutMs: 60_000,
    });
    const loadedFake = await new PluginLoader({ projectCwd: temporaryProject }).load(fakePlugin());
    // buildApp 在创建期经 callback 交出同一个真实 SessionService，供 plugin host 使用。
    let sessionService: Parameters<typeof registerPlugins>[1]["sessions"] | undefined;
    const hostApp = buildApp({
      sessions: storage.sessions,
      projects: storage.projects,
      defaultProjectCwd: temporaryProject,
      systemPrompt: "P8 host system prompt",
      modelCatalog: FAKE_MODEL_CATALOG,
      concurrency,
      ipAccess: makeTestIpAccess({ policy: makePolicy([
        { ip: USER_IP, role: "user" },
        { ip: VIEWER_IP, role: "viewer" },
      ]) }),
      createAdapter: async (id) => {
        const adapter = new DrillAdapter();
        adapters.set(id, adapter);
        return adapter;
      },
      onSessionServiceReady: (service) => { sessionService = service; },
    });
    apps.push(hostApp);
    closers.push(storage.close);
    expect(sessionService).toBeDefined();
    const host = await registerPlugins([loadedFake], {
      app: hostApp,
      projectCwd: temporaryProject,
      sessions: sessionService!,
    });
    hosts.push(host);

    // viewer 可以读 capability，但写路由在 handler 之前被 RBAC 拒绝。
    expect((await hostApp.inject({ method: "GET", url: "/v1/capabilities/p8-drill/status", remoteAddress: VIEWER_IP })).statusCode).toBe(200);
    expect((await post(hostApp, "/v1/capabilities/p8-drill/modes/p8-mode/sessions", {}, VIEWER_IP)).statusCode).toBe(403);

    const created = await post(hostApp, "/v1/capabilities/p8-drill/modes/p8-mode/sessions", {});
    expect(created.statusCode).toBe(201);
    const sessionA = (created.body as { session: { id: string } }).session.id;
    // 旧版整体覆盖语义：会话冻结的就是 mode.systemPrompt 字面量，不追加任何默认提示词。
    expect((await storage.sessions.get(sessionA))?.systemPrompt).toBe("P8 fake mode prompt");
    const restored = await post(hostApp, `/v1/capabilities/p8-drill/modes/p8-mode/sessions/${sessionA}/restore`, {});
    expect(restored).toMatchObject({ statusCode: 200, body: { session: { id: sessionA } } });

    // P7c 追加语义：宿主先解析完整提示词（此演练为注入的 host systemPrompt），再以空行分隔追加片段并冻结。
    const appended = await post(hostApp, "/v1/capabilities/p8-drill/modes/p8-append/sessions", {});
    expect(appended.statusCode).toBe(201);
    const appendedId = (appended.body as { session: { id: string } }).session.id;
    expect((await storage.sessions.get(appendedId))?.systemPrompt).toBe("P8 host system prompt\n\nP8 append fragment");
    // 恢复复用冻结快照：绝不重复追加。
    expect(await post(hostApp, `/v1/capabilities/p8-drill/modes/p8-append/sessions/${appendedId}/restore`, {}))
      .toMatchObject({ statusCode: 200, body: { session: { id: appendedId } } });
    expect((await storage.sessions.get(appendedId))?.systemPrompt).toBe("P8 host system prompt\n\nP8 append fragment");

    await hostApp.listen({ port: 0, host: USER_IP });
    const port = (hostApp.server.address() as { port: number }).port;
    const image = { mediaType: "image/png", base64: PNG_2X2_BASE64 };
    expect(await post(hostApp, `/v1/sessions/${sessionA}/messages`, {
      requestId: "image-r1",
      prompt: "inspect temporary image",
      images: [image],
    })).toMatchObject({ statusCode: 202, body: { status: "accepted" } });
    // Last-Event-ID=0 的 SSE 补发能确定性读取已入总线的 requestId，避免连接建立竞态。
    const sseText = await readSseUntil(`http://${USER_IP}:${port}/v1/sessions/${sessionA}/events`, '"requestId":"image-r1"');
    expect(sseText).toContain('"phase":"agent_start","requestId":"image-r1"');
    expect(sseText).toContain('"type":"text_delta","text":"p8 drill","requestId":"image-r1"');
    expect(adapters.get(sessionA)!.calls).toContainEqual({ method: "prompt", text: "inspect temporary image", images: [image] });

    const second = await post(hostApp, "/v1/capabilities/p8-drill/modes/p8-mode/sessions", {});
    const sessionB = (second.body as { session: { id: string } }).session.id;
    expect(await post(hostApp, `/v1/sessions/${sessionB}/messages`, { requestId: "queued-r2", prompt: "queued" }))
      .toMatchObject({ statusCode: 202, body: { status: "queued" } });
    expect(adapters.get(sessionB)!.calls).toHaveLength(0);

    // 错误 selector 不得 abort 当前 image-r1；正确 selector 才可中止。
    expect(await post(hostApp, `/v1/sessions/${sessionA}/abort`, { requestId: "wrong-request" })).toMatchObject({ statusCode: 409 });
    expect(adapters.get(sessionA)!.aborted).toBe(false);
    expect(await post(hostApp, `/v1/sessions/${sessionA}/abort`, { requestId: "image-r1" })).toMatchObject({ statusCode: 204 });
    expect(adapters.get(sessionA)!.aborted).toBe(true);
    adapters.get(sessionA)!.finishStream();
    await tick();
    await tick();
    expect(adapters.get(sessionB)!.calls).toContainEqual({ method: "prompt", text: "queued" });

    // 清理 queued→streaming 的第二轮，避免任何 fake task 脱离演练生命周期。
    expect(await post(hostApp, `/v1/sessions/${sessionB}/abort`, { requestId: "queued-r2" })).toMatchObject({ statusCode: 204 });
    adapters.get(sessionB)!.finishStream();
  });

  it("重启后只读 export 保持可用；临时 JSONL 缺失仍维持宿主现状 fail-closed", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "p8-export-"));
    directories.push(dataDir);
    const storage = await makeInitializedMemoryDb({ cwd: dataDir, dataDir });
    const sessionId = "p8-persisted";
    const ref = path.join(dataDir, "sessions", sessionId, "history.jsonl");
    // JSONL 是临时 fixture，不通过 Agent SDK 生成，也不触及真实用户数据。
    mkdirSync(path.dirname(ref), { recursive: true, mode: 0o700 });
    writeFileSync(ref, [
      `{"type":"session","version":3,"id":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${dataDir}"}`,
      '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"restart export"}]}}',
      '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
      "",
    ].join("\n"));
    await storage.sessions.create({
      id: sessionId,
      ownerKey: identityKey({ kind: "ip", ip: USER_IP }),
      projectId: DEFAULT_PROJECT_ID,
      title: "P8 persisted fixture",
      createdAt: 1,
      updatedAt: 1,
      agentKind: "pi",
      conversationFormat: "pi-jsonl-v3",
      conversationRef: ref,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      systemPrompt: null,
      capabilityVersions: null,
    });
    closers.push(storage.close);
    const conversationStorage = new ConversationStorageRegistry();
    conversationStorage.register(new PiJsonlConversationStorage(dataDir));
    let adapterCreations = 0;
    const makeApp = () => buildApp({
      sessions: storage.sessions,
      projects: storage.projects,
      defaultProjectCwd: dataDir,
      conversationStorage,
      ipAccess: makeTestIpAccess({ policy: makePolicy([{ ip: USER_IP, role: "user" }]) }),
      createAdapter: async () => { adapterCreations++; return new DrillAdapter(); },
    });

    const first = makeApp();
    apps.push(first);
    const firstExport = await first.inject({ method: "GET", url: `/v1/sessions/${sessionId}/export`, remoteAddress: USER_IP });
    expect(firstExport.statusCode).toBe(200);
    expect(matchesExportSchema(firstExport.json())).toBe(true);
    expect(firstExport.json())
      .toMatchObject({ messages: [{ role: "user", text: "restart export" }, { role: "assistant", text: "ok" }], lastEventId: 0 });
    await first.close();
    apps.pop();

    // 重建 HTTP/runtime 层（模拟重启）后仍由持久 session record + JSONL 只读导出，零 adapter 创建。
    const restarted = makeApp();
    apps.push(restarted);
    const restartedExport = await restarted.inject({ method: "GET", url: `/v1/sessions/${sessionId}/export`, remoteAddress: USER_IP });
    expect(restartedExport.statusCode).toBe(200);
    expect(matchesExportSchema(restartedExport.json())).toBe(true);
    rmSync(ref, { force: true });
    const missing = await restarted.inject({ method: "GET", url: `/v1/sessions/${sessionId}/export`, remoteAddress: USER_IP });
    expect(missing.statusCode).toBe(500);
    const getExport = (openapiV1 as unknown as { paths: { "/v1/sessions/{id}/export": { get: { responses: Record<string, unknown> } } } })
      .paths["/v1/sessions/{id}/export"].get;
    expect(getExport.responses["500"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
    });
    expect(missing.json()).toMatchObject({ statusCode: 500, error: "Internal Server Error" });
    expect(JSON.stringify(missing.json())).not.toContain(ref);
    expect(adapterCreations).toBe(0);
  });
});
