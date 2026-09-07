// 测试共享存储初始化：对给定的 DatabaseSync 运行真实初始化路径（WAL + Kysely schema bootstrap），
// 返回 Kysely 实例与三个 Repository；默认项目经 Repository.ensureDefaultProject 创建。
// 所有依赖建表/初始化的测试统一走这里，避免与真实启动路径分叉。
//
// 资源所有权（M2）：fixture 暴露统一 Kysely destroy close（复用生产 createIdempotentStorageCloser），
// 测试按真实所有权关闭（close() → kysely.destroy() → NodeSqliteAdapter.close → DatabaseSync.close），
// 不得直接 db.close() 绕过 Kysely。

import { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { sqliteConstraintErrorMapper } from "../../src/storage/sqlite-constraint-errors.js";
import { KyselyProjectRepository } from "../../src/storage/kysely-project-repository.js";
import { KyselySessionRepository } from "../../src/storage/kysely-session-repository.js";
import { KyselyIdempotencyRepository } from "../../src/storage/kysely-idempotency-repository.js";
import { KyselyFileOperationRepository } from "../../src/storage/kysely-file-operation-repository.js";
import { artifactDeleteOperationKey, relativeWhitelistedPath } from "../../src/storage/file-operation-policy.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import type { ConversationDescriptor } from "../../src/application/ports/conversation-port.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import { createIdempotentStorageCloser } from "../../src/server/storage-close.js";

export const DEFAULT_CWD = "/tmp/default-project";

/** 已初始化 fixture：共享 Kysely、三个 Repository、复用生产中同一幂等 closer 的 close()。 */
export type SqliteTestStorage = {
  /** 底层 DatabaseSync（由 Kysely/adapter 支配，测试应经 close() 关闭而非直接 db.close()）。 */
  db: DatabaseSync;
  kysely: Kysely<DatabaseSchema>;
  projects: KyselyProjectRepository;
  sessions: KyselySessionRepository;
  idempotency: KyselyIdempotencyRepository;
  fileOperations: KyselyFileOperationRepository;
  /** 统一 Kysely destroy close（幂等：多次调用只真正 destroy 一次）。 */
  close: () => Promise<void>;
};

export async function initStorage(
  db: DatabaseSync,
  opts: { cwd?: string; dataDir?: string } = {},
): Promise<SqliteTestStorage> {
  const kysely = await initializeDatabase(db);
  const fileOperations = new KyselyFileOperationRepository(kysely, "sqlite");
  const root = opts.dataDir ?? opts.cwd ?? DEFAULT_CWD;
  const fileOperationOptions = {
    fileOperations,
    cleanupPlan: ({ sessionId, projectId, conversation }: { sessionId: string; projectId: string; conversation: ConversationDescriptor }) => {
      if (conversation.conversationRef === null) return null;
      const relativePath = relativeWhitelistedPath(root, conversation.conversationRef);
      return {
        operationKey: artifactDeleteOperationKey(
          conversation.agentKind,
          conversation.conversationFormat,
          relativePath,
        ),
        kind: "delete" as const,
        relativePath,
        sessionId,
        projectId,
      };
    },
  } as const;
  const projects = new KyselyProjectRepository(kysely, sqliteConstraintErrorMapper, fileOperationOptions);
  await projects.ensureDefaultProject({
    id: DEFAULT_PROJECT_ID,
    name: "默认项目",
    cwd: opts.cwd ?? DEFAULT_CWD,
    ownerKey: "",
    createdAt: 0,
  });
  return {
    projects,
    sessions: new KyselySessionRepository(kysely, sqliteConstraintErrorMapper, fileOperationOptions),
    idempotency: new KyselyIdempotencyRepository(kysely),
    fileOperations,
    kysely,
    db,
    close: createIdempotentStorageCloser(async () => {
      await kysely.destroy();
    }),
  };
}

/** 创建一个已初始化的 :memory: 数据库（含默认项目）。 */
export async function makeInitializedMemoryDb(opts: { cwd?: string; dataDir?: string } = {}) {
  const db = new DatabaseSync(":memory:");
  return initStorage(db, opts);
}