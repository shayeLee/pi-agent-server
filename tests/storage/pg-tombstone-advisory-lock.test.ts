// tombstone 并发可见性锁（工作包：PG 并发可见性漏洞修复）的**无真实网络**单测。
//
// 目标：reserveConversation 对 file_operations tombstone 的 NOT EXISTS 检查，与
// session/project delete 对同一 artifact delete outbox 的写入，在 PostgreSQL 上必须按
// tombstone operationKey 用同一 transaction-level advisory lock 串行化；SQLite 继续依赖
// withSqliteWriteLock / BEGIN IMMEDIATE。
//
// 本文件用 fake PG Pool/Client（不发起网络）驱动真实 Kysely SQL 路径：
//   - 纯函数 pgTombstoneAdvisoryLockKey：确定性、64 位有符号、不同 operationKey 不同键、
//     且不回显原始路径；
//   - acquireTombstoneAdvisoryXactLock 生成 `pg_advisory_xact_lock($N::bigint)`；
//   - reserveConversation（PG）在条件 update 之前取 advisory lock；
//   - KyselySessionRepository.delete（PG）在 enqueue/delete 之前取 advisory lock；
//   - KyselyProjectRepository 项目删除（PG）对每个非空 ref 的 operationKey 在
//     enqueue/delete 之前取 advisory lock（按 operationKey 排序避免锁反转）。
//
// 真实 PG 的锁语义（串行化 / xact 锁自动释放）由 tests/postgres（PI_TEST_PG_URL 门控）覆盖。

import { describe, it, expect } from "vitest";
import type { Pool } from "pg";
import type { Kysely } from "kysely";
import { createPostgresKysely } from "../../src/storage/postgres-bootstrap.js";
import { KyselySessionRepository } from "../../src/storage/kysely-session-repository.js";
import { KyselyProjectRepository } from "../../src/storage/kysely-project-repository.js";
import { pgConstraintErrorMapper } from "../../src/storage/pg-constraint-errors.js";
import {
  pgTombstoneAdvisoryLockKey,
  acquireTombstoneAdvisoryXactLock,
} from "../../src/storage/pg-advisory-lock.js";
import { artifactDeleteOperationKey } from "../../src/storage/file-operation-policy.js";
import type { FileOperationTransactionWriter } from "../../src/storage/kysely-file-operation-repository.js";
import type { ConversationCleanupPlan } from "../../src/application/ports/conversation-port.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";

/** 会话删除行形态（repository 删除/项目删除读取的列）。 */
interface SessionDeleteRow {
  id: string;
  project_id: string;
  agent_kind: string;
  conversation_format: string;
  conversation_ref: string | null;
}

interface RecordingConfig {
  events: string[];
  sqlTexts?: string[];
  sessionRow?: SessionDeleteRow;
  projectSessionRows?: SessionDeleteRow[];
  updateRowCount?: number;
  deleteRowCount?: number;
}

/**
 * fake PG Pool/Client：把真实 Kysely SQL 按语义记录到 events，并返回使 repository
 * 控制流走得通的伪结果。绝不建立网络连接。
 */
