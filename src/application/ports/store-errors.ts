// application 层存储无关错误（Port 契约的异常侧）。
//
// 服务端业务 ID（projects.id / sessions.id）由应用层 createId（randomUUID）生成，
// 理论上存在撞库的极低概率。各具体存储实现把「实体自身主键/唯一约束冲突」转换为
// DuplicateIdError 并保留原始 cause：
//   - SQLite：PRIMARY KEY / UNIQUE 约束错误（1555 / 2067，且冲突列恰好为该实体自身的 id 列）
//     → DuplicateIdError（见 src/storage/sqlite-constraint-errors.ts）
//   - 未来 PG：unique_violation（SQLSTATE 23505）复用同一错误
// 应用层据此用新 ID 做有界重试。
//
// sessions.project_id 外键引用失效（并发删除项目竞态）由各具体存储实现转换为
// ProjectForeignKeyError 并保留原始 cause：
//   - SQLite：外键约束错误（787 = SQLITE_CONSTRAINT_FOREIGNKEY）
//   - 未来 PG：foreign_key_violation（SQLSTATE 23503）复用同一错误
// 应用层据此返回 project-not-found，不重试不转换。
//
// 非本类错误（中定义的两种）一律按原样抛出，绝不吞掉。

/** 实体自身主键/唯一 ID 冲突（存储无关）：应用层应生成新 ID 并做有界重试。 */
export class DuplicateIdError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DuplicateIdError";
  }
}

/** 会话归属项目外键冲突（存储无关）：sessions.project_id 引用的项目在写入前已被删除。
 *  应用层应返回 project-not-found（不重试、不转换）。 */
export class ProjectForeignKeyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProjectForeignKeyError";
  }
}