import { describe, expect, it } from "vitest";
import { SessionConversationCoordinator } from "../../src/application/session-conversation-coordinator.js";
import {
  ConversationStorageRegistry,
  PI_AGENT_KIND,
  PI_CONVERSATION_FORMAT,
  type AgentSessionContext,
  type AgentSessionFactory,
  type ConversationDescriptor,
} from "../../src/application/ports/index.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { DEFAULT_PROJECT_ID, type ProjectStorePort } from "../../src/application/ports/project-store-port.js";
import type { ConversationReservationInput, SessionRecord, SessionRecordPatch, SessionStorePort } from "../../src/application/ports/session-store-port.js";
import type { FileOperationStorePort } from "../../src/application/ports/file-operation-store-port.js";

class MemorySessions implements SessionStorePort {
  readonly records = new Map<string, SessionRecord>();

  async create(record: SessionRecord): Promise<void> { this.records.set(record.id, { ...record }); }
  async get(id: string): Promise<SessionRecord | null> { return this.records.get(id) ?? null; }
  async listByOwner(ownerKey: string): Promise<SessionRecord[]> { return [...this.records.values()].filter((record) => record.ownerKey === ownerKey); }
  async listByProject(ownerKey: string, projectId: string): Promise<SessionRecord[]> {
    return [...this.records.values()].filter((record) => record.ownerKey === ownerKey && record.projectId === projectId);
  }
  async backfillSystemPrompt(): Promise<number> { return 0; }
  async update(id: string, patch: SessionRecordPatch): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) return false;
    this.records.set(id, { ...record, ...patch });
    return true;
  }
  async updateTitleIfEmpty(ownerKey: string, id: string, title: string, updatedAt: number): Promise<SessionRecord | null> {
    const record = this.records.get(id);
    if (!record || record.ownerKey !== ownerKey) return null;
    if (record.title === "") {
      const updated = { ...record, title, updatedAt };
      this.records.set(id, updated);
      return updated;
    }
    return record;
  }
  async reserveConversation(id: string, reservation: ConversationReservationInput): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.conversationRef !== null) return false;
    this.records.set(id, { ...record, conversationRef: reservation.conversationRef });
    return true;
  }
  async commitConversationReservation(id: string, expectedRef: string, actualRef: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.conversationRef !== expectedRef) return false;
    this.records.set(id, { ...record, conversationRef: actualRef });
    return true;
  }
  async releaseConversationReservation(id: string, expectedRef: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.conversationRef !== expectedRef) return false;
    this.records.set(id, { ...record, conversationRef: null });
    return true;
  }
  async delete(id: string): Promise<boolean> { return this.records.delete(id); }
}

const projects: ProjectStorePort = {
  async create() {},
  async get(id) { return id === DEFAULT_PROJECT_ID ? { id, name: "默认项目", cwd: "/workspace", ownerKey: "", createdAt: 0 } : null; },
  async listByOwner() { return []; },
  async delete() { return false; },
  async deleteProjectWithSessions() {},
  async ensureDefaultProject() {},
};

const fileOperations = {
  async enqueue(plan: unknown) { return plan as never; },
} as unknown as FileOperationStorePort;

function record(id = "s1"): SessionRecord {
  return {
    id,
    ownerKey: "owner",
    projectId: DEFAULT_PROJECT_ID,
    title: "session",
    createdAt: 1,
    updatedAt: 1,
    agentKind: PI_AGENT_KIND,
    conversationFormat: PI_CONVERSATION_FORMAT,
    conversationRef: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    systemPrompt: null,
    capabilityVersions: null,
  };
}

function setup(
  sessions: MemorySessions,
  refs: string[],
  actualRefs: string[] = refs,
  createAdapter: () => MockAgentAdapter = () => new MockAgentAdapter(),
): {
  coordinator: SessionConversationCoordinator;
  prepared: () => number;
  opened: () => number;
  restored: () => number;
  prepareContexts: () => readonly AgentSessionContext[];
  restoreContexts: () => readonly AgentSessionContext[];
} {
  let prepareCount = 0;
  let openCount = 0;
  let restoreCount = 0;
  const prepareContexts: AgentSessionContext[] = [];
  const restoreContexts: AgentSessionContext[] = [];
  const factory: AgentSessionFactory = {
    agentKind: PI_AGENT_KIND,
    conversationFormat: PI_CONVERSATION_FORMAT,
    async prepareNew(context) {
      prepareContexts.push(context);
      const ref = refs[prepareCount++] ?? `opaque-${prepareCount}`;
      const conversation = { agentKind: PI_AGENT_KIND, conversationFormat: PI_CONVERSATION_FORMAT, conversationRef: ref } satisfies ConversationDescriptor & { conversationRef: string };
      return {
        proposedConversation: conversation,
        async open() {
          openCount++;
          const actualRef = actualRefs[openCount - 1] ?? ref;
          return {
            adapter: createAdapter(),
            conversation: { agentKind: PI_AGENT_KIND, conversationFormat: PI_CONVERSATION_FORMAT, conversationRef: actualRef },
          };
        },
      };
    },
    async restore(context) {
      restoreContexts.push(context);
      restoreCount++;
      return createAdapter();
    },
  };
  const factories = {
    register() {},
    get() { return factory; },
    require() { return factory; },
  };
  const storage = new ConversationStorageRegistry();
  storage.register({
    agentKind: PI_AGENT_KIND,
    conversationFormat: PI_CONVERSATION_FORMAT,
    async readExport() { return []; },
    planCleanup({ sessionId, projectId, conversation }) {
      if (conversation.conversationRef === null) return null;
      return {
        operationKey: `tombstone:${conversation.conversationRef}`,
        kind: "delete",
        relativePath: "sessions/s1/history.jsonl",
        sessionId,
        projectId,
      };
    },
  });
  return {
    coordinator: new SessionConversationCoordinator({
      sessions,
      projects,
      factories,
      conversationStorage: storage,
      fileOperations,
      defaultProjectCwd: "/workspace",
      dataDir: "/data",
      agentToolConfig: { noTools: "all" },
    }),
    prepared: () => prepareCount,
    opened: () => openCount,
    restored: () => restoreCount,
    prepareContexts: () => prepareContexts,
    restoreContexts: () => restoreContexts,
  };
}