function recordingPgPool(config: RecordingConfig): Pool {
  const client = {
    async query(text: string, _values: unknown[] = []) {
      const sqlText = text.trim();
      config.sqlTexts?.push(sqlText);
      if (/^begin\b/i.test(sqlText)) {
        config.events.push("begin");
        return { command: "BEGIN", rowCount: 0, rows: [] };
      }
      if (/^commit\b/i.test(sqlText)) {
        config.events.push("commit");
        return { command: "COMMIT", rowCount: 0, rows: [] };
      }
      if (/^rollback\b/i.test(sqlText)) {
        config.events.push("rollback");
        return { command: "ROLLBACK", rowCount: 0, rows: [] };
      }
      if (/pg_advisory_xact_lock/i.test(sqlText)) {
        config.events.push("advisory");
        return { command: "SELECT", rowCount: 0, rows: [] };
      }
      if (/update\s+"sessions"/i.test(sqlText)) {
        config.events.push("update-sessions");
        return { command: "UPDATE", rowCount: config.updateRowCount ?? 1, rows: [] };
      }
      if (/delete\s+from\s+"sessions"/i.test(sqlText)) {
        config.events.push("delete-sessions");
        return { command: "DELETE", rowCount: config.deleteRowCount ?? 1, rows: [] };
      }
      if (/delete\s+from\s+"projects"/i.test(sqlText)) {
        config.events.push("delete-projects");
        return { command: "DELETE", rowCount: 1, rows: [] };
      }
      if (/insert\s+into\s+"file_operations"/i.test(sqlText)) {
        config.events.push("insert-file-ops");
        return { command: "INSERT", rowCount: 1, rows: [] };
      }
      if (/for update/i.test(sqlText) && /from\s+"projects"/i.test(sqlText)) {
        config.events.push("lock-project");
        return { command: "SELECT", rowCount: 1, rows: [{ id: "proj" }] };
      }
      if (/for update/i.test(sqlText) && /from\s+"sessions"/i.test(sqlText) && /where\s+project_id\s*=/i.test(sqlText)) {
        config.events.push("select-project-sessions");
        const rows = config.projectSessionRows ?? [];
        return { command: "SELECT", rowCount: rows.length, rows };
      }
      if (/for update/i.test(sqlText) && /from\s+"sessions"/i.test(sqlText)) {
        config.events.push("select-session-for-update");
        const rows = config.sessionRow ? [config.sessionRow] : [];
        return { command: "SELECT", rowCount: rows.length, rows };
      }
      config.events.push("select");
      return { command: "SELECT", rowCount: 0, rows: [] };
    },
    release() {},
  };
  return {
    options: {},
    connect: () => Promise.resolve(client),
    end: async () => {},
  } as unknown as Pool;
}

