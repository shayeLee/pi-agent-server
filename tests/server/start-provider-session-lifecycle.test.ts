// 显式 provider 扩展 + 会话生命周期（真实 startServer composition root，全离线）：
//
// 本文件用**真实 SDK**（真实 createAgentSession / 真实 Pi JSONL session 文件 / 真实 HTTP 路由）
// 搭一个不触网的服务：provider 扩展注册一个 `streamSimple` stub provider，因此整轮对话在进程内
// 完成，不需要任何真实模型请求或凭据。覆盖用户明确要求的四点：
//
// 1. 真实会话打开 + 真正恢复冻结 session：新建会话跑一轮 → 关闭进程 → 重启 → 同一会话再跑一轮，
//    断言两轮都经扩展的 provider stub 完成，且**恢复后的系统提示词与冻结快照逐字节一致**
//    （字面量 override：绝不重新解析、绝不重复追加能力片段）；
// 2. 每个独立活动 session 有独立 DefaultResourceLoader/扩展 runtime：两个会话各自跑一轮都成功；
//    dispose 会话 A（DELETE）后会话 B 仍可用；
// 3. 启动/项目提示词探针独立 loader：探针会话 dispose 后其扩展 runtime 被 SDK 标记 stale，但
//    后续真实会话拿到的 API 仍 active（共享 loader 会让真实会话直接失效）；
// 4. 扩展模块级副作用只发生一次：同一 cwd 下新建 loader 首次 reload 复用模块缓存，模块求值计数
//    不随会话数增长。
//
// 计数/标记经 `globalThis.__piProviderProbe` 由扩展模块写入（扩展与测试同进程）。

import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type StartConfig } from "../../src/server/start.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";

const STUB_PROVIDER = "fixture-stub-provider";
const STUB_MODEL = "fixture-stub-model";
const STUB_REPLY = "stub-reply-ok";
/** 扩展自报的“凭证”：任何宿主错误消息都不得包含它。 */
const SYNTHETIC_SECRET = "SYNTHETIC-SECRET-9c1f4a";
/** 能力提示词片段标记：用于证明恢复时没有重复追加。 */
const FRAGMENT_MARKER = "FRAGMENT-MARKER-7b2e";

type ProviderExtensionProbe = {
  /** 每次扩展工厂运行对应的 ExtensionAPI（每个 loader 一次）。 */
  readonly apis: Array<{ registerProvider: (name: string, config: unknown) => void }>;
  /** `before_agent_start` 观察到的完整系统提示词（每轮一次）。 */
  readonly systemPrompts: string[];
  /** `before_provider_request` 触发次数。 */
  providerRequestCount: number;
  /** 扩展**模块**求值次数（模块级副作用计数）。 */
  moduleEvaluations: number;
  /**
   * fetch 包装次数：模块每次求值就模拟在 `globalThis.fetch` 上再包一层
   * （WorkBuddy 的真实模块级副作用）。用于证明 cwd 交替不会重复包装。
   * 这里只计数、不真改 `globalThis.fetch`，避免污染同进程其它测试。
   */
  fetchWrapperInstalls: number;
  /** provider 注册次数（工厂函数重跑计数）。 */
  providerRegistrations: number;
};

function probe(): ProviderExtensionProbe {
  const value = (globalThis as Record<string, unknown>).__piProviderProbe as ProviderExtensionProbe | undefined;
  if (!value) throw new Error("provider extension probe was not installed");
  return value;
}

function resetProbe(): void {
  (globalThis as Record<string, unknown>).__piProviderProbe = {
    apis: [],
    systemPrompts: [],
    providerRequestCount: 0,
    moduleEvaluations: 0,
    fetchWrapperInstalls: 0,
    providerRegistrations: 0,
  } satisfies ProviderExtensionProbe;
}

/** 扩展 API 是否仍 active：SDK 在 session dispose 后 invalidate 该 loader 的 runtime。 */
function apiIsActive(api: ProviderExtensionProbe["apis"][number]): boolean {
  try {
    api.registerProvider("__probe_liveness__", {
      baseUrl: "https://fixture.invalid/v1",
      apiKey: "k",
      api: "openai-completions",
      models: [],
    });
    return true;
  } catch {
    return false;
  }
}

