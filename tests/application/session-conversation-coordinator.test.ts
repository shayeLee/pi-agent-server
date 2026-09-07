import { describe, expect, it } from "vitest";
import { SessionConversationCoordinator } from "../../src/application/session-conversation-coordinator.js";
import {
  ConversationStorageRegistry,
  PI_AGENT_KIND,
  PI_CONVERSATION_FORMAT,
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

function setup(sessions: MemorySessions, refs: string[], actualRefs: string[] = refs): {
  coordinator: SessionConversationCoordinator;
  prepared: () => number;
  opened: () => number;
  restored: () => number;
} {
  let prepareCount = 0;
  let openCount = 0;
  let restoreCount = 0;
  const factory: AgentSessionFactory = {
    agentKind: PI_AGENT_KIND,
    conversationFormat: PI_CONVERSATION_FORMAT,
    async prepareNew() {
      const ref = refs[prepareCount++] ?? `opaque-${prepareCount}`;
      const conversation = { agentKind: PI_AGENT_KIND, conversationFormat: PI_CONVERSATION_FORMAT, conversationRef: ref } satisfies ConversationDescriptor & { conversationRef: string };
      return {
        proposedConversation: conversation,
        async open() {
          openCount++;
          const actualRef = actualRefs[openCount - 1] ?? ref;
          return {
            adapter: new MockAgentAdapter(),
            conversation: { agentKind: PI_AGENT_KIND, conversationFormat: PI_CONVERSATION_FORMAT, conversationRef: actualRef },
          };
        },
      };
    },
    async restore() {
      restoreCount++;
      return new MockAgentAdapter();
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
});