describe("SessionConversationCoordinator", () => {
  it("先 reservation，再打开 Agent Session；已有引用走恢复", async () => {
    const sessions = new MemorySessions();
    await sessions.create(record());
    const state = setup(sessions, ["opaque-s1"]);

    const adapter = await state.coordinator.createAdapter("s1");
    expect(adapter).toBeInstanceOf(MockAgentAdapter);
    expect((await sessions.get("s1"))?.conversationRef).toBe("opaque-s1");
    expect(state.prepared()).toBe(1);
    expect(state.opened()).toBe(1);

    await state.coordinator.createAdapter("s1");
    expect(state.prepared()).toBe(1);
    expect(state.opened()).toBe(1);
    expect(state.restored()).toBe(1);
  });

  it("拒绝 factory 在 reservation 后切换引用，并保留 reservation 作为清理锚点", async () => {
    const sessions = new MemorySessions();
    await sessions.create(record());
    const state = setup(sessions, ["proposal"], ["actual"]);

    await expect(state.coordinator.createAdapter("s1")).rejects.toThrow(/different from its reservation/);
    expect((await sessions.get("s1"))?.conversationRef).toBe("proposal");
    expect(state.opened()).toBe(1);
  });

  it("CAS reservation 失败时复用另一创建者已占用的引用，不覆盖 winner", async () => {
    const sessions = new MemorySessions();
    await sessions.create(record());
    const first = setup(sessions, ["winner"]);
    const second = setup(sessions, ["loser"]);

    await first.coordinator.createAdapter("s1");
    await second.coordinator.createAdapter("s1");

    expect((await sessions.get("s1"))?.conversationRef).toBe("winner");
    expect(first.opened()).toBe(1);
    expect(second.opened()).toBe(0);
    expect(second.restored()).toBe(1);
  });

  it("将 SDK 实际 fallback 配置快照同步到 DB，并在恢复时继续以 JSONL/SDK 为准", async () => {
    class SnapshotAdapter extends MockAgentAdapter {
      snapshot = { modelProvider: "B", modelId: "b", thinkingLevel: "high" };
      listener?: () => void;
      getConfigurationSnapshot() { return this.snapshot; }
      subscribeConfigurationSnapshot(listener: () => void) { this.listener = listener; return () => {}; }
      change() { this.snapshot = { modelProvider: "B", modelId: "b2", thinkingLevel: "max" }; this.listener?.(); }
    }
    const sessions = new MemorySessions();
    await sessions.create({ ...record(), conversationRef: "existing-ref", modelProvider: "A", modelId: "a", thinkingLevel: "low" });
    const adapter = new SnapshotAdapter();
    const state = setup(sessions, [], [], () => adapter);

    await state.coordinator.createAdapter("s1");
    expect(await sessions.get("s1")).toMatchObject({ modelProvider: "B", modelId: "b", thinkingLevel: "high" });
    adapter.change();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await sessions.get("s1")).toMatchObject({ modelProvider: "B", modelId: "b2", thinkingLevel: "max" });
  });

  it("contextOf 把 SessionRecord.systemPrompt 透传给创建与恢复上下文", async () => {
    const sessions = new MemorySessions();
    await sessions.create({ ...record("create"), systemPrompt: "创建提示词" });
    await sessions.create({ ...record("restore"), conversationRef: "existing-ref", systemPrompt: "恢复提示词" });
    const state = setup(sessions, ["opaque-create"]);

    await state.coordinator.createAdapter("create");
    await state.coordinator.createAdapter("restore");

    expect(state.prepareContexts()[0]?.systemPrompt).toBe("创建提示词");
    expect(state.restoreContexts()[0]?.systemPrompt).toBe("恢复提示词");
  });

  it("已冻结的追加快照在恢复时按字面量透传，绝不重新解析或重复追加", async () => {
    const frozen = "Pi 默认完整提示词\n\n插件追加片段";
    const sessions = new MemorySessions();
    await sessions.create({ ...record("restore"), conversationRef: "existing-ref", systemPrompt: frozen });
    const state = setup(sessions, ["opaque-restore"]);

    await state.coordinator.createAdapter("restore");

    // 协调层只搬运快照：不拼接、不再追加，也不清空默认提示词。
    expect(state.restoreContexts()[0]?.systemPrompt).toBe(frozen);
    expect(state.restoreContexts()[0]?.isNewSession).toBe(false);
    expect(state.prepared()).toBe(0);
  });
});