const cleanups: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => {})));
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__piProviderProbe;
  delete (globalThis as Record<string, unknown>).__piFailbackProbe;
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

async function createBaseline(dbPath: string): Promise<void> {
  const db = new DatabaseSync(dbPath);
  try {
    await runSqliteMigrations(db);
  } finally {
    db.close();
  }
}

/**
 * 写一个 provider 扩展：注册 `streamSimple` stub provider（进程内完成一轮，不触网），
 * 并挂 provider/agent hook 与模块级/工厂级计数器。
 */
function writeStubProviderExtension(root: string): string {
  const extensionDir = join(root, "stub-provider-extension");
  mkdirSync(join(extensionDir, "extensions"), { recursive: true });
  writeFileSync(join(extensionDir, "package.json"), JSON.stringify({
    name: "pi-provider-extension-stub-fixture",
    version: "1.0.0",
    type: "module",
    pi: { extensions: ["./extensions"] },
  }));
  writeFileSync(join(extensionDir, "extensions", "provider.ts"), `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const PROBE_KEY = "__piProviderProbe";
// 每次都读当前对象：模块可能被缓存复用（同 cwd 不重新求值），而测试会在每个用例前重置探针。
function probeState() {
  const existing = globalThis[PROBE_KEY];
  if (existing) return existing;
  const created = {
    apis: [], systemPrompts: [], providerRequestCount: 0, moduleEvaluations: 0, fetchWrapperInstalls: 0, providerRegistrations: 0,
  };
  globalThis[PROBE_KEY] = created;
  return created;
}
// 模块级副作用：只有模块被真正重新求值（cache miss）时才 +1；
// fetchWrapperInstalls 模拟 WorkBuddy 在 globalThis.fetch 上再包一层（这里只计数，不改真实 fetch）。
probeState().moduleEvaluations += 1;
probeState().fetchWrapperInstalls += 1;

const STUB_REPLY = ${JSON.stringify(STUB_REPLY)};
const SECRET = ${JSON.stringify(SYNTHETIC_SECRET)};

function stubMessage(model, text, stopReason) {
  return {
    role: "assistant",
    content: text === null ? [] : [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  };
}

export default function (pi) {
  probeState().apis.push(pi);
  probeState().providerRegistrations += 1;
  pi.registerProvider(${JSON.stringify(STUB_PROVIDER)}, {
    name: "Fixture Stub Provider",
    baseUrl: "https://fixture.invalid/v1",
    // 合成凭证：只存在于扩展内，宿主错误消息一律不得回显。
    apiKey: SECRET,
    api: "fixture-stub-api",
    models: [{
      id: ${JSON.stringify(STUB_MODEL)},
      name: "Fixture Stub Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }],
    // 真实会话的 streamFn 会转发 onPayload（Pi 的 provider hook 通道），因此这里能看到扩展注册的
    // before_provider_request hook 是否真的挂在当前 session 的 runner 上。
    async streamSimple(model, context, options) {
      await options?.onPayload?.({ messages: context.messages }, model);
      const failback = globalThis.__piFailbackProbe;
      if (failback) {
        failback.events.push("start");
        pi.events.emit("model-failback:lifecycle", { version: 1, phase: "start", attemptId: failback.attemptId, sessionId: "stub-session" });
        await failback.releaseStart;
        failback.events.push("end");
        pi.events.emit("model-failback:lifecycle", { version: 1, phase: "end", attemptId: failback.attemptId, sessionId: "stub-session", outcome: "switched" });
        await failback.releaseEnd;
      }
      const stream = createAssistantMessageEventStream();
      const start = stubMessage(model, null, "pending");
      const textPartial = stubMessage(model, "", "pending");
      const done = stubMessage(model, STUB_REPLY, "stop");
      stream.push({ type: "start", partial: start });
      stream.push({ type: "text_start", contentIndex: 0, partial: textPartial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: STUB_REPLY, partial: textPartial });
      stream.push({ type: "text_end", contentIndex: 0, content: STUB_REPLY, partial: done });
      stream.push({ type: "done", reason: "stop", message: done });
      stream.end(done);
      return stream;
    },
  });
  pi.on("before_agent_start", (event) => {
    probeState().systemPrompts.push(event.systemPrompt);
  });
  pi.on("before_provider_request", (event) => {
    probeState().providerRequestCount += 1;
    return event.payload;
  });
}
`);
  return extensionDir;
}

