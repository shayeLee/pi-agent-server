// 从运行时 Schema Manifest 自动推导 Kysely DatabaseSchema 类型（工作包 B）。
//
// - 逻辑列类型 → TypeScript 类型映射：uuid/text/json → string；integer/bigint → number。
//   json 在当前 SQLite 是 TEXT 文本、由 Repository JSON.parse 读回；逻辑类型为 json 时
//   存储类型仍是 string（null 语义由列级 nullable 表达，见 ColumnNullableType）。
// - DatabaseSchema 由 schemaManifest 值推导：表名、列名、nullable 全部来自 Manifest，
//   不再手写任何表 interface（db-schema.ts 仅保留兼容 re-export）。
// - 本文件保留运行期对 schemaManifest 的引用（仅用于 `typeof` 类型推导）。

import { schemaManifest, type LogicalColumnType, type TableManifest } from "./schema-manifest.js";

/** 逻辑列类型 → 存储层的 TypeScript 类型（不含 nullable）。 */
export type ColumnLogicalTsType<T extends LogicalColumnType> = T extends "uuid" | "text" | "json"
  ? string
  : T extends "integer" | "bigint"
    ? number
    : never;

/** 逻辑列类型 + nullable → Kysely 行的列类型（nullable 列追加 `| null`）。 */
export type ColumnNullableType<T extends LogicalColumnType, N extends boolean> = N extends true
  ? ColumnLogicalTsType<T> | null
  : ColumnLogicalTsType<T>;

type TableColumnsFrom<TB extends TableManifest> = {
  [CName in TB["columns"][number]["name"]]: ColumnNullableType<
    Extract<TB["columns"][number], { name: CName }>["type"],
    Extract<TB["columns"][number], { name: CName }>["nullable"]
  >;
};

/** 由保留字面量类型的 Manifest 值推导 DatabaseSchema。 */
export type DatabaseSchemaFromManifest<M extends { readonly tables: readonly TableManifest[] }> = {
  [TName in M["tables"][number]["name"]]: TableColumnsFrom<Extract<M["tables"][number], { name: TName }>>;
};

/** 当前数据库的 Kysely 类型化 schema —— 完全由 schemaManifest 推导。 */
export type DatabaseSchema = DatabaseSchemaFromManifest<typeof schemaManifest>;

// ---------------------------------------------------------------------------
// 编译期自检（build 门禁：若推导回归，tsc 直接报错）
// ---------------------------------------------------------------------------

type Assert<T extends true> = T;
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

type _AssertProjectsId = Assert<Equal<DatabaseSchema["projects"]["id"], string>>;
type _AssertProjectsCreatedAt = Assert<Equal<DatabaseSchema["projects"]["created_at"], number>>;
type _AssertSessionsPiSessionFile = Assert<Equal<DatabaseSchema["sessions"]["pi_session_file"], string | null>>;
type _AssertSessionsProjectId = Assert<Equal<DatabaseSchema["sessions"]["project_id"], string>>;
type _AssertIdempotencyResult = Assert<Equal<DatabaseSchema["idempotency"]["result"], string>>;
type _AssertIdempotencyPkCols = Assert<Equal<keyof DatabaseSchema["idempotency"], "session_id" | "request_id" | "result" | "created_at">>;
type _AssertFileOperationRelativePath = Assert<Equal<DatabaseSchema["file_operations"]["relative_path"], string>>;
type _AssertFileOperationLeaseUntil = Assert<Equal<DatabaseSchema["file_operations"]["lease_until"], number | null>>;