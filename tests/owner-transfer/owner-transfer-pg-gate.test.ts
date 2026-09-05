// WP5D-4 PG 同连接门禁回归（reviewer 修复，纯 mock，无需真实 PG）：
// - 同一 leased client 先在**事务外**以参数化 SELECT pg_advisory_lock($1) 取得
//   session-level advisory lock（$1 = POSTGRES_MIGRATION_LOCK_KEY，与迁移引擎同 key
//   的 xact lock 冲突），取得后才 BEGIN ISOLATION LEVEL REPEATABLE READ（dry-run 为
//   READ ONLY）；revalidate/plan/update/postverify 同此 snapshot；
// - COMMIT/ROLLBACK 之后显式 pg_advisory_unlock($1) 并验证返回 true，才 release 归还
//   池；解锁未确认 true / 解锁失败 → release(error) 销毁（绝不把可能持锁连接回池）；
// - 不可重入一次性 phase 状态机：并发/重复 revalidate、跳过 revalidate apply、完成后
//   复用、apply 过程中 cleanup 均 fail-closed，绝不覆盖 in-flight client；dry-run 独立
//   one-shot 路径；cleanup 幂等且释放；
// - PG SELECT 别名必须是显式双引号（AS "ownerKey"/"projectId"），schema query 必须
//   count(DISTINCT table_name) = 2，项目 owner 允许空串（默认项目行）而 session owner 非空。
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import { postgresIdentity } from "../../src/backup/postgres-backup-core.js";
import type { PublishedBackupVerification } from "../../src/backup/backup-core.js";
import { POSTGRES_MIGRATION_LOCK_KEY } from "../../src/storage/migration-engine.js";
import {
  openPostgresOwnerTransferGate,
  ownerKeyForIp,
  type OwnerTransferPgPool,
  type OwnerTransferPgPoolClient,
} from "../../src/owner-transfer/owner-transfer-core.js";

const SCHEMA = "ot_mock_schema";
const DATABASE = "mock_db";
const SOURCE_OWNER = ownerKeyForIp("10.1.2.3");
const TARGET_OWNER = ownerKeyForIp("10.1.2.4");

const LOCK_QUERY = "SELECT pg_advisory_lock($1)";
const UNLOCK_QUERY = "SELECT pg_advisory_unlock($1)";

const VERIFICATION: PublishedBackupVerification = {
  id: "mock-verification",
  kind: "pre-owner-transfer",
  checksum: "0".repeat(64),
  version: 1,
  sourceRoots: null,
  sqliteTarget: null,
  sqliteTreeBinding: null,
  postgres: {
    databaseIdentity: postgresIdentity(DATABASE, "database"),
    schemaIdentity: postgresIdentity(SCHEMA, "schema"),
    systemIdentifier: "7234567890123456789",
    databaseOid: "16384",
    schemaOid: "16400",
    serverAddress: null,
    serverPort: null,
    clusterName: null,
  },
};

interface MockBackendOptions {
  readonly failBinding?: boolean;
  readonly failUpdate?: boolean;
  /** pg_advisory_unlock 的返回值（默认 true → 已确认释放）。 */
  readonly unlockResult?: boolean;
  /** pg_advisory_unlock 查询自身抛错。 */
  readonly failUnlock?: boolean;
  /** pg_advisory_lock 查询抛错（锁取得失败）。 */
  readonly failLock?: boolean;
  /** pg_advisory_lock 查询挂起直到该 promise 完成（顺序/并发屏障）。 */
  readonly holdLock?: Promise<void>;
  /** UPDATE 查询挂起直到该 promise 完成（cleanup-during-apply 屏障）。 */
  readonly holdUpdate?: Promise<void>;
  /** ROLLBACK 查询挂起直到该 promise 完成（apply-during-cleanup 竞态屏障）。 */
  readonly holdRollback?: Promise<void>;
}

class MockPgClient implements OwnerTransferPgPoolClient {
  readonly queries: string[] = [];
  readonly queryValues: Array<readonly unknown[]> = [];
  releases = 0;
  releasedWithError: Error | boolean | undefined;

