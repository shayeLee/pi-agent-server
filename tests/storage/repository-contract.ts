// 共用 Repository 行为契约（H4）：parameterized 共享测试集，SQLite 与 PostgreSQL 各自注册运行同一
// 组核心 CRUD / owner / project 隔离 / 排序 tie-break / 默认项目守卫 / ON CONFLICT / idempotency TTL
// / 更新不存在 / backfill 契约。方言专有 DDL 测试（WAL/PRAGMA/information_schema、非 id 唯一约束的
// 真实 23505 等）保留在各自方言测试文件，不进本契约。
//
// 用法：方言测试文件调用 defineRepositoryContract(suiteName, makeStorage)。makeStorage 每次
// beforeEach 返回**用例独立的干净存储**（SQLite：每次新建 :memory: 库；PG：provider 每次
// TRUNCATE + 重种默认项目），并负责 close() 按真实所有权关闭底层存储。
//
// 约束（保证双库同契约可运行）：写入数据库列（projects.id / sessions.id / sessions.project_id /
// idempotency.session_id）的一律用合法 UUID（PG uuid 列要求；SQLite 同样接受）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import type { KyselyProjectRepository } from "../../src/storage/kysely-project-repository.js";
import type { KyselySessionRepository } from "../../src/storage/kysely-session-repository.js";
import type { KyselyIdempotencyRepository } from "../../src/storage/kysely-idempotency-repository.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import { DuplicateIdError, ProjectForeignKeyError } from "../../src/application/ports/store-errors.js";
import { identityKey } from "../../src/core/user-identity.js";
import { artifactDeleteOperationKey } from "../../src/storage/file-operation-policy.js";
import { FILE_OPERATION_STATES, type FileOperationState } from "../../src/application/ports/file-operation-store-port.js";
import type { ProjectRecord } from "../../src/application/ports/project-store-port.js";
import type { SessionRecord } from "../../src/application/ports/session-store-port.js";

export interface RepositoryContractStorage {
  kysely: Kysely<DatabaseSchema>;
  projects: KyselyProjectRepository;
  sessions: KyselySessionRepository;
  idempotency: KyselyIdempotencyRepository;
  /** 按真实所有权关闭底层存储（SQLite destroy Kysely；PG suite 维护共享 fixture，可 no-op）。 */
  close: () => Promise<void>;
}

const OWNER_A = identityKey({ kind: "ip", ip: "10.0.0.1" });
const OWNER_B = identityKey({ kind: "ip", ip: "10.0.0.9" });

/**
 * 共享默认项目 fixture：方言测试 makeStorage 必须用此值预种默认项目，
 * 确保共享契约中 assert equal 值一致，避免 cwd/name/createdAt 不匹配。
 */
export const DEFAULT_PROJECT_RECORD: ProjectRecord = {
  id: DEFAULT_PROJECT_ID,
  name: "默认项目",
  cwd: "/tmp/default-project",
  ownerKey: "",
  createdAt: 0,
};

function projectRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: randomUUID(),
    name: "测试项目",
    cwd: "/path/to/repo",
    ownerKey: OWNER_A,
    createdAt: 1000,
    ...overrides,
  };
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: randomUUID(),
    ownerKey: OWNER_A,
    projectId: DEFAULT_PROJECT_ID,
    title: "测试会话",
    createdAt: 1000,
    updatedAt: 1000,
    agentKind: "pi",
    conversationFormat: "pi-jsonl-v3",
    conversationRef: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    systemPrompt: null,
    capabilityVersions: null,
    ...overrides,
  };
}

