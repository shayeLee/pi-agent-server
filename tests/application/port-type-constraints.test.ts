// 编译型测试：确保 SessionRuntime 显式实现 SessionRuntimePort + RuntimeLifecyclePort，
// 以及 SessionEntry.runtime 的类型约束（端口而非具体类）。
import { describe, it, expect, expectTypeOf } from "vitest";
import type { SessionRuntime } from "../../src/runtime/session-runtime.js";
import type { SessionEntry } from "../../src/runtime/runtime-registry.js";
import type { KyselySessionRepository } from "../../src/storage/kysely-session-repository.js";
import type { KyselyProjectRepository } from "../../src/storage/kysely-project-repository.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import type {
  IdempotencyStorePort,
  ManagedSessionRuntimePort,
  ModelCatalogPort,
  ModelDescriptor,
  ProjectStorePort,
  SessionRecordPatch,
  SessionRuntimePort,
  SessionStorePort,
  RuntimeLifecyclePort,
  SubmitDecision,
  ControlDecision,
  SubmitInput,
  RunTurnInput,
  CredentialPort,
} from "../../src/application/ports/index.js";
import { TURN_ERROR_CODES } from "../../src/application/ports/session-runtime-port.js";
import { PLUGIN_RUN_TURN_LIMITS } from "../../src/plugin/index.js";
import type { LoadedPlugin, PluginModeProfile } from "../../src/plugin/index.js";
import { TURN_TEXT_LIMITS } from "../../src/core/text-input.js";