  // Simulated owner state: the UPDATE statements below rewrite these rows so the
  // post-transfer re-read (fetchPostgresState) observes the transferred state.
  private projectsState = [
    { id: DEFAULT_PROJECT_ID, ownerKey: "" },
    { id: "p1", ownerKey: SOURCE_OWNER },
  ];
  private sessionsState = [{ id: "s1", ownerKey: SOURCE_OWNER, projectId: DEFAULT_PROJECT_ID }];

  constructor(private readonly options: MockBackendOptions = {}) {}

  async query(text: string, values: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.queries.push(text);
    this.queryValues.push(values);
    if (text.startsWith("BEGIN ")) return { rows: [] };
    if (text === "COMMIT" || text === "ROLLBACK") {
      if (text === "ROLLBACK" && this.options.holdRollback) await this.options.holdRollback;
      return { rows: [] };
    }
    if (text.includes("pg_advisory_unlock")) {
      if (this.options.failUnlock) throw new Error("mock: unlock query failed");
      return { rows: [{ pg_advisory_unlock: this.options.unlockResult ?? true }] };
    }
    if (text.includes("pg_advisory_lock($1)")) {
      if (this.options.failLock) throw new Error("mock: advisory lock could not be acquired");
      if (this.options.holdLock) await this.options.holdLock;
      return { rows: [] };
    }
    // The combined binding query contains both pg_control_system() and
    // current_database(); it must match before the identity branch.
    if (text.includes("pg_control_system")) {
      if (this.options.failBinding) throw new Error("mock: cluster identity could not be queried");
      return { rows: [{ database: DATABASE, schema: SCHEMA, system_identifier: "7234567890123456789", database_oid: "16384", schema_oid: "16400", server_address: null, server_port: null, cluster_name: null }] };
    }
    if (text.includes("current_database()")) return { rows: [{ database: DATABASE, schema: SCHEMA }] };
    if (text.includes("count(DISTINCT table_name)")) return { rows: [{ present: 2 }] };
    if (text.startsWith("UPDATE ")) {
      if (this.options.failUpdate) throw new Error("mock: update failed");
      if (this.options.holdUpdate) await this.options.holdUpdate;
      if (text.includes(`"${SCHEMA}"."projects"`)) {
        for (const row of this.projectsState) if (row.ownerKey === SOURCE_OWNER) row.ownerKey = TARGET_OWNER;
      } else if (text.includes(`"${SCHEMA}"."sessions"`)) {
        for (const row of this.sessionsState) if (row.ownerKey === SOURCE_OWNER) row.ownerKey = TARGET_OWNER;
      }
      return { rows: [] };
    }
    if (text.includes(`FROM "${SCHEMA}"."projects"`)) return { rows: [...this.projectsState] };
    if (text.includes(`FROM "${SCHEMA}"."sessions"`)) return { rows: [...this.sessionsState] };
    throw new Error(`unexpected mock query: ${text.slice(0, 120)}`);
  }

  release(err?: Error | boolean): void {
    this.releases += 1;
    if (err !== undefined) this.releasedWithError = err;
  }
}

function mockPool(options: MockBackendOptions = {}): {
  pool: OwnerTransferPgPool;
  clients: MockPgClient[];
  connectCount: () => number;
} {
  const clients: MockPgClient[] = [];
  let connects = 0;
  return {
    pool: {
      async connect(): Promise<OwnerTransferPgPoolClient> {
        connects += 1;
        // Every connect yields a FRESH client object: if the gate ever released
        // and reconnected between revalidate and transfer, this would surface
        // as a connectCount > 1 and a different client serving the UPDATEs.
        const client = new MockPgClient(options);
        clients.push(client);
        return client;
      },
    },
    clients,
    connectCount: () => connects,
  };
}

/** 释放一个一次性屏障 promise（供 holdLock/holdUpdate 使用）。 */
function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = () => resolve(); });
  return { promise, release };
}

