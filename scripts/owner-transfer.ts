#!/usr/bin/env node
// WP5D-4 IP→IP owner transfer 离线 CLI。设计边界：
// - 只做 DB 层 owner 转移：仅更新 projects.owner_key / sessions.owner_key；
//   不迁移策略文件 IP 条目、token 绑定或角色（接收方继承自己的 IP 画像）；
// - apply 顺序固定：pre-owner-transfer 加密备份 → backup 验证 → target binding 复验 →
//   事务内 transfer/verify；任何失败不报成功、无自动 restore；
// - dry-run 零写入（SQLite 断言 DB/WAL/SHM 字节零变；PG 只读事务计划）；
// - --maintenance-window CONFIRMED 是运维声明，不是进程锁；
// - 报告只含 subject sha256 / counts / backup 元信息，绝不输出原始 IP/owner/path/url。

import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSqliteBackup, verifyPublishedBackup } from "../src/backup/backup-core.js";
import { createPostgresBackup, parsePostgresConnectionUrl, redactPgDiagnostic } from "../src/backup/postgres-backup-core.js";
import {
  analyzeSqliteOwnerTransferReadOnly,
  assertSqliteOwnerTransferDryRunUnchanged,
  authorizeOwnerTransfer,
  openPostgresOwnerTransferGate,
  OWNER_TRANSFER_USAGE,
  ownerKeyForIp,
  parseOwnerTransferArgs,
  revalidateSqliteOwnerTransferTarget,
  resolveSqliteOwnerTransferTarget,
  runOwnerTransfer,
  runSqliteOwnerTransfer,
  sqliteOwnerTransferFingerprints,
  subjectHashForIp,
  validateOwnerTransferSchema,
  type OwnerTransferCliOptions,
  type SqliteOwnerTransferTarget,
} from "../src/owner-transfer/owner-transfer-core.js";
import { createPostgresPool } from "../src/storage/postgres-bootstrap.js";
import {
  resolveBackupCliPaths,
  resolveStorageConfig,
  validateMigrationCliPathValues,
  type StorageEnvironment,
} from "../src/storage/storage-config.js";
import type { StageReporter } from "../src/backup/stage-guard.js";
import { redactedMessage } from "./migrate.js";

/**
 * SQLite dry-run：先对 DB/WAL/SHM 做字节指纹，再用 os tmpdir 下的只读快照副本分析
 * （绝不直接打开源库，保证源库 DB/WAL/SHM 字节零变），最后断言源库三件套指纹一致。
 * 快照临时目录 0700、用毕即删；任何变化都 fail-closed。
 */