/** 记录 enqueue 顺序的 file_operations transaction writer（不落 SQL）。 */
function recordingFileOperations(events: string[]): FileOperationTransactionWriter {
  return {
    async enqueueInTransaction(_transaction, input) {
      events.push(`enqueue:${input.operationKey}`);
      return {
        id: `op-${input.operationKey}`,
        operationKey: input.operationKey,
        kind: "delete",
        relativePath: input.relativePath,
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        state: "pending",
        attemptCount: 0,
        availableAt: input.createdAt,
        leaseUntil: null,
        leaseToken: null,
        lastError: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
    },
  };
}

/** 由 fake pool 构造真实 Kysely。 */
function kyselyFromPool(pool: Pool): Kysely<DatabaseSchema> {
  return createPostgresKysely(pool);
}

function planForKey(operationKey: string): ConversationCleanupPlan {
  return {
    operationKey,
    kind: "delete",
    relativePath: "sessions/s1/history.jsonl",
    sessionId: "s1",
    projectId: "proj",
  };
}

const SESSION_ROW: SessionDeleteRow = {
  id: "session-a",
  project_id: "proj",
  agent_kind: "pi",
  conversation_format: "pi-jsonl-v3",
  conversation_ref: "/data/sessions/session-a/history.jsonl",
};

describe("pgTombstoneAdvisoryLockKey（纯函数）", () => {
  it("同一 operationKey 恒映射到同一 key；不同 key 得到不同 key", () => {
    const key = "delete-artifact:pi:pi-jsonl-v3:abc";
    expect(pgTombstoneAdvisoryLockKey(key)).toBe(pgTombstoneAdvisoryLockKey(key));
    expect(pgTombstoneAdvisoryLockKey(key)).not.toBe(pgTombstoneAdvisoryLockKey("delete-artifact:pi:pi-jsonl-v3:xyz"));
  });

  it("key 是有符号 64 位 bigint（范围 [-2^63, 2^63-1]）", () => {
    const min = -(1n << 63n);
    const max = (1n << 63n) - 1n;
    for (const operationKey of ["a", "b", "delete-artifact:pi:pi-jsonl-v3:path", "x".repeat(2000)]) {
      const key = pgTombstoneAdvisoryLockKey(operationKey);
      expect(typeof key).toBe("bigint");
      expect(key >= min && key <= max).toBe(true);
    }
  });

  it("拒绝空 operationKey", () => {
    expect(() => pgTombstoneAdvisoryLockKey("")).toThrow(/non-empty/);
    expect(() => pgTombstoneAdvisoryLockKey("   ")).toThrow(/non-empty/);
  });

  it("operationKey 与 lock key 都不含敏感原始路径（路径仅以 SHA-256 摘要存在）", () => {
    const sensitivePath = "sessions/secret-token/history.jsonl";
    const operationKey = artifactDeleteOperationKey("pi", "pi-jsonl-v3", sensitivePath);
    expect(operationKey).not.toContain("secret-token");
    expect(operationKey).not.toContain("history.jsonl");
    expect(operationKey).not.toContain("/");
    // lock key 是纯数字，无法携带路径。
    expect(String(pgTombstoneAdvisoryLockKey(operationKey))).not.toContain("secret-token");
  });
});

describe("acquireTombstoneAdvisoryXactLock（SQL 行为）", () => {
  it("生成 `pg_advisory_xact_lock($N::bigint)`，参数为推导出的 bigint", async () => {
    const events: string[] = [];
    const sqlTexts: string[] = [];
    const kysely = kyselyFromPool(recordingPgPool({ events, sqlTexts }));
    const operationKey = "delete-artifact:pi:pi-jsonl-v3:abc";
    await acquireTombstoneAdvisoryXactLock(kysely, operationKey);
    expect(events.filter((event) => event === "advisory")).toHaveLength(1);
    const advisorySql = sqlTexts.find((sqlText) => /pg_advisory_xact_lock/i.test(sqlText));
    expect(advisorySql).toBeDefined();
    expect(advisorySql).toMatch(/pg_advisory_xact_lock\(\$\d+::bigint\)/i);
  });
});

describe("KyselySessionRepository.reserveConversation（PG SQL 路径）", () => {
  it("在 NOT EXISTS 条件 update 之前取得 advisory xact lock", async () => {
    const events: string[] = [];
    const kysely = kyselyFromPool(recordingPgPool({ events, updateRowCount: 1 }));
    const repo = new KyselySessionRepository(kysely, pgConstraintErrorMapper, { dialect: "postgres" });
    await repo.reserveConversation("session-b", {
      conversationRef: "/data/sessions/session-b/history.jsonl",
      tombstoneOperationKey: "delete-artifact:pi:pi-jsonl-v3:abc",
    });
    expect(events.indexOf("advisory")).toBeGreaterThan(-1);
    expect(events.indexOf("begin")).toBeLessThan(events.indexOf("advisory"));
    expect(events.indexOf("advisory")).toBeLessThan(events.indexOf("update-sessions"));
  });
});

describe("KyselySessionRepository.delete（PG SQL 路径）", () => {
  it("对非空 ref 先 cleanupPlan 得 operationKey，再取 advisory lock，随后 enqueue/delete", async () => {
    const events: string[] = [];
    const kysely = kyselyFromPool(recordingPgPool({ events, sessionRow: SESSION_ROW, deleteRowCount: 1 }));
    const fileOperations = recordingFileOperations(events);
    const repo = new KyselySessionRepository(kysely, pgConstraintErrorMapper, {
      dialect: "postgres",
      fileOperations,
      cleanupPlan: ({ conversation }) =>
        conversation.conversationRef === null ? null : planForKey(`tombstone:${conversation.conversationRef}`),
    });
    expect(await repo.delete("session-a")).toBe(true);

    const expectedKey = `tombstone:${SESSION_ROW.conversation_ref}`;
    const advisoryIndex = events.indexOf("advisory");
    const enqueueIndex = events.indexOf(`enqueue:${expectedKey}`);
    const deleteIndex = events.indexOf("delete-sessions");
    expect(advisoryIndex).toBeGreaterThan(-1);
    expect(enqueueIndex).toBeGreaterThan(advisoryIndex);
    expect(deleteIndex).toBeGreaterThan(enqueueIndex);
  });
});

describe("KyselyProjectRepository 项目删除（PG SQL 路径）", () => {
  it("对每个非空 ref 的 operationKey 在 enqueue/delete 之前取 advisory lock（按 operationKey 排序）", async () => {
    const events: string[] = [];
    const sessions: SessionDeleteRow[] = [
      { ...SESSION_ROW, id: "session-b", conversation_ref: "/data/sessions/session-b/history.jsonl" },
      { ...SESSION_ROW, id: "session-a", conversation_ref: "/data/sessions/session-a/history.jsonl" },
    ];
    const kysely = kyselyFromPool(recordingPgPool({ events, projectSessionRows: sessions, deleteRowCount: 1 }));
    const fileOperations = recordingFileOperations(events);
    const repo = new KyselyProjectRepository(kysely, pgConstraintErrorMapper, {
      dialect: "postgres",
      fileOperations,
      cleanupPlan: ({ conversation }) =>
        conversation.conversationRef === null ? null : planForKey(`tombstone:${conversation.conversationRef}`),
    });

    const returned = await repo.deleteProjectWithSessionsAndReturnSessionIds("proj", []);
    expect([...returned].sort()).toEqual(["session-a", "session-b"]);

    const expectedKeys = [
      `tombstone:/data/sessions/session-a/history.jsonl`,
      `tombstone:/data/sessions/session-b/history.jsonl`,
    ].sort();
    for (const key of expectedKeys) {
      const advisoryIndex = events.indexOf("advisory");
      const enqueueIndex = events.indexOf(`enqueue:${key}`);
      expect(advisoryIndex).toBeGreaterThan(-1);
      expect(enqueueIndex).toBeGreaterThan(-1);
      expect(enqueueIndex).toBeGreaterThan(advisoryIndex);
    }
    // 所有 advisory 都在 delete-sessions / delete-projects 之前。
    const lastAdvisory = events.lastIndexOf("advisory");
    expect(lastAdvisory).toBeLessThan(events.indexOf("delete-sessions"));
    expect(lastAdvisory).toBeLessThan(events.indexOf("delete-projects"));
  });

  it("跳过 conversation_ref 为 NULL 的会话（不取锁、不入队）", async () => {
    const events: string[] = [];
    const sessions: SessionDeleteRow[] = [
      { ...SESSION_ROW, id: "session-null", conversation_ref: null },
      { ...SESSION_ROW, id: "session-a", conversation_ref: "/data/sessions/session-a/history.jsonl" },
    ];
    const kysely = kyselyFromPool(recordingPgPool({ events, projectSessionRows: sessions, deleteRowCount: 1 }));
    const fileOperations = recordingFileOperations(events);
    const repo = new KyselyProjectRepository(kysely, pgConstraintErrorMapper, {
      dialect: "postgres",
      fileOperations,
      cleanupPlan: ({ conversation }) =>
        conversation.conversationRef === null ? null : planForKey(`tombstone:${conversation.conversationRef}`),
    });

    await repo.deleteProjectWithSessionsAndReturnSessionIds("proj", []);
    const enqueueEvents = events.filter((event) => event.startsWith("enqueue:"));
    expect(enqueueEvents).toEqual([`enqueue:tombstone:/data/sessions/session-a/history.jsonl`]);
    // 只有一个非空 ref，故恰一次 advisory lock。
    expect(events.filter((event) => event === "advisory")).toHaveLength(1);
  });
});
