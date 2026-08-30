// PostgreSQL int8（BIGINT）→ 安全 JS number 的读回边界（工作包 C）。
//
// node-postgres 默认把 BIGINT（OID 20）读回为 string，以避免 JavaScript 精度丢失；
// 本服务的时间戳列（created_at/updated_at）在 PG 侧是 BIGINT（毫秒），必须读回为 number。
//
// 处理：
// - parsePgInt8：把 pg 给到的 int8 文本转为 JS number，并**显式拒绝**超出
//   Number.MAX_SAFE_INTEGER 的值（抛错而非静默丢精度）。本服务的毫秒时间戳当前约 1.7e12，
//   远低于 9e15 的安全上限，正常数据永不触发；触发即视为数据异常，宁可失败也不静默失真。
// - createPgInt8SafeTypes：构造 per-pool 的 CustomTypes（pg Pool 配置的 types 字段），
//   只对使用该配置的 Pool 生效，不污染进程级 pg 全局类型解析；OID 20 之外的解析保持 pg 默认。
//   由 postgres-bootstrap.createPostgresPool 组装进连接配置（PG storage 边界内生效）。

import { TypeOverrides, types as pgTypes } from "pg";

/** int8（BIGINT）文本 → 安全 JS number；超出 Number.MAX_SAFE_INTEGER 时显式抛错（拒绝丢精度）。 */
export function parsePgInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `PostgreSQL BIGINT 值 ${value} 超出 JS 安全整数范围（Number.MAX_SAFE_INTEGER=${Number.MAX_SAFE_INTEGER}），` +
        `拒绝转为 number（会丢失精度）`,
    );
  }
  return parsed;
}

/** 构造只把 int8 读为安全 number 的 per-pool CustomTypes 配置（其余类型沿用 pg 默认）。 */
export function createPgInt8SafeTypes(): { getTypeParser: (oid: number, format?: string | undefined) => (value: string) => unknown } {
  const overrides = new TypeOverrides(pgTypes);
  // Text 格式的 int8（OID 20）在 pg 默认解析下返回原样字符串；这里替换为安全 number 解析。
  overrides.setTypeParser(20, parsePgInt8);
  return {
    getTypeParser(oid, format) {
      // @types/pg 的 TypeParser 泛型默认是 (oid: number) => any，实际运行时收的是对应 OID 的原生文本值；
      // 这里按 pg 运行期契约（(value: string) => unknown）窄化。
      return overrides.getTypeParser(oid, format as "text" | "binary") as unknown as (value: string) => unknown;
    },
  };
}