// WP4C（方案 A 收敛）受控只读引用列表的共享运行时契约（SQLite 与 PostgreSQL 注册同一组）。
// 契约点：纯 SELECT、仅三个标识字段、null 路径保留（= normal unmaterialized，
// 由 analyzer 计数、不判 issue）、确定性升序、零内容字段泄漏、调用不产生任何写入。
// 方言测试文件各自注册（SQLite 始终运行；PG 按 URL 门控）。

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import { KyselyReconcileReferenceRepository } from "../../src/storage/kysely-reconcile-reference-repository.js";
import type { SessionStorePort, SessionRecord } from "../../src/application/ports/session-store-port.js";
import type { ProjectStorePort } from "../../src/application/ports/project-store-port.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";

export interface ReconcileReferenceContractStorage {
  readonly kysely: Kysely<DatabaseSchema>;
  readonly sessions: SessionStorePort;
  readonly projects: ProjectStorePort;
  /** 关闭底层存储（方言测试自持所有权）。 */
  readonly close: () => Promise<void>;
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: randomUUID(),
    ownerKey: "owner-a",
    projectId: DEFAULT_PROJECT_ID,
    title: "保密标题-do-not-leak",
    createdAt: 1000,
    updatedAt: 1000,
    agentKind: "pi",
    conversationFormat: "pi-jsonl-v3",
    conversationRef: null,
    modelProvider: "provider",
    modelId: "model",
    thinkingLevel: "medium",
    systemPrompt: "保密系统提示词-SECRET_PROMPT_MARKER",
    capabilityVersions: null,
    ...overrides,
  };
}

export function defineReconcileReferenceContract(
  suiteName: string,
  makeStorage: () => Promise<ReconcileReferenceContractStorage>,
): void {
  describe(suiteName, () => {
    it("listReconcileReferences 返回每行会话的 sessionId/projectId/conversationRef（含 null），按 id 升序", async () => {
      const storage = await makeStorage();
      try {
        const first = sessionRecord({ conversationRef: "/data/sessions/s1/history.jsonl" });
        const second = sessionRecord({ conversationRef: null });
        await storage.sessions.create(first);
        await storage.sessions.create(second);

        const rows = await new KyselyReconcileReferenceRepository(storage.kysely).listReconcileReferences();
        expect(rows).toHaveLength(2);
        const byId = new Map(rows.map((row) => [row.sessionId, row]));
        expect(byId.get(first.id)).toEqual({ sessionId: first.id, projectId: DEFAULT_PROJECT_ID, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: "/data/sessions/s1/history.jsonl" });
        expect(byId.get(second.id)).toEqual({ sessionId: second.id, projectId: DEFAULT_PROJECT_ID, agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: null });
        // 确定性顺序：id 升序。
        expect(rows.map((row) => row.sessionId)).toEqual([...rows.map((row) => row.sessionId)].sort());
      } finally {
        await storage.close();
      }
    });

    it("引用记录绝不携带任何内容字段（title/systemPrompt/cwd/ownerKey 等）", async () => {
      const storage = await makeStorage();
      try {
        await storage.sessions.create(sessionRecord({ conversationRef: "/data/sessions/s1/history.jsonl" }));
        const rows = await new KyselyReconcileReferenceRepository(storage.kysely).listReconcileReferences();
        const serialized = JSON.stringify(rows);
        expect(serialized).not.toContain("SECRET_PROMPT_MARKER");
        expect(serialized).not.toContain("保密");
        expect(serialized).not.toContain("owner-a");
        expect(serialized).not.toContain("provider");
        expect(Object.keys(rows[0]!)).toEqual(["sessionId", "projectId", "agentKind", "conversationFormat", "conversationRef"]);
      } finally {
        await storage.close();
      }
    });

    it("纯 SELECT：调用前后行数与内容完全不变（零写入）", async () => {
      const storage = await makeStorage();
      try {
        const first = sessionRecord({ conversationRef: "/data/sessions/s1/history.jsonl" });
        await storage.sessions.create(first);
        const before = await storage.sessions.get(first.id);
        const rows = await new KyselyReconcileReferenceRepository(storage.kysely).listReconcileReferences();
        expect(rows).toHaveLength(1);
        const after = await storage.sessions.get(first.id);
        expect(after).toEqual(before);
        expect((await storage.sessions.listByOwner("owner-a"))).toHaveLength(1);
      } finally {
        await storage.close();
      }
    });
  });
}