export function defineRepositoryContract(
  suiteName: string,
  makeStorage: () => Promise<RepositoryContractStorage>,
): void {
  describe(suiteName, () => {
    let storage: RepositoryContractStorage;
    beforeEach(async () => {
      storage = await makeStorage();
    });
    afterEach(async () => {
      // makeStorage 抛错时 storage 可能未初始化：可选链避免 afterEach 用 TypeError 覆盖原始失败。
      await storage?.close();
    });

    describe("CRUD create/get", () => {
      it("project create 后 get 返回完整记录；get 不存在返回 null", async () => {
        const rec = projectRecord();
        await storage.projects.create(rec);
        expect(await storage.projects.get(rec.id)).toEqual(rec);
        expect(await storage.projects.get(randomUUID())).toBeNull();
      });

      it("session create 后 get 返回完整记录；get 不存在返回 null", async () => {
        const rec = sessionRecord();
        await storage.sessions.create(rec);
        expect(await storage.sessions.get(rec.id)).toEqual(rec);
        expect(await storage.sessions.get(randomUUID())).toBeNull();
      });

      it("create 撞主键（重复 id）转换为存储无关 DuplicateIdError 并保留 cause（双库映射器）", async () => {
        const project = projectRecord();
        await storage.projects.create(project);
        const pErr = await storage.projects.create(project).then(() => null, (e: unknown) => e);
        expect(pErr).toBeInstanceOf(DuplicateIdError);
        expect((pErr as DuplicateIdError).cause).toBeInstanceOf(Error);

        const record = sessionRecord();
        await storage.sessions.create(record);
        const sErr = await storage.sessions.create(record).then(() => null, (e: unknown) => e);
        expect(sErr).toBeInstanceOf(DuplicateIdError);
        expect((sErr as DuplicateIdError).cause).toBeInstanceOf(Error);
      });

      it("session create 撞 project_id 外键（项目不存在）转换为存储无关 ProjectForeignKeyError（不误转 DuplicateIdError）", async () => {
        const err = await storage.sessions
          .create(sessionRecord({ id: randomUUID(), projectId: randomUUID() }))
          .then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(ProjectForeignKeyError);
        expect(err).not.toBeInstanceOf(DuplicateIdError);
        expect((err as ProjectForeignKeyError).cause).toBeInstanceOf(Error);
      });
    });

    describe("owner 隔离", () => {
      it("projects/sessions 只按 owner 返回，不同 owner 互不串扰", async () => {
        await storage.projects.create(projectRecord({ ownerKey: OWNER_A, name: "A 项目" }));
        await storage.projects.create(projectRecord({ ownerKey: OWNER_B, name: "B 项目" }));
        await storage.sessions.create(sessionRecord({ ownerKey: OWNER_A, title: "A 会话" }));
        await storage.sessions.create(sessionRecord({ ownerKey: OWNER_B, title: "B 会话" }));

        const listA = await storage.projects.listByOwner(OWNER_A);
        expect(listA).toHaveLength(1);
        expect(listA[0]?.name).toBe("A 项目");
        expect(await storage.projects.listByOwner(OWNER_B)).toHaveLength(1);

        expect(await storage.sessions.listByOwner(OWNER_A)).toHaveLength(1);
        expect((await storage.sessions.listByOwner(OWNER_A))[0]?.title).toBe("A 会话");
        expect((await storage.sessions.listByOwner(OWNER_B))[0]?.title).toBe("B 会话");
      });

      it("listByProject 按 owner + project 双重过滤：同一 project 下 OWNER_A / OWNER_B 各自只见自己的会话（变异抵抗）", async () => {
        // 变异抵抗：若实现退化为只按 projectId 过滤（漏掉 owner_key 条件）或只按 owner 过滤
        // （漏掉 projectId 条件），下列断言必然失败——同一项目里塞入 B 的会话就是为暴露这两种退化。
        const pid = randomUUID();
        await storage.projects.create(projectRecord({ id: pid, ownerKey: OWNER_A }));
        // OWNER_A 在默认项目 + 目标项目各有一条/两条
        await storage.sessions.create(sessionRecord({ id: randomUUID(), ownerKey: OWNER_A, projectId: DEFAULT_PROJECT_ID }));
        const a1 = randomUUID();
        const a2 = randomUUID();
        await storage.sessions.create(sessionRecord({ id: a1, ownerKey: OWNER_A, projectId: pid, title: "A-1" }));
        await storage.sessions.create(sessionRecord({ id: a2, ownerKey: OWNER_A, projectId: pid, title: "A-2" }));
        // OWNER_B 也有同 projectId 的会话：A 不得看到 B 的会话（owner 维度隔离）
        const b1 = randomUUID();
        await storage.sessions.create(sessionRecord({ id: b1, ownerKey: OWNER_B, projectId: pid, title: "B-1" }));

        // A 在 pid 下只见自己的 2 条（B-1 不可见 -> owner 过滤生效）
        const listA = await storage.sessions.listByProject(OWNER_A, pid);
        expect(listA).toHaveLength(2);
        expect(listA.map((r) => r.id).sort()).toEqual([a1, a2].sort());
        // B 在 pid 下只见自己的 1 条（A 的会话不可见，双 owner 互不串扰）
        const listB = await storage.sessions.listByProject(OWNER_B, pid);
        expect(listB).toHaveLength(1);
        expect(listB[0]?.id).toBe(b1);
        // project 维度过滤独立成立：A 在默认项目只见自己的 1 条，未知项目为空
        expect(await storage.sessions.listByProject(OWNER_A, DEFAULT_PROJECT_ID)).toHaveLength(1);
        expect(await storage.sessions.listByProject(OWNER_A, randomUUID())).toEqual([]);
      });
    });

    describe("排序 tie-break（createdAt/updatedAt desc，id desc 次级排序）", () => {
      // 可预测词法序 id（PG 合法 uuid 格式）：…00a < …00b < …00c
      const IDS = [
        "00000000-0000-4000-8000-00000000000a",
        "00000000-0000-4000-8000-00000000000b",
        "00000000-0000-4000-8000-00000000000c",
      ] as const;

      it("project listByOwner：createdAt desc；同 createdAt 时 id desc", async () => {
        for (const [i, id] of IDS.entries()) {
          await storage.projects.create(
            projectRecord({ id, ownerKey: OWNER_A, createdAt: 1000 + i }),
          );
        }
        expect((await storage.projects.listByOwner(OWNER_A)).map((r) => r.id)).toEqual([
          IDS[2], IDS[1], IDS[0],
        ]);

        // 同 createdAt → 次级排序 id desc
        await storage.projects.create(
          projectRecord({ id: "00000000-0000-4000-8000-00000000000d", ownerKey: OWNER_A, createdAt: 1002 }),
        );
        expect((await storage.projects.listByOwner(OWNER_A)).map((r) => r.id)).toEqual([
          "00000000-0000-4000-8000-00000000000d", IDS[2], IDS[1], IDS[0],
        ]);
      });

      it("session listByOwner：updatedAt desc；同 updatedAt 时 id desc", async () => {
        for (const [i, id] of IDS.entries()) {
          await storage.sessions.create(sessionRecord({ id, ownerKey: OWNER_A, updatedAt: 2000 + i }));
        }
        expect((await storage.sessions.listByOwner(OWNER_A)).map((r) => r.id)).toEqual([
          IDS[2], IDS[1], IDS[0],
        ]);
      });

      it("session listByProject：owner+project 过滤后 same tie-break", async () => {
        const pid = randomUUID();
        await storage.projects.create(projectRecord({ id: pid }));
        for (const [i, id] of IDS.entries()) {
          await storage.sessions.create(
            sessionRecord({ id, ownerKey: OWNER_A, projectId: pid, updatedAt: 3000 + i }),
          );
        }
        expect((await storage.sessions.listByProject(OWNER_A, pid)).map((r) => r.id)).toEqual([
          IDS[2], IDS[1], IDS[0],
        ]);
      });
    });

    describe("默认项目守卫（DEFAULT_PROJECT_ID 由 ensureDefaultProject 独占）", () => {
      const defaultRecord = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
        ...DEFAULT_PROJECT_RECORD,
        ...overrides,
      });

      it("ensureDefaultProject 拒绝非 default id / 非空 owner", async () => {
        await expect(
          storage.projects.ensureDefaultProject(defaultRecord({ id: randomUUID() })),
        ).rejects.toThrow(/默认项目 id/);
        await expect(
          storage.projects.ensureDefaultProject(defaultRecord({ ownerKey: "owner-x" })),
        ).rejects.toThrow(/空 owner/);
      });

      it("ensureDefaultProject 对既有异常 owner 行显式失败（不静默 IGNORE）", async () => {
        await storage.projects.ensureDefaultProject(defaultRecord());
        await storage.kysely
          .updateTable("projects")
          .set({ owner_key: "owner-x" })
          .where("id", "=", DEFAULT_PROJECT_ID)
          .execute();
        await expect(storage.projects.ensureDefaultProject(defaultRecord())).rejects.toThrow(/owner 非空/);
      });

      it("ensureDefaultProject 幂等（ON CONFLICT DO NOTHING）：任何后续调用不覆盖既有默认行（含 makeStorage 预种）", async () => {
        // makeStorage 已用 ensureDefaultProject 种入默认项目（cwd=/tmp/default-project）；
        // 再以不同 cwd 调用必须被 ON CONFLICT DO NOTHING 幂等忽略，绝不覆盖既有行。
        await storage.projects.ensureDefaultProject(defaultRecord({ cwd: "/fresh" }));
        await storage.projects.ensureDefaultProject(defaultRecord({ cwd: "/misconfigured" }));
        const row = await storage.projects.get(DEFAULT_PROJECT_ID);
        expect(row).toEqual(DEFAULT_PROJECT_RECORD);
      });

      it("create 拒绝写入 default id（无论 owner 是否为空）；delete 拒绝删除 default 且不 CASCADE", async () => {
        await storage.projects.ensureDefaultProject(defaultRecord());
        await expect(
          storage.projects.create(defaultRecord({ ownerKey: "owner-x" })),
        ).rejects.toThrow(/独占/);
        await expect(storage.projects.create(defaultRecord({ ownerKey: "" }))).rejects.toThrow(/独占/);

        await storage.sessions.create(
          sessionRecord({ id: randomUUID(), projectId: DEFAULT_PROJECT_ID, title: "默认会话" }),
        );
        expect(await storage.projects.delete(DEFAULT_PROJECT_ID)).toBe(false);
        expect(await storage.projects.get(DEFAULT_PROJECT_ID)).not.toBeNull();
        expect(await storage.sessions.listByProject(OWNER_A, DEFAULT_PROJECT_ID)).toHaveLength(1);
      });

      it("deleteProjectWithSessions 拒绝删除 default（项目与会话均保留）", async () => {
        await storage.projects.ensureDefaultProject(defaultRecord());
        const sid = randomUUID();
        await storage.sessions.create(sessionRecord({ id: sid, projectId: DEFAULT_PROJECT_ID }));
        await expect(
          storage.projects.deleteProjectWithSessions(DEFAULT_PROJECT_ID, [sid]),
        ).rejects.toThrow(/默认项目不可删除/);
        expect(await storage.projects.get(DEFAULT_PROJECT_ID)).not.toBeNull();
        expect(await storage.sessions.get(sid)).not.toBeNull();
      });
    });

    describe("delete / deleteProjectWithSessions", () => {
      it("delete 返回 true 且 get 变 null；删除不存在返回 false", async () => {
        const project = projectRecord();
        await storage.projects.create(project);
        expect(await storage.projects.delete(project.id)).toBe(true);
        expect(await storage.projects.get(project.id)).toBeNull();
        expect(await storage.projects.delete(randomUUID())).toBe(false);

        const record = sessionRecord();
        await storage.sessions.create(record);
        expect(await storage.sessions.delete(record.id)).toBe(true);
        expect(await storage.sessions.get(record.id)).toBeNull();
        expect(await storage.sessions.delete(randomUUID())).toBe(false);
      });

      it("deleteProjectWithSessions 同事务删除项目及其会话（全删或全留）", async () => {
        const pid = randomUUID();
        await storage.projects.create(projectRecord({ id: pid }));
        const s1 = randomUUID();
        const s2 = randomUUID();
        await storage.sessions.create(sessionRecord({ id: s1, projectId: pid }));
        await storage.sessions.create(sessionRecord({ id: s2, projectId: pid }));

        await storage.projects.deleteProjectWithSessions(pid, [s1, s2]);
        expect(await storage.projects.get(pid)).toBeNull();
        expect(await storage.sessions.get(s1)).toBeNull();
        expect(await storage.sessions.get(s2)).toBeNull();
      });

      it("FK CASCADE 兜底：直接删项目自动级联删其会话（数据库层保证，应用层不遗漏）", async () => {
        const pid = randomUUID();
        await storage.projects.create(projectRecord({ id: pid }));
        const s1 = randomUUID();
        const s2 = randomUUID();
        await storage.sessions.create(sessionRecord({ id: s1, projectId: pid }));
        await storage.sessions.create(sessionRecord({ id: s2, projectId: pid }));

        await storage.projects.delete(pid);
        expect(await storage.projects.get(pid)).toBeNull();
        expect(await storage.sessions.get(s1)).toBeNull();
        expect(await storage.sessions.get(s2)).toBeNull();
      });
    });

    describe("update / backfill", () => {
      it("update 修改 title 返回 true，其余字段不变；update 不存在返回 false", async () => {
        const rec = sessionRecord({ title: "旧标题" });
        await storage.sessions.create(rec);
        expect(await storage.sessions.update(rec.id, { title: "新标题" })).toBe(true);
        const got = await storage.sessions.get(rec.id);
        expect(got).toMatchObject({ title: "新标题", ownerKey: OWNER_A, projectId: DEFAULT_PROJECT_ID });
        expect(got?.createdAt).toBe(rec.createdAt);
        expect(await storage.sessions.update(randomUUID(), { title: "x" })).toBe(false);
      });

      it("相同值更新 numAffected=0 时按存在性判定（与 SQLite changes=0 同语义），仍返回 true", async () => {
        const rec = sessionRecord();
        await storage.sessions.create(rec);
        expect(await storage.sessions.update(rec.id, { title: rec.title, updatedAt: rec.updatedAt })).toBe(true);
      });

      it("backfillSystemPrompt 只补 system_prompt 为 null 的历史会话，已有记录不可覆盖", async () => {
        await storage.sessions.create(sessionRecord({ id: randomUUID(), systemPrompt: null }));
        await storage.sessions.create(sessionRecord({ id: randomUUID(), systemPrompt: "历史提示词" }));
        expect(await storage.sessions.backfillSystemPrompt("服务端提示词")).toBe(1);
        const rows = await storage.sessions.listByOwner(OWNER_A);
        expect(rows.some((r) => r.systemPrompt === "服务端提示词")).toBe(true);
        expect(rows.some((r) => r.systemPrompt === "历史提示词")).toBe(true);
      });
    });

    describe("conversation reservation tombstone（deleted artifact 永久禁止复用）", () => {
      async function seedSession(): Promise<string> {
        const id = randomUUID();
        await storage.sessions.create(sessionRecord({ id }));
        return id;
      }

      async function seedTombstone(operationKey: string, state: FileOperationState): Promise<void> {
        await storage.kysely
          .insertInto("file_operations")
          .values({
            id: randomUUID(),
            operation_key: operationKey,
            kind: "delete",
            relative_path: "sessions/tombstone/history.jsonl",
            state,
            attempt_count: 0,
            available_at: 0,
            created_at: 0,
            updated_at: 0,
          })
          .execute();
      }

      it("已存在 pending / processing / completed / failed tombstone 都禁止 reservation（会话 ref 保持 NULL）", async () => {
        for (const state of FILE_OPERATION_STATES) {
          const id = await seedSession();
          const key = `tombstone-${state}`;
          await seedTombstone(key, state);
          expect(
            await storage.sessions.reserveConversation(id, {
              conversationRef: "/tmp/sessions/blocked.jsonl",
              tombstoneOperationKey: key,
            }),
          ).toBe(false);
          expect((await storage.sessions.get(id))?.conversationRef).toBeNull();
        }
      });

      it("无 tombstone 时可成功 reservation 并写入 ref", async () => {
        const id = await seedSession();
        expect(
          await storage.sessions.reserveConversation(id, {
            conversationRef: "/tmp/sessions/free.jsonl",
            tombstoneOperationKey: "no-tombstone",
          }),
        ).toBe(true);
        expect((await storage.sessions.get(id))?.conversationRef).toBe("/tmp/sessions/free.jsonl");
      });

      it("存在 tombstone 但操作键不同时 reservation 成功（键是 artifact 级维度）", async () => {
        const id = await seedSession();
        await seedTombstone("tombstone-a", "pending");
        expect(
          await storage.sessions.reserveConversation(id, {
            conversationRef: "/tmp/sessions/other.jsonl",
            tombstoneOperationKey: "tombstone-b",
          }),
        ).toBe(true);
        expect((await storage.sessions.get(id))?.conversationRef).toBe("/tmp/sessions/other.jsonl");
      });
    });

    describe("artifact delete operationKey：不含 sessionId，同 artifact 恒定", () => {
      it("同 agent kind/format/相对路径 恒定；改变任一维度生成不同键；不含 sessionId", () => {
        const key = artifactDeleteOperationKey("pi", "pi-jsonl-v3", "sessions/s1/history.jsonl");
        expect(key).not.toContain("s1");
        expect(artifactDeleteOperationKey("pi", "pi-jsonl-v3", "sessions/s1/history.jsonl")).toBe(key);
        expect(artifactDeleteOperationKey("pi", "pi-jsonl-v3", "sessions/s2/history.jsonl")).not.toBe(key);
        expect(artifactDeleteOperationKey("pi", "pi-jsonl-v2", "sessions/s1/history.jsonl")).not.toBe(key);
      });
    });

    describe("idempotency：ON CONFLICT 覆盖 + TTL prune 精确 cutoff", () => {
      it("put 后 get 返回结果；不同 session 同 requestId 互不影响；重复 put 覆盖同一 requestId", async () => {
        const s1 = randomUUID();
        const s2 = randomUUID();
        expect(await storage.idempotency.get(s1, "r-1")).toBeNull();
        await storage.idempotency.put(s1, "r-1", { status: "completed", echo: ["a"] });
        expect(await storage.idempotency.get(s1, "r-1")).toEqual({ status: "completed", echo: ["a"] });
        await storage.idempotency.put(s1, "r-1", { status: "completed", echo: ["b"] });
        expect(await storage.idempotency.get(s1, "r-1")).toEqual({ status: "completed", echo: ["b"] });
        expect(await storage.idempotency.get(s2, "r-1")).toBeNull();
      });

      it("prune 精确 cutoff：只删 created_at < before；before 与 before+1 保留；返回删除数", async () => {
        const before = 5000;
        const sids = [randomUUID(), randomUUID(), randomUUID()] as const;
        await storage.idempotency.put(sids[0], "before-1", { status: "completed" });
        await storage.idempotency.put(sids[1], "at-before", { status: "completed" });
        await storage.idempotency.put(sids[2], "after-before", { status: "completed" });
        // 直接改 created_at（Kysely 方言无关）；put 内部用 Date.now()，需要精确打点
        await storage.kysely
          .updateTable("idempotency")
          .set({ created_at: before - 1 })
          .where("session_id", "=", sids[0])
          .execute();
        await storage.kysely
          .updateTable("idempotency")
          .set({ created_at: before })
          .where("session_id", "=", sids[1])
          .execute();
        await storage.kysely
          .updateTable("idempotency")
          .set({ created_at: before + 1 })
          .where("session_id", "=", sids[2])
          .execute();

        const deleted = await storage.idempotency.prune(before);
        expect(deleted).toBe(1);
        expect(await storage.idempotency.get(sids[0], "before-1")).toBeNull();
        expect(await storage.idempotency.get(sids[1], "at-before")).toEqual({ status: "completed" });
        expect(await storage.idempotency.get(sids[2], "after-before")).toEqual({ status: "completed" });
      });
    });
  });
}