describe("WP5D-4 PostgreSQL owner-transfer gate (mock client, session lock + one-shot state machine)", () => {
  it("takes the parametrized session advisory lock BEFORE BEGIN, keeps ONE leased client and ONE REPEATABLE READ transaction from revalidate through COMMIT, then unlocks (verified true) before release", async () => {
    const { pool, clients, connectCount } = mockPool();
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      await gate.revalidate(VERIFICATION);
      const plan = await gate.transfer("apply");
      expect(plan.projectsTransferred).toBe(1);
      expect(plan.sessionsTransferred).toBe(1);
      expect(plan.defaultProjectOwnerPreserved).toBe(true);

      // Connection-switch regression: exactly one connect, one BEGIN, one COMMIT,
      // no intermediate ROLLBACK and no second BEGIN between revalidate and commit.
      expect(connectCount()).toBe(1);
      const queries = clients[0]!.queries;
      // 锁在事务外、BEGIN 之前；参数化 $1 = POSTGRES_MIGRATION_LOCK_KEY。
      expect(queries[0]).toBe(LOCK_QUERY);
      expect(clients[0]!.queryValues[0]).toEqual([POSTGRES_MIGRATION_LOCK_KEY]);
      expect(queries[1]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
      expect(queries.filter((q) => q === "BEGIN ISOLATION LEVEL REPEATABLE READ")).toHaveLength(1);
      expect(queries.filter((q) => q === "ROLLBACK")).toHaveLength(0);
      expect(queries.filter((q) => q === "COMMIT")).toHaveLength(1);
      // 完整顺序：lock → BEGIN → binding → identity → schema → plan 读 → UPDATE → post 读 → COMMIT → unlock。
      const beginIndex = queries.indexOf("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const firstPlanRead = queries.findIndex((q) => q.includes(`FROM "${SCHEMA}"."projects"`));
      const firstUpdate = queries.findIndex((q) => q.startsWith("UPDATE "));
      const commitIndex = queries.indexOf("COMMIT");
      expect(beginIndex).toBeGreaterThan(0);
      expect(firstPlanRead).toBeGreaterThan(beginIndex);
      expect(firstPlanRead).toBeLessThan(firstUpdate);
      expect(commitIndex).toBeGreaterThan(firstUpdate);
      expect(queries[commitIndex + 1]).toBe(UNLOCK_QUERY);
      expect(queries.at(-1)).toBe(UNLOCK_QUERY);
      expect(clients[0]!.queryValues[queries.length - 1]).toEqual([POSTGRES_MIGRATION_LOCK_KEY]);
      // 锁是 session 级、一次取得一次释放；不再是事务内 xact lock。
      expect(queries.filter((q) => q.includes("pg_advisory_lock($1)"))).toHaveLength(1);
      expect(queries.filter((q) => q.includes("pg_advisory_unlock"))).toHaveLength(1);
      expect(queries.some((q) => q.includes("pg_advisory_xact_lock"))).toBe(false);
      expect(queries.filter((q) => q.startsWith("UPDATE "))).toHaveLength(2);
    } finally {
      await gate.cleanup();
    }
    // 解锁确认后普通 release（无错误、恰好一次）。
    expect(clients[0]!.releases).toBe(1);
    expect(clients[0]!.releasedWithError).toBeUndefined();
  });

  it("takes the snapshot only after the session lock is granted (lock waits before BEGIN and before any state read)", async () => {
    const lockBarrier = barrier();
    const { pool, clients, connectCount } = mockPool({ holdLock: lockBarrier.promise });
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      const revalidating = gate.revalidate(VERIFICATION);
      await vi.waitFor(() => expect(clients[0]!.queries.includes(LOCK_QUERY)).toBe(true));
      // 锁尚未授予：没有 BEGIN、没有 binding 查询、没有任何 projects/sessions 读取。
      expect(clients[0]!.queries).toEqual([LOCK_QUERY]);
      lockBarrier.release();
      await expect(revalidating).resolves.toBeUndefined();
      const queries = clients[0]!.queries;
      expect(queries[0]).toBe(LOCK_QUERY);
      expect(queries[1]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
      // 快照（plan 读取）严格发生在 lock + BEGIN 之后（transfer 在同一事务内进行）。
      await gate.transfer("apply");
      const firstPlanRead = queries.findIndex((q) => q.includes(`FROM "${SCHEMA}"`));
      expect(firstPlanRead).toBeGreaterThan(1);
      expect(connectCount()).toBe(1);
    } finally {
      await gate.cleanup();
    }
    expect(clients[0]!.releases).toBe(1);
  });

  it("refuses concurrent revalidate through the one-shot gate: the second call fails closed without connecting", async () => {
    const lockBarrier = barrier();
    const { pool, clients, connectCount } = mockPool({ holdLock: lockBarrier.promise });
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      const first = gate.revalidate(VERIFICATION);
      await vi.waitFor(() => expect(clients[0]!.queries[0]).toBe(LOCK_QUERY));
      // 第一个 revalidate 还在等待 session lock：第二个并发调用立即 fail-closed。
      await expect(gate.revalidate(VERIFICATION)).rejects.toThrow(/one-shot/);
      expect(connectCount()).toBe(1);
      lockBarrier.release();
      await expect(first).resolves.toBeUndefined();
      // 首个 revalidate 成功后门禁正常进入同一 client 的 apply。
      const plan = await gate.transfer("apply");
      expect(plan.projectsTransferred).toBe(1);
    } finally {
      await gate.cleanup();
    }
    expect(clients[0]!.releases).toBe(1);
  });

  it("refuses a repeated revalidate after success and reuse of the gate after completion (one-shot)", async () => {
    const { pool, clients, connectCount } = mockPool();
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      await gate.revalidate(VERIFICATION);
      // 复验成功后重复 revalidate → fail-closed（零加连）。
      await expect(gate.revalidate(VERIFICATION)).rejects.toThrow(/one-shot/);
      const plan = await gate.transfer("apply");
      expect(plan.projectsTransferred).toBe(1);
      // 完成后：apply / dry-run / revalidate 全部 fail-closed，且不产生新连接。
      await expect(gate.transfer("apply")).rejects.toThrow(/one-shot/);
      await expect(gate.transfer("dry-run")).rejects.toThrow(/one-shot/);
      await expect(gate.revalidate(VERIFICATION)).rejects.toThrow(/one-shot/);
      expect(connectCount()).toBe(1);
      // cleanup 在终态幂等，不重复 release。
      await gate.cleanup();
      expect(clients[0]!.releases).toBe(1);
    } finally {
      await gate.cleanup();
    }
  });

  it("uses explicitly double-quoted PG SELECT aliases and a count-distinct=2 schema query, and accepts the empty-owner project row", async () => {
    const { pool, clients, connectCount } = mockPool();
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      await gate.revalidate(VERIFICATION);
      await gate.transfer("apply");
    } finally {
      await gate.cleanup();
    }
    const queries = clients[0]!.queries;
    // Double-quoted aliases: without them PostgreSQL folds the labels to
    // "ownerkey"/"projectid" and every row becomes malformed.
    expect(queries.some((q) => q.includes('owner_key AS "ownerKey" FROM'))).toBe(true);
    expect(queries.some((q) => q.includes('owner_key AS "ownerKey", project_id AS "projectId"'))).toBe(true);
    // Schema query must confirm BOTH tables via count(DISTINCT table_name) = 2.
    expect(queries.some((q) => q.includes("count(DISTINCT table_name)::int AS present"))).toBe(true);
    // The default project row (ownerKey: "") was accepted and the transfer
    // still planned/executed: project owner may be empty, session owner must not be.
    expect(connectCount()).toBe(1);
  });

  it("runs a standalone dry-run in an independent READ ONLY transaction with zero writes and no backup/binding, then unlocks before release", async () => {
    const { pool, clients, connectCount } = mockPool();
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      const plan = await gate.transfer("dry-run");
      expect(plan.projectsTransferred).toBe(1);
      expect(plan.sessionsTransferred).toBe(1);
    } finally {
      await gate.cleanup();
    }
    expect(connectCount()).toBe(1);
    const queries = clients[0]!.queries;
    expect(queries[0]).toBe(LOCK_QUERY);
    expect(clients[0]!.queryValues[0]).toEqual([POSTGRES_MIGRATION_LOCK_KEY]);
    expect(queries[1]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(queries.filter((q) => q === "COMMIT")).toHaveLength(0);
    expect(queries.filter((q) => q.startsWith("UPDATE "))).toHaveLength(0);
    expect(queries.at(-2)).toBe("ROLLBACK");
    expect(queries.at(-1)).toBe(UNLOCK_QUERY);
    expect(clients[0]!.queryValues[queries.length - 1]).toEqual([POSTGRES_MIGRATION_LOCK_KEY]);
    expect(clients[0]!.releases).toBe(1);
    expect(clients[0]!.releasedWithError).toBeUndefined();
  });

  it("dry-run is an independent one-shot path: a second dry-run or a later apply fails closed", async () => {
    const { pool, clients, connectCount } = mockPool();
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      const plan = await gate.transfer("dry-run");
      expect(plan.sessionsTransferred).toBe(1);
      await expect(gate.transfer("dry-run")).rejects.toThrow(/one-shot/);
      // dry-run 完成后 apply 也没有可用的复验事务 → fail-closed（完成态一次性）。
      await expect(gate.transfer("apply")).rejects.toThrow(/one-shot/);
      expect(connectCount()).toBe(1);
    } finally {
      await gate.cleanup();
    }
    expect(clients[0]!.releases).toBe(1);
  });

  it("fails closed when apply is attempted without binding revalidation (zero connects, zero writes)", async () => {
    const { pool, connectCount } = mockPool();
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      await expect(gate.transfer("apply")).rejects.toThrow(/revalidate first/);
      expect(connectCount()).toBe(0);
    } finally {
      await gate.cleanup();
    }
  });

  it("rolls back a failed revalidation, unlocks the session lock, and refuses a later apply without reopening a transaction on another connection", async () => {
    const { pool, clients, connectCount } = mockPool({ failBinding: true });
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      await expect(gate.revalidate(VERIFICATION)).rejects.toThrow(/details withheld/);
      // 同一门禁不可重试复验（一次性）。
      await expect(gate.revalidate(VERIFICATION)).rejects.toThrow(/one-shot/);
      await expect(gate.transfer("apply")).rejects.toThrow(/revalidate first/);
      // The failed revalidation was rolled back and unlocked on its own client;
      // the apply never reconnects and never opens a second transaction.
      expect(connectCount()).toBe(1);
      expect(clients[0]!.queries.filter((q) => q === "ROLLBACK")).toHaveLength(1);
      expect(clients[0]!.queries.at(-2)).toBe("ROLLBACK");
      expect(clients[0]!.queries.at(-1)).toBe(UNLOCK_QUERY);
      expect(clients[0]!.queries.filter((q) => q.startsWith("UPDATE "))).toHaveLength(0);
      expect(clients[0]!.releases).toBe(1);
      expect(clients[0]!.releasedWithError).toBeUndefined();
    } finally {
      await gate.cleanup();
    }
  });

  it("rolls back a failed transfer on the same client, unlocks, and performs zero writes", async () => {
    const { pool, clients, connectCount } = mockPool({ failUpdate: true });
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      await gate.revalidate(VERIFICATION);
      await expect(gate.transfer("apply")).rejects.toThrow(/mock: update failed/);
      expect(connectCount()).toBe(1);
      expect(clients[0]!.queries.filter((q) => q === "COMMIT")).toHaveLength(0);
      expect(clients[0]!.queries.at(-2)).toBe("ROLLBACK");
      expect(clients[0]!.queries.at(-1)).toBe(UNLOCK_QUERY);
    } finally {
      await gate.cleanup();
    }
    expect(clients[0]!.releases).toBe(1);
    expect(clients[0]!.releasedWithError).toBeUndefined();
  });

  it("refuses cleanup while apply is in flight and never clobbers the leased client", async () => {
    const updateBarrier = barrier();
    const { pool, clients } = mockPool({ holdUpdate: updateBarrier.promise });
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      await gate.revalidate(VERIFICATION);
      const transferring = gate.transfer("apply");
      await vi.waitFor(() => expect(clients[0]!.queries.some((q) => q.startsWith("UPDATE "))).toBe(true));
      // apply 在飞：cleanup 拒绝，且 client 租约不被破坏。
      await expect(gate.cleanup()).rejects.toThrow(/in progress/);
      expect(clients[0]!.releases).toBe(0);
      updateBarrier.release();
      const plan = await transferring;
      expect(plan.projectsTransferred).toBe(1);
      // transfer 在同一 client 上继续并正常 settle（COMMIT + unlock + release）。
      expect(clients[0]!.releases).toBe(1);
      expect(clients[0]!.queries.at(-1)).toBe(UNLOCK_QUERY);
      // 终态 cleanup 幂等。
      await gate.cleanup();
      expect(clients[0]!.releases).toBe(1);
    } finally {
      await gate.cleanup().catch(() => undefined);
    }
  });

  it("cleanup before apply rolls back the open revalidate transaction, unlocks, releases, and later apply fails closed (idempotent cleanup)", async () => {
    const { pool, clients, connectCount } = mockPool();
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      await gate.revalidate(VERIFICATION);
      await gate.cleanup();
      const queries = clients[0]!.queries;
      expect(queries.at(-2)).toBe("ROLLBACK");
      expect(queries.at(-1)).toBe(UNLOCK_QUERY);
      expect(clients[0]!.releases).toBe(1);
      expect(clients[0]!.releasedWithError).toBeUndefined();
      // 清退后 apply 不可再开始（不可重入一次性；零加连）。
      await expect(gate.transfer("apply")).rejects.toThrow(/one-shot/);
      expect(connectCount()).toBe(1);
      // cleanup 幂等：重复调用不重复 release。
      await gate.cleanup();
      expect(clients[0]!.releases).toBe(1);
    } finally {
      await gate.cleanup();
    }
  });

  it("fails closed when apply races with an in-flight cleanup (the lease teardown is synchronous, the client is never clobbered)", async () => {
    const rollbackBarrier = barrier();
    const { pool, clients, connectCount } = mockPool({ holdRollback: rollbackBarrier.promise });
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      await gate.revalidate(VERIFICATION);
      const cleaning = gate.cleanup();
      await vi.waitFor(() => expect(clients[0]!.queries.includes("ROLLBACK")).toBe(true));
      // cleanup 已开始并同步置为清退终态：并发 apply 必须 fail-closed（零加连）。
      await expect(gate.transfer("apply")).rejects.toThrow(/one-shot/);
      expect(connectCount()).toBe(1);
      rollbackBarrier.release();
      await expect(cleaning).resolves.toBeUndefined();
      expect(clients[0]!.queries.at(-1)).toBe(UNLOCK_QUERY);
      expect(clients[0]!.releases).toBe(1);
      expect(clients[0]!.releasedWithError).toBeUndefined();
    } finally {
      await gate.cleanup();
    }
  });

  it("destroys the client (release with error) when pg_advisory_unlock does not confirm true, and never returns it to the pool", async () => {
    const { pool, clients, connectCount } = mockPool({ unlockResult: false });
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      await gate.revalidate(VERIFICATION);
      await expect(gate.transfer("apply")).rejects.toThrow(/did not confirm release/);
      expect(connectCount()).toBe(1);
      // COMMIT 已发出；解锁未确认 → 释放时带错误（销毁而非回池）。
      expect(clients[0]!.queries.filter((q) => q === "COMMIT")).toHaveLength(1);
      expect(clients[0]!.queries.at(-1)).toBe(UNLOCK_QUERY);
      expect(clients[0]!.queryValues.at(-1)).toEqual([POSTGRES_MIGRATION_LOCK_KEY]);
      expect(clients[0]!.releases).toBe(1);
      expect(clients[0]!.releasedWithError).toBeInstanceOf(Error);
    } finally {
      await gate.cleanup();
    }
  });

  it("destroys the client when the unlock query itself fails, and never returns it to the pool", async () => {
    const { pool, clients, connectCount } = mockPool({ failUnlock: true });
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      await gate.revalidate(VERIFICATION);
      await expect(gate.transfer("apply")).rejects.toThrow(/unlock query failed/);
      expect(connectCount()).toBe(1);
      expect(clients[0]!.releases).toBe(1);
      expect(clients[0]!.releasedWithError).toBeInstanceOf(Error);
    } finally {
      await gate.cleanup();
    }
  });

  it("destroys a client whose session lock acquisition failed instead of returning it to the pool", async () => {
    const { pool, clients, connectCount } = mockPool({ failLock: true });
    const gate = openPostgresOwnerTransferGate(pool, DATABASE, SCHEMA, SOURCE_OWNER, TARGET_OWNER);
    try {
      await expect(gate.revalidate(VERIFICATION)).rejects.toThrow(/could not be acquired/);
      expect(connectCount()).toBe(1);
      expect(clients[0]!.queries.filter((q) => q.startsWith("BEGIN "))).toHaveLength(0);
      expect(clients[0]!.releases).toBe(1);
      expect(clients[0]!.releasedWithError).toBeInstanceOf(Error);
      await expect(gate.transfer("apply")).rejects.toThrow(/revalidate first/);
    } finally {
      await gate.cleanup();
    }
  });
});