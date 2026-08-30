// 测试共享存储初始化：对给定的 DatabaseSync 运行真实初始化路径（WAL + Kysely schema bootstrap），
// 返回 Kysely 实例与三个 Repository；默认项目经 Repository.ensureDefaultProject 创建。
// 所有依赖建表/初始化的测试统一走这里，避免与真实启动路径分叉。

import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { SqliteProjectRepository } from "../../src/storage/sqlite-project-repository.js";
import { SqliteSessionRepository } from "../../src/storage/sqlite-session-repository.js";
import { SqliteIdempotencyRepository } from "../../src/storage/sqlite-idempotency-repository.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";

export const DEFAULT_CWD = "/tmp/default-project";

export async function initStorage(
  db: DatabaseSync,
  opts: { cwd?: string } = {},
): Promise<{
  db: DatabaseSync;
  projects: SqliteProjectRepository;
  sessions: SqliteSessionRepository;
  idempotency: SqliteIdempotencyRepository;
}> {
  const kysely = await initializeDatabase(db);
  const projects = new SqliteProjectRepository(kysely);
  await projects.ensureDefaultProject({
    id: DEFAULT_PROJECT_ID,
    name: "默认项目",
    cwd: opts.cwd ?? DEFAULT_CWD,
    ownerKey: "",
    createdAt: 0,
  });
  return {
    projects,
    sessions: new SqliteSessionRepository(kysely),
    idempotency: new SqliteIdempotencyRepository(kysely),
    db,
  };
}

/** 创建一个已初始化的 :memory: 数据库（含默认项目）。 */
export async function makeInitializedMemoryDb(opts: { cwd?: string } = {}) {
  const db = new DatabaseSync(":memory:");
  return initStorage(db, opts);
}