describe("端口类型约束（编译型）", () => {
  it("SessionRuntime 实现 SessionRuntimePort", () => {
    // 结构化子类型：SessionRuntime 的公开 API 至少包含 SessionRuntimePort 的所有成员
    expectTypeOf<SessionRuntime>().toMatchTypeOf<SessionRuntimePort>();
  });

  it("SessionRuntime 实现 RuntimeLifecyclePort", () => {
    expectTypeOf<SessionRuntime>().toMatchTypeOf<RuntimeLifecyclePort>();
  });

  it("SessionEntry.runtime 的类型为 SessionRuntimePort（非具体类）", () => {
    // SessionEntry 的 runtime 字段必须是 SessionRuntimePort，不能是 SessionRuntime
    expectTypeOf<SessionEntry["runtime"]>().toMatchTypeOf<SessionRuntimePort>();
  });

  it("SubmitDecision 判别联合覆盖所有 kind", () => {
    expectTypeOf<SubmitDecision["kind"]>().toEqualTypeOf<
      "run" | "queued" | "rejected" | "conflict" | "done"
    >();
  });

  it("ControlDecision 判别联合覆盖 ok / conflict", () => {
    expectTypeOf<ControlDecision["kind"]>().toEqualTypeOf<"ok" | "conflict">();
  });

  it("abort 支持可选的 requestId 精确关联参数", () => {
    expectTypeOf<Parameters<SessionRuntimePort["abort"]>>().toEqualTypeOf<[expectedRequestId?: string]>();
  });

  it("SubmitInput 包含所有必要字段", () => {
    expectTypeOf<SubmitInput>().toHaveProperty("requestId");
    expectTypeOf<SubmitInput>().toHaveProperty("userId");
    expectTypeOf<SubmitInput>().toHaveProperty("prompt");
  });

  it("SessionRuntimePort 包含所有应用层方法", () => {
    expectTypeOf<SessionRuntimePort>().toHaveProperty("submitMessage");
    expectTypeOf<SessionRuntimePort>().toHaveProperty("steer");
    expectTypeOf<SessionRuntimePort>().toHaveProperty("followUp");
    expectTypeOf<SessionRuntimePort>().toHaveProperty("abort");
    expectTypeOf<SessionRuntimePort>().toHaveProperty("runTurn");
    expectTypeOf<SessionRuntimePort>().toHaveProperty("exportSession");
    expectTypeOf<SessionRuntimePort>().toHaveProperty("setModel");
    expectTypeOf<SessionRuntimePort>().toHaveProperty("setThinkingLevel");
    expectTypeOf<SessionRuntimePort>().toHaveProperty("state");
    expectTypeOf<SessionRuntimePort>().toHaveProperty("sessionId");
  });

  it("RuntimeLifecyclePort 包含生命周期方法", () => {
    expectTypeOf<RuntimeLifecyclePort>().toHaveProperty("dispose");
    expectTypeOf<RuntimeLifecyclePort>().toHaveProperty("pruneIdempotency");
  });

  it("ManagedSessionRuntimePort 扩展 RuntimeLifecyclePort", () => {
    expectTypeOf<ManagedSessionRuntimePort>().toMatchTypeOf<RuntimeLifecyclePort>();
  });

  it("IdempotencyStorePort 包含 get/put/prune 方法", () => {
    expectTypeOf<IdempotencyStorePort>().toHaveProperty("get");
    expectTypeOf<IdempotencyStorePort>().toHaveProperty("put");
    expectTypeOf<IdempotencyStorePort>().toHaveProperty("prune");
  });

  it("CredentialPort 仅暴露运行时 key 注入与凭证校验", () => {
    expectTypeOf<keyof CredentialPort>().toEqualTypeOf<
      "setRuntimeApiKey" | "hasConfiguredAuth"
    >();
    expectTypeOf<CredentialPort>().toHaveProperty("setRuntimeApiKey");
    expectTypeOf<CredentialPort>().toHaveProperty("hasConfiguredAuth");
    expectTypeOf<Parameters<CredentialPort["setRuntimeApiKey"]>>().toEqualTypeOf<
      [provider: string, apiKey: string]
    >();
    expectTypeOf<ReturnType<CredentialPort["setRuntimeApiKey"]>>().toEqualTypeOf<
      Promise<void>
    >();
    expectTypeOf<ReturnType<CredentialPort["hasConfiguredAuth"]>>().toEqualTypeOf<boolean>();
  });

  it("ModelCatalogPort 返回正式 ModelDescriptor 合约", () => {
    expectTypeOf<ModelCatalogPort>().toHaveProperty("getAvailable");
    expectTypeOf<Awaited<ReturnType<ModelCatalogPort["getAvailable"]>>>().toEqualTypeOf<
      readonly ModelDescriptor[]
    >();
    expectTypeOf<ModelDescriptor>().toHaveProperty("provider");
    expectTypeOf<ModelDescriptor>().toHaveProperty("id");
    expectTypeOf<ModelDescriptor>().toHaveProperty("name");
  });

  it("SQLite adapters 实现 SessionStorePort / ProjectStorePort", () => {
    expectTypeOf<KyselySessionRepository>().toMatchTypeOf<SessionStorePort>();
    expectTypeOf<KyselyProjectRepository>().toMatchTypeOf<ProjectStorePort>();
  });

  it("SessionStorePort 的 update 使用正式 patch 类型", () => {
    expectTypeOf<Parameters<SessionStorePort["update"]>[1]>().toEqualTypeOf<SessionRecordPatch>();
  });

  it("DEFAULT_PROJECT_ID 为固定合法 UUID 字面量", () => {
    expectTypeOf<typeof DEFAULT_PROJECT_ID>().toEqualTypeOf<
      "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c"
    >();
  });

  it("公开 messages 接口与插件 runTurn 共用同一套文本上限（防止常量漂移）", () => {
    expectTypeOf<typeof TURN_TEXT_LIMITS.maxRequestIdLength>().toEqualTypeOf<
      typeof PLUGIN_RUN_TURN_LIMITS.maxRequestIdLength
    >();
    expect(TURN_TEXT_LIMITS).toEqual({
      maxRequestIdLength: PLUGIN_RUN_TURN_LIMITS.maxRequestIdLength,
      maxPromptLength: PLUGIN_RUN_TURN_LIMITS.maxPromptLength,
    });
  });

  it("runTurn 预算上限与 error code 为稳定字面量（防漂移）", () => {
    expect(PLUGIN_RUN_TURN_LIMITS.maxToolCallsPerTurn).toBe(60);
    expect(PLUGIN_RUN_TURN_LIMITS.maxTurnDurationMs).toBe(300_000);
    expect(TURN_ERROR_CODES).toEqual({
      toolBudget: "turn_tool_budget_exceeded",
      durationBudget: "turn_duration_budget_exceeded",
      assistantTextBudget: "turn_assistant_text_budget_exceeded",
    });
    // runTurn 专属预算与普通聊天轮次无关：RunTurnInput 可选、SubmitInput 无这些字段。
    expectTypeOf<RunTurnInput["maxToolCallsPerTurn"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<RunTurnInput["maxTurnDurationMs"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<keyof SubmitInput>().toEqualTypeOf<
      "requestId" | "userId" | "prompt" | "parentId" | "images"
    >();
  });

  it("PluginModeProfile 的提示词字段为 appendSystemPrompt/systemPrompt 二选一（均可选了）", () => {
    // P7c：追加是宿主通用能力（宿主不感知业务含义），整体覆盖作为兼容路径保留；
    // 两者都是可选字符串，互斥与非空由 loader 与 SessionService 在执行期 fail-closed。
    expectTypeOf<PluginModeProfile["appendSystemPrompt"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PluginModeProfile["systemPrompt"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<keyof PluginModeProfile>().toEqualTypeOf<
      "id" | "modelProvider" | "modelId" | "appendSystemPrompt" | "systemPrompt" | "thinkingLevel"
    >();
  });

  it("空系统提示词覆盖/追加在类型上仍需显式传入字符串（不会被当作已提供）", () => {
    // 编译型：undefined 是「未提供」的唯一表达，空字符串会被 SessionService 拒绝。
    const appendOnly: PluginModeProfile = {
      id: "m",
      modelProvider: "p",
      modelId: "i",
      appendSystemPrompt: "片段",
    };
    const overrideOnly: PluginModeProfile = {
      id: "m",
      modelProvider: "p",
      modelId: "i",
      systemPrompt: "覆盖",
    };
    expect(appendOnly.appendSystemPrompt).toBe("片段");
    expect(overrideOnly.systemPrompt).toBe("覆盖");
  });

  it("LoadedPlugin.modes 直接复用 PluginModeProfile", () => {
    expectTypeOf<LoadedPlugin["modes"]>().toEqualTypeOf<readonly PluginModeProfile[]>();
  });
});
