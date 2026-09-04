// 方言约束错误 → 存储无关错误的中立映射器契约（工作包 C：Repository 方言中立化）。
//
// Kysely CRUD Repository（kysely-*-repository.ts）不识别任何底层数据库错误码；
// 具体方言的约束错误映射（SQLite 1555/2067/787 / PG SQLSTATE 23505/23503）由
// 各自的 mapper 实现注入到 Repository 构造函数。application 层只依赖存储无关错误
// （DuplicateIdError / ProjectForeignKeyError，见 application/ports/store-errors.ts）。

export interface ConstraintErrorMapper {
  /** Optional dialect hint for repository transaction locking; error mapping remains the primary contract. */
  readonly dialect?: "sqlite" | "postgres";
  /** 该错误是否为「外键约束失败」（Repository 依此先映射外键再映射 id）。 */
  isForeignKeyError(error: unknown): boolean;
  /**
   * 撞实体自身 id 主键/唯一约束冲突 → 抛存储无关 DuplicateIdError（保留 cause）；
   * 非该冲突（如复合唯一约束、非 id 列唯一索引、外键错误、普通错误）原样重新抛出。
   * 恒为 never 返回：调用方不会从该函数正常返回。
   */
  throwDuplicateIdOrOriginal(error: unknown, table: string): never;
  /**
   * 外键约束失败 → 抛存储无关 ProjectForeignKeyError（保留 cause）；
   * 非外键错误原样重新抛出。恒为 never 返回。
   */
  throwProjectForeignKeyOrOriginal(error: unknown): never;
}