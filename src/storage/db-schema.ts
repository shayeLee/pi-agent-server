// Kysely 类型化数据库 schema（snake_case 列名）。
//
// 工作包 B 起，本文件的表 interface 不再手工维护：DatabaseSchema 由运行时 Schema Manifest
// （src/storage/schema-manifest.ts）自动推导（schema-types.ts），本文件仅作为兼容出口
// re-export，避免既有 import 大面积改名。领域记录（camelCase）与数据库行（snake_case）
// 的映射仍由各 Repository 的 toRecord 负责。

export type { DatabaseSchema } from "./schema-types.js";