type Fixture = {
  readonly root: string;
  readonly extensionDir: string;
  readonly dbPath: string;
};

async function makeFixture(prefix: string): Promise<Fixture> {
  const root = makeTempDir(prefix);
  const extensionDir = writeStubProviderExtension(root);
  const dbPath = join(root, "pi-agent-server.db");
  await createBaseline(dbPath);
  return { root, extensionDir, dbPath };
}

function baseConfig(fixture: Fixture, overrides: Partial<StartConfig> = {}): StartConfig {
  return {
    port: 0,
    ipAccess: makeTestIpAccess(),
    dataDir: fixture.root,
    authPath: join(fixture.root, "auth.json"),
    dbPath: fixture.dbPath,
    providerExtensionPaths: [fixture.extensionDir],
    defaultModel: { provider: STUB_PROVIDER, id: STUB_MODEL },
    // 能力提示词片段：验证恢复时绝不再追加。
    plugins: [{
      manifest: {
        id: "fixture-capability",
        version: 1,
        promptFragments: [{ inline: FRAGMENT_MARKER }],
      },
      tools: [],
    }],
    ...overrides,
  };
}

async function startFixture(fixture: Fixture, overrides: Partial<StartConfig> = {}): Promise<FastifyInstance> {
  const app = await startServer(baseConfig(fixture, overrides));
  apps.push(app);
  return app;
}

const JSON_HEADERS = { "content-type": "application/json" };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

async function createSession(app: FastifyInstance, title: string): Promise<{ id: string; systemPrompt: string }> {
  const response = await app.inject({ method: "POST", url: "/v1/sessions", payload: { title } });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { id: string; systemPrompt: string };
  expect(body.systemPrompt).toBeTruthy();
  return body;
}

/** 提交一轮并等到助手消息落进 JSONL（导出可见）。 */
async function runTurn(app: FastifyInstance, sessionId: string, requestId: string, prompt: string): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: `/v1/sessions/${sessionId}/messages`,
    headers: JSON_HEADERS,
    payload: { requestId, prompt },
  });
  expect(response.statusCode).toBe(202);
  await waitForAssistant(app, sessionId);
}

async function waitForAssistant(app: FastifyInstance, sessionId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const exported = await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}/export` });
    if (exported.statusCode === 200) {
      const messages = (exported.json() as { messages: Array<{ role: string; text: string }> }).messages;
      if (messages.some((message) => message.role === "assistant" && message.text === STUB_REPLY)) return;
    }
    if (Date.now() > deadline) throw new Error("stub provider turn did not complete");
    await settle();
  }
}

async function exportedMessages(app: FastifyInstance, sessionId: string): Promise<Array<{ role: string; text: string }>> {
  const exported = await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}/export` });
  expect(exported.statusCode).toBe(200);
  return (exported.json() as { messages: Array<{ role: string; text: string }> }).messages
    .map(({ role, text }) => ({ role, text }));
}

type FailbackProbe = {
  attemptId: string;
  events: string[];
  releaseStart: Promise<void>;
  releaseEnd: Promise<void>;
  openStart(): void;
  openEnd(): void;
};

