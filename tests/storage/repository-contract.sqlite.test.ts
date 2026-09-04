// 共用 Repository 行为契约（H4）—— SQLite 方言注册（始终运行，不 gate）。
// 同一契约集在 tests/postgres/repository-contract.test.ts 由 PG 方言注册（PI_TEST_PG_URL 门控）；
// 每次用例新建 :memory: 库，用例间天然隔离；close() 按真实所有权 destroy Kysely。

import { defineRepositoryContract } from "./repository-contract.js";
import { defineReconcileReferenceContract } from "./reconcile-reference-contract.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";

defineRepositoryContract("共用 Repository 行为契约（SQLite，始终运行）", async () => {
  const storage = await makeInitializedMemoryDb();
  return {
    kysely: storage.kysely,
    projects: storage.projects,
    sessions: storage.sessions,
    idempotency: storage.idempotency,
    close: storage.close,
  };
});

defineReconcileReferenceContract("WP4C 受控只读引用契约（SQLite，始终运行）", async () => {
  const storage = await makeInitializedMemoryDb();
  return {
    kysely: storage.kysely,
    sessions: storage.sessions,
    projects: storage.projects,
    close: storage.close,
  };
});