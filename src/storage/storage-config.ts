import { homedir } from "node:os";
import path from "node:path";

/** Environment/config inputs shared by the service composition root and the offline CLI. */
export interface StoragePathConfigInput {
  readonly cwd?: string;
  readonly dataDir?: string;
  readonly dbPath?: string;
}

export interface StorageEnvironment {
  readonly AGENT_CWD?: string;
  readonly DATA_DIR?: string;
  readonly DB_PATH?: string;
  readonly PI_AGENT_DIR?: string;
  /** Credential file override (same variable as the server entry). */
  readonly PI_AUTH_PATH?: string;
  readonly PI_STORAGE_DIALECT?: string;
  readonly PI_DATABASE_URL?: string;
  /** Explicit absolute plaintext-staging root for backup/migration/cutover CLIs (optional). */
  readonly PI_BACKUP_STAGING_ROOT?: string;
}

export type ResolvedStorage =
  | { readonly dialect: "sqlite"; readonly dbPath: string }
  | { readonly dialect: "postgres"; readonly databaseUrl: string };

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function configured(value: string | undefined, environmentValue: string | undefined): string | undefined {
  return nonBlank(value) ?? nonBlank(environmentValue);
}

/**
 * Pure, shared path resolution. Explicit config wins; blank config/env values are
 * treated as unset. Returned paths are absolute so the service and CLI cannot
 * accidentally point at different files because their process cwd differs.
 */
export function resolveAgentDir(
  dataDir: string,
  configuredAgentDir: string | undefined,
  environment: StorageEnvironment = {},
): string {
  return path.resolve(configured(configuredAgentDir, environment.PI_AGENT_DIR) ?? path.join(dataDir, ".pi-agent"));
}

export function resolveStoragePaths(
  config: StoragePathConfigInput = {},
  environment: StorageEnvironment = {},
  baseCwd: string,
): { readonly cwd: string; readonly dataDir: string; readonly dbPath: string } {
  const cwd = path.resolve(configured(config.cwd, environment.AGENT_CWD) ?? baseCwd);
  const dataDir = path.resolve(configured(config.dataDir, environment.DATA_DIR) ?? cwd);
  const dbPath = path.resolve(
    configured(config.dbPath, environment.DB_PATH) ?? path.join(dataDir, "pi-agent-server.db"),
  );
  return { cwd, dataDir, dbPath };
}

/**
 * Pure, shared dialect/URL resolution. Blank dialect values mean SQLite;
 * non-blank tokens with surrounding whitespace are rejected consistently. A
 * PostgreSQL URL is retained only for connecting, never for CLI target display.
 */
export function validateMigrationCliPathValues(environment: StorageEnvironment): void {
  for (const [name, value] of [["AGENT_CWD", environment.AGENT_CWD], ["DATA_DIR", environment.DATA_DIR], ["DB_PATH", environment.DB_PATH], ["PI_AGENT_DIR", environment.PI_AGENT_DIR], ["PI_AUTH_PATH", environment.PI_AUTH_PATH]] as const) {
    const configuredValue = nonBlank(value);
    if (configuredValue && !path.isAbsolute(configuredValue)) throw new Error(`migration CLI rejects relative ${name}; provide an absolute path`);
  }
}

export function resolveMigrationCliPaths(
  environment: StorageEnvironment,
  baseCwd = process.cwd(),
): { readonly cwd: string; readonly dataDir: string; readonly dbPath: string } {
  const agentCwd = nonBlank(environment.AGENT_CWD);
  if (!agentCwd) throw new Error("migration CLI requires an explicit absolute AGENT_CWD; refusing process-cwd ambiguity");
  if (!path.isAbsolute(agentCwd)) throw new Error("migration CLI requires absolute AGENT_CWD path");
  validateMigrationCliPathValues(environment);
  return resolveStoragePaths({}, environment, baseCwd);
}

/**
 * CLI-side credential path resolution. It mirrors the server default
 * ($HOME/.pi/agent/auth.json) and the PI_AUTH_PATH override so the offline
 * tooling can protect the *actual* credential location instead of guessing a
 * file name. The path is resolved even when the file does not exist: the
 * safety checks below must reject planned deletions/whitelists that would
 * cover the credential location.
 */
export function resolveCliAuthPath(environment: StorageEnvironment): string {
  const configured = nonBlank(environment.PI_AUTH_PATH) ?? nonBlank(process.env.PI_AUTH_PATH);
  if (configured) return path.resolve(configured);
  return path.resolve(homedir(), ".pi", "agent", "auth.json");
}

/** Shared strict path resolution for offline backup tooling. */
export function resolveBackupCliPaths(
  environment: StorageEnvironment,
  backupRoot: string,
  ageRecipientFile: string,
  baseCwd = process.cwd(),
): { readonly cwd: string; readonly dataDir: string; readonly agentDir: string; readonly authPath: string; readonly dbPath: string; readonly backupRoot: string; readonly ageRecipientFile: string } {
  const paths = resolveMigrationCliPaths(environment, baseCwd);
  const root = nonBlank(backupRoot);
  const recipient = nonBlank(ageRecipientFile);
  if (!root || !path.isAbsolute(root)) throw new Error("backup CLI requires an explicit absolute --backup-root");
  if (!recipient || !path.isAbsolute(recipient)) throw new Error("backup CLI requires an explicit absolute --age-recipient-file");
  return {
    ...paths,
    agentDir: resolveAgentDir(paths.dataDir, undefined, environment),
    authPath: resolveCliAuthPath(environment),
    backupRoot: path.resolve(root),
    ageRecipientFile: path.resolve(recipient),
  };
}

export function resolveStorageConfig(
  config: { readonly storageDialect?: string; readonly databaseUrl?: string; readonly dbPath?: string },
  defaultDbPath: string,
  environment: StorageEnvironment = {},
): ResolvedStorage {
  const suppliedDialect = config.storageDialect ?? environment.PI_STORAGE_DIALECT;
  const rawDialect = suppliedDialect === undefined || suppliedDialect.trim() === "" ? "sqlite" : suppliedDialect;
  // Blank values are normalized, but surrounding whitespace on a non-blank
  // token is rejected rather than silently selecting a different dialect.
  const dialect = rawDialect.toLowerCase();
  if (dialect !== "sqlite" && dialect !== "postgres") {
    throw new Error(`未知存储方言：${rawDialect}（仅支持 sqlite / postgres，不静默回退）`);
  }
  if (dialect === "sqlite") {
    return { dialect, dbPath: path.resolve(nonBlank(config.dbPath) ?? defaultDbPath) };
  }
  const databaseUrl = configured(config.databaseUrl, environment.PI_DATABASE_URL);
  if (!databaseUrl) {
    throw new Error("storageDialect=postgres 需要非空 databaseUrl（环境变量 PI_DATABASE_URL），缺失时拒绝启动");
  }
  return { dialect, databaseUrl };
}

export function summarizePostgresTarget(databaseUrl: string): string {
  try {
    const target = new URL(databaseUrl);
    const database = target.pathname.replace(/^\//, "") || "(default database)";
    const port = target.port || (target.protocol.toLowerCase() === "postgres:" ? "5432" : "5432");
    return `PostgreSQL ${target.hostname}:${port}/${database}`;
  } catch {
    return "PostgreSQL target (URL parsed but details withheld)";
  }
}