function installFailbackProbe(): FailbackProbe {
  let openStart!: () => void;
  let openEnd!: () => void;
  const probe: FailbackProbe = {
    attemptId: "offline-attempt-1",
    events: [],
    releaseStart: new Promise<void>((resolve) => { openStart = resolve; }),
    releaseEnd: new Promise<void>((resolve) => { openEnd = resolve; }),
    openStart: () => openStart(),
    openEnd: () => openEnd(),
  };
  (globalThis as Record<string, unknown>).__piFailbackProbe = probe;
  return probe;
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await settle();
  }
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("显式 provider 扩展：真实会话打开、恢复与 loader 隔离（全离线 stub provider）", () => {
  it("新建会话经扩展 provider stub 完成真实一轮；探针 loader 的 dispose 不污染该会话", async () => {
    resetProbe();
    const fixture = await makeFixture("pi-provider-session-new-");
    // 启动探针（默认模型/提示词解析）用一个一次性 loader；它随后被 dispose。
    const app = await startFixture(fixture);
    const startup = probe();
    expect(startup.providerRegistrations).toBe(1);
    expect(startup.systemPrompts).toEqual([]); // 探针会话未绑定 extension UI 上下文，不触发 before_agent_start
    expect(apiIsActive(startup.apis[0]!)).toBe(false); // 探针 runtime 已被 dispose 标记 stale

    const models = await app.inject({ method: "GET", url: "/v1/models" });
    expect(models.statusCode).toBe(200);
    const catalog = models.json() as { models: Array<{ provider: string; id: string }>; defaultModel: { provider: string; id: string } | null };
    expect(catalog.models.some((model) => model.provider === STUB_PROVIDER && model.id === STUB_MODEL)).toBe(true);
    expect(catalog.defaultModel).toEqual(expect.objectContaining({ provider: STUB_PROVIDER, id: STUB_MODEL }));

    const session = await createSession(app, "with-extensions");
    await runTurn(app, session.id, "r1", "hello");

    expect(await exportedMessages(app, session.id)).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: STUB_REPLY },
    ]);
    // 真实会话拿到的是**自己的** loader：扩展 factory 重跑一次，其 API 仍 active。
    expect(startup.providerRegistrations).toBe(2);
    expect(apiIsActive(startup.apis[1]!)).toBe(true);
    // provider hook 真的挂在该会话的 runner 上（stub streamFn 经 onPayload 转发）。
    expect(startup.providerRequestCount).toBe(1);
    // 冻结快照：能力片段只出现一次（不重复追加）。
    expect(occurrences(session.systemPrompt, FRAGMENT_MARKER)).toBe(1);
  });

  it("真正恢复冻结 session：重启后继续一轮，扩展 provider 可用且提示词不重复追加", async () => {
    resetProbe();
    const fixture = await makeFixture("pi-provider-session-restore-");
    const first = await startFixture(fixture);
    const session = await createSession(first, "frozen");
    const frozenPrompt = session.systemPrompt;
    await runTurn(first, session.id, "r1", "first");
    // 关闭第一个进程实例（runtime/adapter 全部 dispose）。
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const moduleEvaluationsAfterFirst = probe().moduleEvaluations;
    const second = await startFixture(fixture);
    // 第二个进程实例的启动探针同样用一次性 loader；模块缓存复用（同 cwd 不重新求值）。
    expect(probe().moduleEvaluations).toBe(moduleEvaluationsAfterFirst);

    // 恢复：同一 sessionId，无 runtime，必须经 createAdapter → factory.restore 打开 JSONL。
    const beforeRestore = probe().systemPrompts.length;
    await runTurn(second, session.id, "r2", "second");
    expect(await exportedMessages(second, session.id)).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: STUB_REPLY },
      { role: "user", text: "second" },
      { role: "assistant", text: STUB_REPLY },
    ]);

    const restoredPrompt = probe().systemPrompts.at(-1);
    expect(restoredPrompt).toBeDefined();
    // 恢复后的完整提示词 = 冻结快照字面量 + SDK 在同一轮里追加的 cwd 段：既没有重新解析
    // （否则片段会再次出现），也没有再次追加能力片段。
    expect(restoredPrompt!.startsWith(frozenPrompt)).toBe(true);
    expect(restoredPrompt!.slice(frozenPrompt.length)).toMatch(/^\n\n<cwd>\n/);
    expect(occurrences(restoredPrompt!, FRAGMENT_MARKER)).toBe(1);
    expect(probe().systemPrompts.length).toBe(beforeRestore + 1);
    // 恢复会话的扩展 hook 同样生效。
    expect(probe().providerRequestCount).toBeGreaterThan(0);
  });

  it("两个会话各有独立 loader/runtime：dispose 会话 A 后会话 B 仍可继续", async () => {
    resetProbe();
    const fixture = await makeFixture("pi-provider-session-isolation-");
    const app = await startFixture(fixture);

    const sessionA = await createSession(app, "A");
    const sessionB = await createSession(app, "B");
    await runTurn(app, sessionA.id, "ra1", "a-first");
    await runTurn(app, sessionB.id, "rb1", "b-first");

    // 每个活动会话一个 loader：探针 + A + B。
    const snapshot = probe();
    expect(snapshot.providerRegistrations).toBe(3);
    const [probeApi, apiA, apiB] = snapshot.apis;
    expect(apiIsActive(probeApi!)).toBe(false);
    expect(apiIsActive(apiA!)).toBe(true);
    expect(apiIsActive(apiB!)).toBe(true);
    expect(apiA).not.toBe(apiB);

    // dispose A（DELETE 会 abort/dispose A 的 runtime 与 adapter）后 B 必须仍然可用。
    const deleted = await app.inject({ method: "DELETE", url: `/v1/sessions/${sessionA.id}` });
    expect(deleted.statusCode).toBe(204);
    expect(apiIsActive(apiA!)).toBe(false);
    expect(apiIsActive(apiB!)).toBe(true);

    await runTurn(app, sessionB.id, "rb2", "b-second");
    expect(await exportedMessages(app, sessionB.id)).toEqual([
      { role: "user", text: "b-first" },
      { role: "assistant", text: STUB_REPLY },
      { role: "user", text: "b-second" },
      { role: "assistant", text: STUB_REPLY },
    ]);
    // B 的 loader 从未被重建（同一 session 多轮复用），也没有被 A 的 dispose 影响。
    expect(probe().providerRegistrations).toBe(3);
  });

  it("同一会话多轮复用同一 loader（不按轮次重建，也不重跑扩展工厂）", async () => {
    resetProbe();
    const fixture = await makeFixture("pi-provider-session-reuse-");
    const app = await startFixture(fixture);
    const session = await createSession(app, "reuse");
    await runTurn(app, session.id, "r1", "one");
    await runTurn(app, session.id, "r2", "two");
    await runTurn(app, session.id, "r3", "three");
    // 探针 + 该会话 = 恰好 2 次工厂运行；3 轮对话都复用同一 session loader。
    expect(probe().providerRegistrations).toBe(2);
    expect(probe().providerRequestCount).toBe(3);
    expect((await exportedMessages(app, session.id)).filter((m) => m.role === "assistant")).toHaveLength(3);
  });

  it("跨 cwd 交替（服务/多个项目/真实会话）不清扩展模块缓存，模块级 fetch 包装只发生一次", async () => {
    resetProbe();
    const fixture = await makeFixture("pi-provider-session-cwd-");
    // 两个不同 cwd 的项目：创建会话时 SystemPromptPort 会为它们各构造一个一次性探针 loader。
    const projectCwds = [join(fixture.root, "project-a"), join(fixture.root, "project-b")];
    for (const dir of projectCwds) mkdirSync(dir, { recursive: true });
    // 显式指定服务 cwd，使默认项目的预期提示词 cwd 确定（不影响其它用例）。
    const app = await startFixture(fixture, { cwd: fixture.root });

    // 交替序列：默认项目（服务 cwd）→ 项目 A → 默认项目 → 项目 B → 默认项目。
    // 每一步都会构造一个新 loader；若扩展加载 cwd 跟着项目 cwd 交替，SDK 会清缓存、重放模块级副作用。
    const createInProject = async (projectCwd: string | null, title: string) => {
      const payload: { title: string; projectId?: string } = { title };
      if (projectCwd !== null) {
        const project = await app.inject({ method: "POST", url: "/v1/projects", payload: { name: title, cwd: projectCwd } });
        expect(project.statusCode).toBe(201);
        payload.projectId = (project.json() as { id: string }).id;
      }
      const response = await app.inject({ method: "POST", url: "/v1/sessions", payload });
      expect(response.statusCode).toBe(201);
      const session = response.json() as { id: string; systemPrompt: string };
      // 每个项目 cwd 的提示词冻结快照必须包含该项目自己的 cwd（项目提示词解析未被篡改）。
      const expectedCwd = projectCwd ?? fixture.root;
      expect(session.systemPrompt).toContain(`<cwd>\n${expectedCwd}\n</cwd>`);
      return session;
    };

    const sessions = [
      await createInProject(null, "s-default-1"),
      await createInProject(projectCwds[0]!, "s-a"),
      await createInProject(null, "s-default-2"),
      await createInProject(projectCwds[1]!, "s-b"),
      await createInProject(null, "s-default-3"),
    ];    for (const [index, session] of sessions.entries()) {
      await runTurn(app, session.id, `rc${index}`, `turn-${index}`);
    }

    // 扩展模块整进程只求值一次；fetch 包装（模块级副作用）只发生一次；工厂函数按 loader 数重跑。
    expect(probe().moduleEvaluations).toBe(1);
    expect(probe().fetchWrapperInstalls).toBe(1);
    // 每个活动会话都持有可用的扩展 runtime（未被其它探针/session 的 dispose 污染）。
    const apis = probe().apis;
    expect(apis.length).toBeGreaterThanOrEqual(sessions.length);
    expect(apis.slice(-sessions.length).every((api) => apiIsActive(api))).toBe(true);
  });

  it("冻结字面量恢复不被 agentDir/APPEND_SYSTEM.md 自动发现污染（文件改前改后均不变）", async () => {
    resetProbe();
    const fixture = await makeFixture("pi-provider-session-append-");
    // agentDir 由 startServer 固定为 dataDir/.pi-agent；写入 APPEND_SYSTEM.md 作为自动发现诱饵。
    const agentDir = join(fixture.root, ".pi-agent");
    mkdirSync(agentDir, { recursive: true });
    const appendPath = join(agentDir, "APPEND_SYSTEM.md");
    writeFileSync(appendPath, "APPEND-BEFORE-MARKER");

    const first = await startFixture(fixture);
    const session = await createSession(first, "frozen-append");
    const frozenPrompt = session.systemPrompt;
    expect(frozenPrompt).not.toContain("APPEND-BEFORE-MARKER");
    await runTurn(first, session.id, "r1", "first");
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    // 冻结后把诱饵文件改成另一个标记，再重启恢复：恢复仍必须是字面量，不得追加任何磁盘内容。
    writeFileSync(appendPath, "APPEND-AFTER-MARKER");
    const second = await startFixture(fixture);
    await runTurn(second, session.id, "r2", "second");

    const restoredPrompt = probe().systemPrompts.at(-1);
    expect(restoredPrompt).toBeDefined();
    expect(restoredPrompt!.startsWith(frozenPrompt)).toBe(true);
    expect(restoredPrompt!).not.toContain("APPEND-BEFORE-MARKER");
    expect(restoredPrompt!).not.toContain("APPEND-AFTER-MARKER");
    // 恢复提示词 = 冻结字面量 + SDK 在同一轮追加的 cwd 段（与既有冻结语义一致）。
    expect(restoredPrompt!.slice(frozenPrompt.length)).toMatch(/^\n\n<cwd>\n/);
  });

  it("model-failback EventBus 在真实 SDK 会话中锁定用户 abort、end 后解锁，且删除强制取消不被锁挡住", async () => {
    resetProbe();
    const fixture = await makeFixture("pi-provider-failback-lifecycle-");
    const app = await startFixture(fixture);
    const failback = installFailbackProbe();
    const sessionA = await createSession(app, "failback-A");
    const sessionB = await createSession(app, "failback-B");

    const acceptedA = await app.inject({ method: "POST", url: `/v1/sessions/${sessionA.id}/messages`, headers: JSON_HEADERS, payload: { requestId: "a1", prompt: "trigger" } });
    expect(acceptedA.statusCode).toBe(202);
    await waitFor(() => failback.events.includes("start"), "failback start");
    // 锁只属于 A/a1：同一会话用户 abort 为 409，另一 session 仍能接受自己的请求。
    const lockedAbort = await app.inject({ method: "POST", url: `/v1/sessions/${sessionA.id}/abort`, headers: JSON_HEADERS, payload: { requestId: "a1" } });
    expect(lockedAbort.statusCode).toBe(409);
    const acceptedB = await app.inject({ method: "POST", url: `/v1/sessions/${sessionB.id}/messages`, headers: JSON_HEADERS, payload: { requestId: "b1", prompt: "other session" } });
    expect(acceptedB.statusCode).toBe(202);

    failback.openStart();
    await waitFor(() => failback.events.includes("end"), "failback end");
    // end 是扩展已完成安全接续决策的边界；此后用户 abort 恢复正常。
    const unlockedAbort = app.inject({ method: "POST", url: `/v1/sessions/${sessionA.id}/abort`, headers: JSON_HEADERS, payload: { requestId: "a1" } });
    // 先让 HTTP handler 进入 abort（其同步阶段把 runtime 标记 terminal），再放开忽略 signal 的 stub。
    await settle();
    failback.openEnd();
    expect((await unlockedAbort).statusCode).toBe(204);

    // A 已取消不会自动续跑；B 的生命周期锁不影响删除强制路径。
    await waitFor(() => failback.events.filter((event) => event === "start").length >= 2, "session B failback start");
    const deletedB = await app.inject({ method: "DELETE", url: `/v1/sessions/${sessionB.id}` });
    expect(deletedB.statusCode).toBe(204);
    failback.openStart();
    failback.openEnd();
    await settle();
    expect(failback.events.filter((event) => event === "start")).toHaveLength(2);
  });

  it("扩展加载/注册失败的错误与启动失败都不回显合成凭证，且启动失败不留下会话产物", async () => {
    resetProbe();
    const root = makeTempDir("pi-provider-session-secret-");
    const extensionDir = join(root, "secret-extension");
    mkdirSync(join(extensionDir, "extensions"), { recursive: true });
    writeFileSync(join(extensionDir, "package.json"), JSON.stringify({
      name: "pi-provider-extension-secret-fixture",
      version: "1.0.0",
      type: "module",
      pi: { extensions: ["./extensions"] },
    }));
    // 模块加载即抛错，错误文本里带合成凭证；宿主只回显自己配置的路径。
    writeFileSync(
      join(extensionDir, "extensions", "bad.ts"),
      `throw new Error(${JSON.stringify(`boom apiKey=${SYNTHETIC_SECRET}`)});\n`,
    );
    const dbPath = join(root, "pi-agent-server.db");
    await createBaseline(dbPath);
    const config: StartConfig = {
      port: 0,
      ipAccess: makeTestIpAccess(),
      dataDir: root,
      authPath: join(root, "auth.json"),
      dbPath,
      providerExtensionPaths: [extensionDir],
    };

    let message = "";
    try {
      await startServer(config);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      expect((error as Error).cause).toBeUndefined();
    }
    expect(message).toMatch(/extension failed to load/);
    expect(message).toContain(extensionDir);
    expect(message).not.toContain(SYNTHETIC_SECRET);
    expect(message).not.toContain("boom");
    expect(message).not.toMatch(/apiKey/i);
    // 拒绝发生在 provider 扩展加载阶段：不产生会话/项目目录等宿主持久化产物。
    expect(readdirSync(root).filter((entry) => entry === "sessions" || entry === "projects")).toEqual([]);
  });
});
