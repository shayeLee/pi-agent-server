// Kysely ↔ node:sqlite 兼容适配器（Phase 1 存储层演进的关键薄层）。
//
// Kysely 的 SqliteDialect（sqlite-driver.js）按 better-sqlite3 的接口期待 Statement：
//   - stmt.all(parameters: array) / stmt.run(parameters: array) / stmt.iterate(parameters: array)
//   - stmt.reader: boolean 决定走 rows 还是 { changes, lastInsertRowid }
// 而 Node 内置 node:sqlite 的 StatementSync：
//   - 是可变参数签名（...anonymousParameters），需要把数组展开；
//   - 在当前 Node（≤ v22.22.2）没有 reader 属性。
//
// reader 的可靠判定：Node 原生 stmt.columns() 返回列元数据数组——
//   SELECT、WITH … SELECT、以及所有 INSERT/UPDATE/DELETE … RETURNING 都返回列；
//   普通 INSERT/UPDATE/DELETE 与 DDL 返回 []（也覆盖 PRAGMA 查询）。
//   因此以 stmt.columns().length > 0 判定 reader，不依赖 SQL 前缀文本。

import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import type { SqliteDatabase, SqliteStatement } from "kysely";

/** 把 node:sqlite DatabaseSync 适配成 Kysely SqliteDialect 可用的 SqliteDatabase。 */
export class NodeSqliteAdapter implements SqliteDatabase {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(sql: string): SqliteStatement {
    return new NodeStatementAdapter(this.db.prepare(sql));
  }

  // 幂等关闭：node:sqlite 的 DatabaseSync.close() 对已关闭实例二次调用会抛 "database is not open"，
  // 而 Kysely destroy 可能经多个路径触发（startServer 的幂等 closer / 初始化失败路径 / app.close），
  // 且多次 initializeDatabase 会在同一 DatabaseSync 上创建多个 adapter。closed 标志 + try/catch 保证
  // 同一底层 DatabaseSync 只真正 close 一次（已被共享它的其他路径关闭时静默容忍）。
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // 底层 DatabaseSync 已由共享它的另一 adapter/路径关闭，忽略重复关闭。
    }
  }
}

/** StatementSync 的 Kysely 形态包装：数组参数 → 可变参数，提供可靠 reader。 */
class NodeStatementAdapter implements SqliteStatement {
  readonly reader: boolean;

  constructor(private readonly stmt: StatementSync) {
    this.reader = this.stmt.columns().length > 0;
  }

  all(parameters: ReadonlyArray<unknown>): unknown[] {
    // node:sqlite 的绑定值类型为 SQLInputValue；此处由调用方（Kysely 编译的参数）保证类型合法。
    return this.stmt.all(...(parameters as unknown as SQLInputValue[])) as unknown[];
  }

  run(parameters: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.stmt.run(...(parameters as unknown as SQLInputValue[]));
  }

  *iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown> {
    yield* this.stmt.iterate(...(parameters as unknown as SQLInputValue[]));
  }
}
