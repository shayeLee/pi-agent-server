// 编译型测试：确保 SessionRuntime 显式实现 SessionRuntimePort + RuntimeLifecyclePort，
// 以及 SessionEntry.runtime 的类型约束（端口而非具体类）。
import { describe, it, expectTypeOf } from "vitest";
import type { SessionRuntime } from "../../src/runtime/session-runtime.js";
import type { SessionEntry } from "../../src/runtime/runtime-registry.js";
import type { SqliteSessionRepository } from "../../src/storage/sqlite-session-repository.js";
import type { SqliteProjectRepository } from "../../src/storage/sqlite-project-repository.js";
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
  CredentialPort,
} from "../../src/application/ports/index.js";

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
    expectTypeOf<SqliteSessionRepository>().toMatchTypeOf<SessionStorePort>();
    expectTypeOf<SqliteProjectRepository>().toMatchTypeOf<ProjectStorePort>();
  });

  it("SessionStorePort 的 update 使用正式 patch 类型", () => {
    expectTypeOf<Parameters<SessionStorePort["update"]>[1]>().toEqualTypeOf<SessionRecordPatch>();
  });

  it("DEFAULT_PROJECT_ID 为固定合法 UUID 字面量", () => {
    expectTypeOf<typeof DEFAULT_PROJECT_ID>().toEqualTypeOf<
      "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c"
    >();
  });
});