async function planSqliteOwnerTransfer(
  cli: OwnerTransferCliOptions,
  target: SqliteOwnerTransferTarget,
): Promise<unknown> {
  const before = sqliteOwnerTransferFingerprints(target.dbPath);
  const snapshot = mkdtempSync(path.join(tmpdir(), "pi-owner-transfer-plan-"));
  try {
    const copy = path.join(snapshot, "snapshot.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${target.dbPath}${suffix}`;
      if (existsSync(source)) copyFileSync(source, `${copy}${suffix}`);
    }
    const db = new DatabaseSync(copy, { timeout: 5000, readOnly: true, enableForeignKeyConstraints: true });
    let plan;
    try {
      plan = analyzeSqliteOwnerTransferReadOnly(db, ownerKeyForIp(cli.sourceIp), ownerKeyForIp(cli.targetIp));
    } finally {
      try { db.close(); } catch { /* preserve the analysis error */ }
    }
    assertSqliteOwnerTransferDryRunUnchanged(before, target.dbPath);
    return {
      status: "planned",
      mode: "dry-run",
      dialect: "SQLite",
      sourceSubjectHash: subjectHashForIp(cli.sourceIp),
      targetSubjectHash: subjectHashForIp(cli.targetIp),
      planned: {
        projectsTransferred: plan.projectsTransferred,
        sessionsTransferred: plan.sessionsTransferred,
        defaultProjectOwnerPreserved: plan.defaultProjectOwnerPreserved,
      },
      steps: ["read-only snapshot copy of the target DB/WAL/SHM in a private temp dir (the source is never opened for writing)", "read-only owner-row analysis (projects + sessions)", "plan validation (default project row owner '', empty target owner, non-empty source, no cross-pointing references)", "fingerprint re-assertion: target DB/WAL/SHM byte-identical -> zero writes (no backup is created in dry-run)"],
      preserved: ["default project row keeps owner '' (shared)", "policy file IP entries / token bindings / roles are never migrated", "JSONL session/project files and the credential path are never modified or transferred"],
    };
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

async function runSqliteApply(cli: OwnerTransferCliOptions, environment: StorageEnvironment): Promise<void> {
  const target = resolveSqliteOwnerTransferTarget(environment, cli);
  const paths = resolveBackupCliPaths(environment, cli.backupRoot!, cli.ageRecipientFile!, environment.AGENT_CWD!);
  const authorization = authorizeOwnerTransfer(cli);
  const report: StageReporter = (stage, state) => console.log(`[owner-transfer] stage=${stage} state=${state}`);
  const sourceOwnerKey = ownerKeyForIp(cli.sourceIp);
  const targetOwnerKey = ownerKeyForIp(cli.targetIp);
  const result = await runOwnerTransfer(authorization, {
    createBackup: () => createSqliteBackup({ paths: { ...paths, authPath: target.authPath }, backupKind: "pre-owner-transfer", stagingRoot: environment.PI_BACKUP_STAGING_ROOT }),
    verifyBackup: verifyPublishedBackup,
    revalidateBeforeTransfer: (verification) => revalidateSqliteOwnerTransferTarget(environment, cli, target, verification),
    transfer: () => {
      const db = new DatabaseSync(target.dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
      try { return runSqliteOwnerTransfer(db, sourceOwnerKey, targetOwnerKey); }
      finally { try { db.close(); } catch { /* preserve the transfer result/error */ } }
    },
  }, { dialect: "SQLite", sourceSubjectHash: subjectHashForIp(cli.sourceIp), targetSubjectHash: subjectHashForIp(cli.targetIp), onStage: report });
  console.log(JSON.stringify(result));
}

async function runPostgres(cli: OwnerTransferCliOptions, environment: StorageEnvironment): Promise<void> {
  if (environment.PI_STORAGE_DIALECT?.trim().toLowerCase() !== "postgres") {
    throw new Error("owner-transfer: PostgreSQL requires explicit PI_STORAGE_DIALECT=postgres");
  }
  if (!cli.targetSchema) throw new Error(`${OWNER_TRANSFER_USAGE}；PostgreSQL 需要显式 --target-schema`);
  const storage = resolveStorageConfig({}, "", environment);
  if (storage.dialect !== "postgres") throw new Error("owner-transfer: PostgreSQL dialect resolution failed safely");
  const schema = validateOwnerTransferSchema(cli.targetSchema);
  const parsed = parsePostgresConnectionUrl(storage.databaseUrl);
  const paths = resolveBackupCliPaths(environment, cli.backupRoot!, cli.ageRecipientFile!, environment.AGENT_CWD!);
  const sourceOwnerKey = ownerKeyForIp(cli.sourceIp);
  const targetOwnerKey = ownerKeyForIp(cli.targetIp);
  const pool = createPostgresPool(storage.databaseUrl, {
    connectionTimeoutMillis: 5_000,
    statementTimeoutMs: 20_000,
    queryTimeoutMs: 20_000,
  });
  const gate = openPostgresOwnerTransferGate(pool, parsed.database, schema, sourceOwnerKey, targetOwnerKey);
  try {
    if (cli.mode === "dry-run") {
      const plan = await gate.transfer("dry-run");
      console.log(JSON.stringify({
        status: "planned",
        mode: "dry-run",
        dialect: "PostgreSQL",
        sourceSubjectHash: subjectHashForIp(cli.sourceIp),
        targetSubjectHash: subjectHashForIp(cli.targetIp),
        planned: {
          projectsTransferred: plan.projectsTransferred,
          sessionsTransferred: plan.sessionsTransferred,
          defaultProjectOwnerPreserved: plan.defaultProjectOwnerPreserved,
        },
        steps: ["independent READ ONLY REPEATABLE READ transaction on a dedicated client (no backup is created in dry-run)", "session-level pg_advisory_lock(POSTGRES_MIGRATION_LOCK_KEY) taken with a parametrized SELECT before BEGIN (conflicts with the migration xact lock) + current_database()/current_schema() re-verify", "plan validation (default project row owner '', empty target owner, non-empty source, no cross-pointing references)", "ROLLBACK + explicit pg_advisory_unlock (verified true): zero writes"],
        preserved: ["default project row keeps owner '' (shared)", "policy file IP entries / token bindings / roles are never migrated", "JSONL session/project files and the credential path are never modified"],
      }));
      return;
    }
    const authorization = authorizeOwnerTransfer(cli);
    const report: StageReporter = (stage, state) => console.log(`[owner-transfer] stage=${stage} state=${state}`);
    const result = await runOwnerTransfer(authorization, {
      createBackup: () => createPostgresBackup({
        storageDialect: "postgres",
        databaseUrl: storage.databaseUrl,
        paths: { dataDir: paths.dataDir, agentDir: paths.agentDir, authPath: paths.authPath, backupRoot: paths.backupRoot, ageRecipientFile: paths.ageRecipientFile },
        backupKind: "pre-owner-transfer",
        // Missing session references are missing-as-empty (confirmed Phase 3
        // semantics): they are recorded in the encrypted manifest and the
        // pre-owner-transfer backup still publishes. A later restore of this
        // anchor normalizes the corresponding sessions.conversation_ref to NULL.
        stagingRoot: environment.PI_BACKUP_STAGING_ROOT,
        onStage: report,
      }),
      verifyBackup: verifyPublishedBackup,
      revalidateBeforeTransfer: (verification) => gate.revalidate(verification),
      transfer: () => gate.transfer("apply"),
    }, { dialect: "PostgreSQL", sourceSubjectHash: subjectHashForIp(cli.sourceIp), targetSubjectHash: subjectHashForIp(cli.targetIp), onStage: report });
    console.log(JSON.stringify(result));
  } finally {
    await gate.cleanup();
    await pool.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// 统一 CLI 错误边界（reviewer 修复）
//
// CLI 对外只输出稳定类别 + 脱敏文本，绝不透传底层连接/query 原文，输出不得包含
// 任何 IPv4/IPv6/hostname/path/url/凭证输入值：
// - code=usage（退出码 2）：参数用法文本（用法文本本身不含任何输入值）；
// - code=connection（退出码 1）：网络/连接类失败（ECONNREFUSED、ENOTFOUND、
//   EAI_AGAIN、IPv6/IPv4 连接拒绝等）——输出固定脱敏文案，绝不包含地址信息；
// - code=internal（退出码 1）：内部 fail-closed 错误；只放行已知安全前缀的消息
//   （owner-transfer:/backup:/strict completeness:/migration CLI rejects/
//   pre-migration: 等），其余一律替换为稳定文案；任何放行消息在输出前仍会再次
//   剥除 URL/路径/IP/主机名/凭证。
// ---------------------------------------------------------------------------

export type OwnerTransferCliErrorCode = "usage" | "connection" | "internal";

const OWNER_TRANSFER_SAFE_ERROR_PREFIX = /^(?:\[)?(?:owner-transfer:|backup:|strict completeness:|migration CLI rejects|pre-migration:)/;
const OWNER_TRANSFER_NETWORK_FAILURE =
  /\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAFNOSUPPORT|EADDRNOTAVAIL|ECONNRESET|ECONNABORTED|EPIPE|ENOTCONN|ESOCKETTIMEDOUT)\b|\bgetaddrinfo\b|\bsocket hang up\b|\bcould not connect to server\b/i;
// Statement-echo guard: raw SQL statement text must never reach the CLI surface.
// COMMIT/ROLLBACK are deliberately excluded — our own fail-closed messages use
// the prose "rolling back", and a bare COMMIT/ROLLBACK echo carries no target info.
const OWNER_TRANSFER_SQL_ECHO = /\b(?:SELECT|UPDATE|INSERT INTO|DELETE FROM|BEGIN ISOLATION|CREATE TABLE|ALTER TABLE|DROP TABLE)\b/i;

/** 输出前最终脱敏：URL/路径/凭证由既有 redactor 处理，再剥除网络目标字面量。 */
export function sanitizeOwnerTransferDiagnostic(raw: string): string {
  let message = redactedMessage(redactPgDiagnostic(raw), process.env.PI_DATABASE_URL?.trim());
  // Network target literals that the lower-level redactors may not cover:
  // IPv4 (with optional :port), bracketed/bare IPv6, and dotted hostnames.
  message = message.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, "[redacted address]");
  message = message.replace(/\[[0-9a-fA-F:.]{2,}\](?::\d{1,5})?/g, "[redacted address]");
  message = message.replace(/(?<![A-Za-z0-9])(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?::\d{1,5})?(?![A-Za-z0-9])/g, "[redacted address]");
  message = message.replace(/\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?::\d{1,5})?\b/g, "[redacted host]");
  message = message.trim();
  return message === "" ? "the operation failed; details withheld" : message;
}

/** 稳定错误码类别 + 稳定退出码（usage=2，其余=1）；消息绝不携带输入值。 */
export function renderOwnerTransferCliError(error: unknown): { readonly code: OwnerTransferCliErrorCode; readonly message: string; readonly exitCode: number } {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.startsWith("用法：")) return { code: "usage", message: raw, exitCode: 2 };
  if (OWNER_TRANSFER_NETWORK_FAILURE.test(raw)) {
    return { code: "connection", message: "connection to the target database failed; details withheld", exitCode: 1 };
  }
  const sanitized = sanitizeOwnerTransferDiagnostic(raw);
  if (OWNER_TRANSFER_SAFE_ERROR_PREFIX.test(sanitized) && !OWNER_TRANSFER_SQL_ECHO.test(sanitized)) {
    return { code: "internal", message: sanitized, exitCode: 1 };
  }
  if (OWNER_TRANSFER_SQL_ECHO.test(sanitized)) {
    return { code: "internal", message: "a database operation failed; details withheld", exitCode: 1 };
  }
  return { code: "internal", message: "the operation failed; details withheld", exitCode: 1 };
}

async function main(): Promise<void> {
  const cli = parseOwnerTransferArgs(process.argv.slice(2));
  const environment = process.env as StorageEnvironment;
  validateMigrationCliPathValues(environment);
  if (environment.PI_STORAGE_DIALECT?.trim().toLowerCase() === "postgres") {
    await runPostgres(cli, environment);
  } else if (cli.mode === "dry-run") {
    const target = resolveSqliteOwnerTransferTarget(environment, cli);
    console.log(JSON.stringify(await planSqliteOwnerTransfer(cli, target)));
  } else {
    await runSqliteApply(cli, environment);
  }
}

function isCliEntry(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isCliEntry()) {
  void main().catch((error: unknown) => {
    const rendered = renderOwnerTransferCliError(error);
    console.error(`[owner-transfer] code=${rendered.code} ${rendered.message}`);
    process.exitCode = rendered.exitCode;
  });
}