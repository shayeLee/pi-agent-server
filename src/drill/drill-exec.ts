/**
 * drill live 执行器：编排完整真实演练。它在本次运行唯一的 Podman namespace 中启动
 * scheduler cron、disposable PostgreSQL 16、node_exporter、Prometheus、Alertmanager 与测试
 * webhook；为 SQLite/PostgreSQL 创建合成数据，调用真实编译 backup/restore/migrate，验证恢复，
 * 并通过同一独立 freshness helper 子进程执行完整故障与恢复矩阵。
 *
 * 每个 step 产出 DrillObservation；任何异常被捕获并记为 FAIL。执行器只使用 `PI_DRILL_ROOT`
 * 内路径与 `pi-agent-server-disaster-recovery-drill-` 前缀的 Podman 资源。
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import type { DrillEnv, DrillObservation, DrillAdjudication, DrillPlan, DrillEvidence } from "./drill-core.js";
import {
  collectRedactables,
  redactText,
  validateDrillRoot,
  validateDrillSecrets,
  resolveDrillRoot,
  resolveFormalPaths,
  assertNoFormalOverlap,
  resolveDrillSecrets,
  validateDrillResources,
  defaultDrillPlan,
  adjudicateDrill,
  buildDrillEvidence,
} from "./drill-core.js";
import { parseMachineReport, type MachineReport } from "./drill-helper.js";
import { type FreshnessUpdateRequest, type FreshnessUpdateResult } from "./drill-freshness.js";
import { FAULT_KINDS, guardStepId, recoveryStepId, isAlertCycle, type FaultKind } from "./drill-faults.js";
import { DRILL_RESOURCE_PREFIX, PG_MAJOR } from "./drill-constants.js";
import {
  prepareMonitorStack,
  startMonitorStack,
  stopMonitorStack,
  prometheusQuery,
  prometheusAlertsJson,
  webhookSeen,
  webhookSeenSince,
  webhookRecordCount,
  resetWebhookRecords,
  type MonitorState,
  type MonitorStackConfig,
} from "./drill-monitor.js";
import {
  startScheduler,
  stopScheduler,
  submitRequest,
  pollResult,
  removeRequest,
  fromContainerPath,
  toContainerPath,
  type SchedulerState,
  type SchedulerTrigger,
} from "./drill-scheduler.js";

const require = createRequire(import.meta.url);
type DatabaseSyncT = typeof import("node:sqlite").DatabaseSync;
const DatabaseSync = (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync as DatabaseSyncT;

export { DRILL_RESOURCE_PREFIX } from "./drill-constants.js";
/** fixture 中的有效/缺失引用 session id（固定、非 secret）。 */
const VALID_SESSION_ID = "aaaa0000-0000-4000-8000-000000000001";
const MISSING_SESSION_ID = "bbbb0000-0000-4000-8000-000000000002";
const FIXTURE_PROJECT_ID = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";

export interface DrillExecutor {
  readonly name: string;
  step(stepId: string): Promise<DrillObservation>;
  readonly versions: Record<string, string>;
  cleanup(): Promise<void>;
}

export interface ExecutorContext {
  readonly env: DrillEnv;
  readonly root: string;
  readonly cli: { readonly backup: string; readonly restore: string; readonly migrate: string };
  readonly allowMonitoring: boolean;
}

export interface RunDrillOutcome {
  readonly adjudication: DrillAdjudication;
  readonly observations: readonly DrillObservation[];
  readonly evidence: DrillEvidence;
}

function runCmd(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env });
  if (result.error) return { status: -1, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function probeVersion(command: string): string | null {
  const result = runCmd(command, ["--version"]);
  if (result.status !== 0) return null;
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const match = text.match(/v?(\d+(?:\.\d+){1,3})[A-Za-z0-9._-]*/);
  return match ? match[0] : null;
}

function makeObs(stepId: string, passed: boolean, detail: string, startMs: number, env: DrillEnv, deferred?: boolean): DrillObservation {
  return {
    stepId,
    passed,
    detail: redactText(detail, collectRedactables(env)),
    durationMs: Date.now() - startMs,
    ...(deferred === undefined ? {} : { deferred }),
  };
}

function statSafePerm(file: string): boolean {
  try {
    const st = statSync(file);
    return (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

export interface ProvisionedToolchain {
  readonly podman: string | null;
  readonly age: string | null;
  readonly pgDump: string | null;
  readonly pgRestore: string | null;
  readonly node: string | null;
  readonly missing: readonly string[];
  readonly broken: readonly string[];
}

function probeTool(command: string): { version: string | null; missing: boolean } {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return { version: null, missing: true };
  if (result.status !== 0) return { version: null, missing: false };
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const match = text.match(/v?(\d+(?:\.\d+){1,3})[A-Za-z0-9._-]*/);
  return { version: match ? match[0] : null, missing: false };
}

export function probeToolchain(): ProvisionedToolchain {
  const probes = Object.fromEntries(["podman", "age", "pg_dump", "pg_restore", "node"].map((command) => [command, probeTool(command)])) as Record<string, { version: string | null; missing: boolean }>;
  return {
    podman: probes.podman!.version,
    age: probes.age!.version,
    pgDump: probes.pg_dump!.version,
    pgRestore: probes.pg_restore!.version,
    node: probes.node!.version,
    missing: Object.entries(probes).filter(([, value]) => value.missing).map(([key]) => key),
    broken: Object.entries(probes).filter(([, value]) => !value.missing && value.version === null).map(([key]) => key),
  };
}

export class LiveDrillExecutor implements DrillExecutor {
  readonly name = "live";
  readonly versions: Record<string, string>;
  private readonly ctx: ExecutorContext;
  private readonly env: DrillEnv;
  private readonly toolchain: ProvisionedToolchain;
  private readonly secrets: { identity: string; recipient: string };
  private readonly texts: { dir: string };
  private readonly backups: { sqlite: string; postgres: string };
  private readonly restores: { sqlite: string; postgres: string };
  private readonly fixtures: { sqlite: { dataDir: string; agentDir: string; dbPath: string }; postgres: { dataDir: string } };
  private readonly stagingRoot: string;
  /** Every live invocation gets a unique namespace; never delete another run's prefix. */
  // Keep every container DNS label below 63 characters (the longest suffix is
  // "node-exporter"). The fixed prefix plus 8 opaque hex chars remains unique.
  private readonly resourcePrefix = `${DRILL_RESOURCE_PREFIX}${randomUUID().slice(0, 8)}-`;
  private readonly network: string;
  private provisioned = false;
  private networkCreated = false;
  private readonly ownedContainers = new Set<string>();
  private readonly ownedContainerIds = new Map<string, string>();
  private pgVolume: string | null = null;
  private pgContainerId: string | null = null;
  private schedulerImageOwned = false;
  private pgResources: { url: string; containerUrl: string; schema: string; name: string } | null = null;
  private reports: { sqlite: MachineReport | null; postgres: MachineReport | null } = { sqlite: null, postgres: null };
  private monitor: MonitorState | null = null;
  private scheduler: SchedulerState | null = null;
  private _resourcesCleaned = false;
  get resourcesCleaned(): boolean { return this._resourcesCleaned; }

  constructor(ctx: ExecutorContext) {
    this.ctx = ctx;
    this.env = ctx.env;
    this.toolchain = probeToolchain();
    const secrets = resolveDrillSecrets(ctx.root);
    this.secrets = { identity: secrets.identityFile, recipient: secrets.recipientFile };
    this.texts = { dir: path.join(ctx.root, "textfile") };
    this.backups = { sqlite: path.join(ctx.root, "backups", "sqlite"), postgres: path.join(ctx.root, "backups", "postgres") };
    this.restores = { sqlite: path.join(ctx.root, "restore", "sqlite"), postgres: path.join(ctx.root, "restore", "postgres") };
    this.fixtures = {
      sqlite: {
        dataDir: path.join(ctx.root, "fixtures", "sqlite", "data"),
        agentDir: path.join(ctx.root, "fixtures", "sqlite", "data", ".pi-agent"),
        dbPath: path.join(ctx.root, "fixtures", "sqlite", "data", "pi-agent-server.db"),
      },
      postgres: { dataDir: path.join(ctx.root, "fixtures", "postgres", "data") },
    };
    this.stagingRoot = path.join(ctx.root, "staging");
    this.network = `${this.resourcePrefix}net`;
    const versions: Record<string, string> = { node: this.toolchain.node ?? "unknown", pgMajor: PG_MAJOR };
    if (this.toolchain.podman) versions.podman = this.toolchain.podman;
    if (this.toolchain.age) versions.age = this.toolchain.age;
    if (this.toolchain.pgDump) versions.pgDump = this.toolchain.pgDump;
    if (this.toolchain.pgRestore) versions.pgRestore = this.toolchain.pgRestore;
    this.versions = versions;
  }

  private podman(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
    return runCmd("podman", args);
  }
  private podmanOk(args: readonly string[]): boolean {
    return this.podman(args).status === 0;
  }
  private envDir(): string {
    return this.ctx.root;
  }

  async step(stepId: string): Promise<DrillObservation> {
    const start = Date.now();
    try {
      switch (stepId) {
        case "provision": return await this.stepProvision(start);
        case "fixture-sqlite": return await this.stepSqliteFixture(start);
        case "fixture-postgres": return await this.stepPostgresFixture(start);
        case "backup-sqlite-success": return await this.stepSqliteBackup(start);
        case "backup-postgres-success": return await this.stepPostgresBackup(start);
        case "restore-sqlite-success": return await this.stepSqliteRestore(start);
        case "restore-postgres-success": return await this.stepPostgresRestore(start);
        case "monitor-normal": return await this.stepMonitorNormal(start);
        default:
          if (stepId.startsWith("fault:")) return this.stepFault(stepId, start);
          return makeObs(stepId, false, "unknown drill step", start, this.env);
      }
    } catch (error) {
      return makeObs(stepId, false, `step threw: ${error instanceof Error ? error.message : String(error)}`, start, this.env);
    }
  }

  private async stepProvision(start: number): Promise<DrillObservation> {
    const missing: string[] = [];
    if (this.toolchain.missing.length > 0) {
      return makeObs("provision", false, `toolchain missing: ${this.toolchain.missing.join(", ")}`, start, this.env, true);
    }
    if (this.toolchain.broken.length > 0) {
      return makeObs("provision", false, `toolchain command failed: ${this.toolchain.broken.join(", ")}`, start, this.env, false);
    }
    // Never reclaim a generic prefix. The namespace is unique to this process,
    // and an existing resource with it is a collision, not cleanup input.
    if (this.podmanOk(["network", "exists", this.network])) {
      return makeObs("provision", false, "podman network resource collision", start, this.env, false);
    }
    const created = this.podman(["network", "create", "--label", `pi-agent-server.drill.run=${this.resourcePrefix}`, this.network]);
    if (created.status !== 0) return makeObs("provision", false, "podman network create failed", start, this.env, false);
    this.networkCreated = true;
    // Runtime-only state must not carry alert records, locks, requests, or
    // metrics across runs. Prior sanitized summaries under runs/ are retained.
    for (const dir of ["textfile", "textfile-pg", "logs", "scheduler", "monitor"]) {
      rmSync(path.join(this.envDir(), dir), { recursive: true, force: true });
    }
    for (const dir of ["fixtures", "backups", "restore", "staging", "textfile", "textfile-pg", "runs", "logs", "scheduler", "monitor"]) mkdirSync(path.join(this.envDir(), dir), { recursive: true, mode: 0o700 });
    mkdirSync(this.texts.dir, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(this.envDir(), "textfile-pg"), { recursive: true, mode: 0o700 });
    // Start the isolated scheduler container (proves cron/timer -> compiled CLI).
    const scheduler = await startScheduler(findPackageRoot(), this.ctx.root, this.resourcePrefix, this.network);
    this.scheduler = scheduler;
    this.schedulerImageOwned = scheduler.ownsImage;
    this.ownedContainers.add(scheduler.name);
    this.ownedContainerIds.set(scheduler.name, scheduler.containerId);
    // Start the isolated monitoring stack (node_exporter + Prometheus + Alertmanager + webhook).
    const monitorCfg: MonitorStackConfig = { root: this.ctx.root, target: "drill-sqlite", resourcePrefix: this.resourcePrefix, network: this.network };
    this.monitor = await prepareMonitorStack(monitorCfg);
    await startMonitorStack(this.monitor);
    this.provisioned = true;
    return makeObs("provision", true, "podman network + isolated drill workspace + scheduler + monitoring stack ready", start, this.env);
  }

  private async stepSqliteFixture(start: number): Promise<DrillObservation> {
    const d = this.fixtures.sqlite;
    try {
      // 重复 run 先安全清理本次运行已知 fixture/备份/指标目录（均位于根内，安全）。
      rmSync(d.dataDir, { recursive: true, force: true });
      rmSync(this.backups.sqlite, { recursive: true, force: true });
      rmSync(path.join(this.texts.dir, "drill-sqlite.prom"), { force: true });
      mkdirSync(d.dataDir, { recursive: true, mode: 0o700 });
      mkdirSync(d.agentDir, { recursive: true, mode: 0o700 });
      this.bootstrapSqlite(d.dataDir);
      this.seedSqlite(d.dataDir);
      return makeObs("fixture-sqlite", true, "sqlite canonical baseline + 2 sessions (1 valid, 1 missing reference) seeded", start, this.env);
    } catch (error) {
      return makeObs("fixture-sqlite", false, `fixture failed: ${error instanceof Error ? error.message : String(error)}`, start, this.env);
    }
  }

  private sqliteCliEnv(dataDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      AGENT_CWD: dataDir,
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, "pi-agent-server.db"),
      PI_STORAGE_DIALECT: "sqlite",
      PI_AUTH_PATH: path.join(this.envDir(), "no-such-auth.json"),
      PI_BACKUP_STAGING_ROOT: this.stagingRoot,
      ...extra,
    };
  }

  private bootstrapSqlite(dataDir: string): void {
    const result = runCmd("node", [this.ctx.cli.migrate, "--bootstrap-baseline", "--bootstrap-confirm", "CONFIRMED"], this.sqliteCliEnv(dataDir));
    if (result.status !== 0) throw new Error(`sqlite migrate bootstrap exited ${String(result.status)}`);
    if (!result.stdout.includes(`"mode":"bootstrap-baseline"`) || !result.stdout.includes(`"status":"success"`)) {
      throw new Error("sqlite bootstrap did not emit canonical baseline success marker");
    }
  }

  private seedSqlite(dataDir: string): void {
    // The fixture DB is created on the host but read by the scheduler container (which sees the
    // drill root at its container path). Store session file / cwd paths using the CONTAINER path so
    // the backup whitelist (inside the container) accepts them, while writing the real files on host.
    const containerDataDir = this.scheduler ? toContainerPath(this.ctx.root, dataDir) : dataDir;
    const db = new DatabaseSync(path.join(dataDir, "pi-agent-server.db"));
    try {
      const now = Math.floor(Date.now() / 1000);
      const projectId = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
      db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?, ?, ?, ?, ?)").run(projectId, "drill-project", containerDataDir, "drill-owner", now);
      const validSessionId = "aaaa0000-0000-4000-8000-000000000001";
      const validHostFile = path.join(dataDir, "sessions", validSessionId, "session.jsonl");
      mkdirSync(path.dirname(validHostFile), { recursive: true, mode: 0o700 });
      writeJsonlV3(validHostFile, 3);
      const validStored = path.posix.join(containerDataDir.split(path.sep).join("/"), "sessions", validSessionId, "session.jsonl");
      db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref) VALUES (?, ?, ?, ?, ?, ?, ?)").run(validSessionId, "drill-owner", projectId, "valid-session", now, now, validStored);
      const missingSessionId = "bbbb0000-0000-4000-8000-000000000002";
      const missingStored = path.posix.join(containerDataDir.split(path.sep).join("/"), "sessions", missingSessionId, "session.jsonl");
      db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref) VALUES (?, ?, ?, ?, ?, ?, ?)").run(missingSessionId, "drill-owner", projectId, "missing-ref-session", now, now, missingStored);
    } finally {
      db.close();
    }
  }

  private async stepSqliteBackup(start: number): Promise<DrillObservation> {
    const d = this.fixtures.sqlite;
    if (!existsSync(d.dbPath)) return makeObs("backup-sqlite-success", false, "sqlite fixture missing", start, this.env);
    const backing = await this.runBackupViaScheduler(this.backups.sqlite, this.secrets.recipient, this.sqliteCliEnv(d.dataDir), "cron");
    if (!backing.ok) return makeObs("backup-sqlite-success", false, backing.detail, start, this.env);
    this.reports.sqlite = backing.report;
    const write = await this.updateFreshnessFromBackup(backing, this.backups.sqlite, "drill-sqlite");
    if (!write.ok) return makeObs("backup-sqlite-success", false, `freshness helper rejected: ${write.detail}`, start, this.env);
    return makeObs("backup-sqlite-success", true, "sqlite backup published by cron (report and cron time verified) + freshness advanced", start, this.env);
  }

  /** Run the compiled backup CLI inside the scheduler container and return the published report (host paths). */
  private async runBackupViaScheduler(backupRoot: string, recipient: string, env: NodeJS.ProcessEnv, trigger: SchedulerTrigger = "watch"): Promise<{ ok: boolean; detail: string; report: MachineReport | null; reportText: string | null; backupStartSec: number }> {
    if (!this.scheduler) return { ok: false, detail: "scheduler container not provisioned", report: null, reportText: null, backupStartSec: 0 };
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const requestedAtMs = Date.now();
    const requestId = `req-${Date.now()}-${randomUUID().slice(0, 8)}`;
    submitRequest(this.scheduler, requestId, { backup: this.ctx.cli.backup }, ["create", "--backup-root", backupRoot, "--age-recipient-file", recipient], env as Record<string, string>, trigger);
    let result: Awaited<ReturnType<typeof pollResult>> = null;
    try {
      result = await pollResult(this.scheduler, requestId, trigger === "cron" ? 125000 : 120000);
      if (!result) return { ok: false, detail: "scheduler backup timed out", report: null, reportText: null, backupStartSec: requestedAtMs / 1000 };
      if (result.trigger !== trigger || !Number.isFinite(Date.parse(result.triggerAt))) return { ok: false, detail: "scheduler trigger attestation invalid", report: null, reportText: null, backupStartSec: requestedAtMs / 1000 };
      const triggerAge = Date.now() - Date.parse(result.triggerAt);
      if (triggerAge < -5000 || triggerAge > 125000) return { ok: false, detail: "scheduler trigger time invalid", report: null, reportText: null, backupStartSec: requestedAtMs / 1000 };
      if (result.exitCode !== 0) return { ok: false, detail: `backup exited non-zero (${String(result.exitCode)})`, report: null, reportText: null, backupStartSec: requestedAtMs / 1000 };
      const report = parseMachineReport(result.stdout);
      if (report === null) return { ok: false, detail: "machine report invalid (missing/duplicate/unparseable or not published)", report: null, reportText: null, backupStartSec: requestedAtMs / 1000 };
      // Map the container-path finalPath back onto the host drill root.
      const remapped = { ...report, finalPath: fromContainerPath(this.ctx.root, report.finalPath) };
      const reportText = `backup-json-report: ${JSON.stringify(remapped)}\n`;
      return { ok: true, detail: "backup published", report: remapped, reportText, backupStartSec: Date.parse(result.triggerAt) / 1000 };
    } finally {
      // The request directory contains raw request/inflight/result/stdout/stderr
      // material. It is removed immediately after the result has been read.
      removeRequest(this.scheduler, requestId);
    }
  }

  private async updateFreshnessFromBackup(backing: { report: MachineReport | null; reportText: string | null; backupStartSec: number }, backupRoot: string, targetId: string): Promise<FreshnessUpdateResult> {
    if (!backing.report || !backing.reportText) return { ok: false, updated: false, staleLockReclaimed: false, detail: "backup report unavailable" };
    return this.runFreshnessHelper({
      textfileDir: this.textfileDirFor(targetId), targetId, backupRoot, exitCode: 0,
      reportText: backing.reportText, backupStartSec: Math.floor(backing.backupStartSec),
    });
  }

  private async stepSqliteRestore(start: number): Promise<DrillObservation> {
    const d = this.fixtures.sqlite;
    const report = this.reports.sqlite;
    if (!report) return makeObs("restore-sqlite-success", false, "sqlite backup report missing", start, this.env);
    const targetRoot = path.join(this.restores.sqlite, "target");
    rmSync(targetRoot, { recursive: true, force: true });
    mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    const result = runCmd("node", [this.ctx.cli.restore, "restore", "--input-backup", report.finalPath, "--target-root", targetRoot, "--age-identity-file", this.secrets.identity], this.sqliteCliEnv(d.dataDir));
    if (result.status !== 0) return makeObs("restore-sqlite-success", false, "restore exited non-zero", start, this.env);
    const verify = this.verifySqliteRestore(targetRoot);
    return makeObs("restore-sqlite-success", verify.ok, verify.detail, start, this.env);
  }

  private listCompletedBackups(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((entry) => existsSync(path.join(dir, entry, "COMPLETE"))).map((entry) => path.join(dir, entry));
  }

  private verifySqliteRestore(targetRoot: string): { ok: boolean; detail: string } {
    const db = findFileSuffix(targetRoot, "pi-agent-server.db");
    if (!db) return { ok: false, detail: "restored sqlite database not found" };
    const restored = new DatabaseSync(db, { readOnly: true });
    try {
      const ledger = restored.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: unknown; name: unknown; checksum: unknown }>;
      if (ledger.length !== 1 || Number(ledger[0]!.version) !== 0) return { ok: false, detail: "restored ledger is not canonical single baseline" };
      const sessions = restored.prepare("SELECT id, conversation_ref FROM sessions").all() as Array<{ id: unknown; conversation_ref: unknown }>;
      const valid = sessions.find((s) => s.id === VALID_SESSION_ID);
      const missing = sessions.find((s) => s.id === MISSING_SESSION_ID);
      const validOk = Boolean(valid && typeof valid.conversation_ref === "string" && valid.conversation_ref.endsWith(".jsonl"));
      const missingOk = Boolean(missing && missing.conversation_ref === null);
      const validJsonl = findFileSuffix(targetRoot, "session.jsonl");
      const jsonlOk = validJsonl !== null && readFileSync(validJsonl, "utf8").includes(`"version":3`);
      if (!validOk || !missingOk || !jsonlOk) return { ok: false, detail: `restore mismatch (valid=${validOk ? "ok" : "bad"} missing=${missingOk ? "NULL" : "not-null"} jsonl=${jsonlOk ? "ok" : "bad"})` };
      return { ok: true, detail: "restore verified: canonical ledger, valid history, missing->NULL" };
    } finally {
      restored.close();
    }
  }

  private async seedPostgres(pg: { url: string; schema: string }): Promise<void> {
    rmSync(this.fixtures.postgres.dataDir, { recursive: true, force: true });
    mkdirSync(this.fixtures.postgres.dataDir, { recursive: true, mode: 0o700 });
    const containerDataDir = this.scheduler ? toContainerPath(this.ctx.root, this.fixtures.postgres.dataDir) : this.fixtures.postgres.dataDir;
    const validHostFile = path.join(this.fixtures.postgres.dataDir, "sessions", VALID_SESSION_ID, "session.jsonl");
    mkdirSync(path.dirname(validHostFile), { recursive: true, mode: 0o700 });
    writeJsonlV3(validHostFile, 3);
    const now = Math.floor(Date.now() / 1000);
    const pool = new Pool({ connectionString: pgUrl(pg.url, pg.schema), max: 1, connectionTimeoutMillis: 5_000 });
    try {
      await pool.query(
        "INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES ($1, $2, $3, $4, $5)",
        [FIXTURE_PROJECT_ID, "drill-project", containerDataDir, "drill-owner", now],
      );
      await pool.query(
        "INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, conversation_ref) VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $2, $3, $9, $5, $6, $10)",
        [VALID_SESSION_ID, "drill-owner", FIXTURE_PROJECT_ID, "valid-session", now, now, path.posix.join(containerDataDir.split(path.sep).join("/"), "sessions", VALID_SESSION_ID, "session.jsonl"), MISSING_SESSION_ID, "missing-ref-session", path.posix.join(containerDataDir.split(path.sep).join("/"), "sessions", MISSING_SESSION_ID, "session.jsonl")],
      );
    } finally {
      await pool.end();
    }
  }

  private async stepPostgresFixture(start: number): Promise<DrillObservation> {
    if (!this.toolchain.pgDump || !this.toolchain.pgRestore) return makeObs("fixture-postgres", false, "pg tools missing", start, this.env);
    try {
      const pg = await this.spinPg16();
      await this.bootstrapPostgres(pg);
      await this.seedPostgres(pg);
      this.pgResources = pg;
      return makeObs("fixture-postgres", true, "postgres16 disposable + non-public schema + valid JSONL/missing reference seeded", start, this.env);
    } catch (error) {
      return makeObs("fixture-postgres", false, `postgres fixture failed: ${error instanceof Error ? error.message : String(error)}`, start, this.env);
    }
  }

  private async spinPg16(): Promise<{ url: string; containerUrl: string; schema: string; name: string }> {
    const name = `${this.resourcePrefix}pg16`;
    const volume = `${this.resourcePrefix}pg16-data`;
    if (this.podmanOk(["container", "exists", name])) throw new Error("postgres container resource collision");
    if (this.podmanOk(["volume", "exists", volume])) throw new Error("postgres volume resource collision");
    const volumeCreate = this.podman(["volume", "create", "--label", `pi-agent-server.drill.run=${this.resourcePrefix}`, volume]);
    if (volumeCreate.status !== 0) throw new Error("postgres volume create failed");
    this.pgVolume = volume;
    const user = "drill";
    const db = "drill";
    // 隔离 disposable（仅 loopback + 私有网络 + 每次重建）用固定口令即可，绝不来源/泄密。
    const password = "drillpw";
    // macOS podman 无法通过容器网络 IP 直接访问；必须映射到宿主机 loopback 端口。
    const hostPort = await findFreePort();
    const create = this.podman(["run", "-d", "--name", name, "--network", this.network, "--label", `pi-agent-server.drill.run=${this.resourcePrefix}`, "-v", `${volume}:/var/lib/postgresql/data`, "-p", `127.0.0.1:${hostPort}:5432`, "-e", `POSTGRES_USER=${user}`, "-e", `POSTGRES_DB=${db}`, "-e", `POSTGRES_PASSWORD=${password}`, `docker.io/library/postgres:${PG_MAJOR}-alpine`]);
    if (create.status !== 0) throw new Error("postgres container create failed");
    this.ownedContainers.add(name);
    const pgId = this.podman(["container", "inspect", "-f", "{{.Id}}", name]);
    if (pgId.status !== 0 || !pgId.stdout.trim()) throw new Error("postgres container identity unavailable");
    this.pgContainerId = pgId.stdout.trim();
    this.ownedContainerIds.set(name, this.pgContainerId);
    if (!(await this.waitPgReady(name))) throw new Error("postgres did not become ready");
    const schema = "drill_schema";
    // The volume and database are unique to this run, so every fixture starts empty.
    // The schema itself is also dropped/recreated defensively before bootstrap.
    const exec = this.podman(["exec", name, "psql", "-U", user, "-d", db, "-c", `DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`]);
    if (exec.status !== 0) throw new Error("postgres non-public schema create failed");
    // Host-side URL (loopback) for the drill orchestrator; container-side URL for the scheduler.
    const hostUrl = `postgresql://${user}:${password}@127.0.0.1:${hostPort}/${db}`;
    const containerUrl = `postgresql://${user}:${password}@${name}:5432/${db}`;
    return { url: hostUrl, containerUrl, schema, name };
  }

  private async waitPgReady(name: string): Promise<boolean> {
    for (let i = 0; i < 40; i += 1) {
      const ready = this.podman(["exec", name, "pg_isready", "-U", "drill"]);
      if (ready.status === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  private postgresEnv(pg: { url: string; schema: string }, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    mkdirSync(this.fixtures.postgres.dataDir, { recursive: true, mode: 0o700 });
    return {
      ...process.env,
      AGENT_CWD: this.fixtures.postgres.dataDir,
      DATA_DIR: this.fixtures.postgres.dataDir,
      DB_PATH: path.join(this.fixtures.postgres.dataDir, "none.db"),
      PI_STORAGE_DIALECT: "postgres",
      PI_DATABASE_URL: pgUrl(pg.url, pg.schema),
      PI_AUTH_PATH: path.join(this.envDir(), "no-such-auth.json"),
      PI_BACKUP_STAGING_ROOT: this.stagingRoot,
      ...extra,
    };
  }

  private async bootstrapPostgres(pg: { url: string; containerUrl: string; schema: string; name: string }): Promise<void> {
    mkdirSync(this.fixtures.postgres.dataDir, { recursive: true, mode: 0o700 });
    const result = runCmd("node", [this.ctx.cli.migrate, "--bootstrap-baseline", "--bootstrap-confirm", "CONFIRMED"], this.postgresEnv(pg));
    if (result.status !== 0) throw new Error(`postgres migrate bootstrap exited ${String(result.status)}: ${result.stderr.slice(-300)}`);
    if (!result.stdout.includes(`"mode":"bootstrap-baseline"`) || !result.stdout.includes(`"status":"success"`)) {
      throw new Error("postgres bootstrap did not emit canonical baseline success marker");
    }
  }

  private async stepPostgresBackup(start: number): Promise<DrillObservation> {
    const pg = this.pgResources;
    if (!pg) return makeObs("backup-postgres-success", false, "postgres fixture not provisioned", start, this.env);
    const backupRoot = this.backups.postgres;
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    // The scheduler container reaches PG over the drill network by container name.
    const env = this.postgresEnv(pg);
    env.PI_DATABASE_URL = pgUrl(pg.containerUrl, pg.schema);
    const backing = await this.runBackupViaScheduler(backupRoot, this.secrets.recipient, env, "cron");
    if (!backing.ok) return makeObs("backup-postgres-success", false, backing.detail, start, this.env);
    this.reports.postgres = backing.report;
    const write = await this.updateFreshnessFromBackup(backing, backupRoot, "drill-postgres");
    if (!write.ok) return makeObs("backup-postgres-success", false, `freshness helper rejected: ${write.detail}`, start, this.env);
    return makeObs("backup-postgres-success", true, "postgres backup published by cron (report and cron time verified) + freshness advanced", start, this.env);
  }

  private async stepPostgresRestore(start: number): Promise<DrillObservation> {
    const pg = this.pgResources;
    if (!pg) return makeObs("restore-postgres-success", false, "postgres not ready", start, this.env);
    const report = this.reports.postgres;
    if (!report) return makeObs("restore-postgres-success", false, "postgres backup report missing", start, this.env);
    // restore 要求目标是「新建且为空」的另一个 database（拒绝 public 或与源库/schema 相同的目标）。
    // restore 安全契约要求目标库命名为 pi_restore_*（临时新库）。
    const targetDb = `pi_restore_${sanitizeDbName(pg.url)}_${this.resourcePrefix.replace(/[^A-Za-z0-9_]/g, "").slice(-12)}`;
    // DROP DATABASE / CREATE DATABASE 不能在事务块内执行：拆成两次 psql 调用。
    this.podman(["exec", pg.name, "psql", "-U", "drill", "-d", "drill", "-c", `DROP DATABASE IF EXISTS ${targetDb}`]);
    const prep = this.podman(["exec", pg.name, "psql", "-U", "drill", "-d", "drill", "-c", `CREATE DATABASE ${targetDb}`]);
    if (prep.status !== 0) return makeObs("restore-postgres-success", false, "postgres restore target database create failed", start, this.env);
    const targetUrl = replaceDatabase(pg.url, targetDb);
    const targetRoot = path.join(this.restores.postgres, "target");
    rmSync(targetRoot, { recursive: true, force: true });
    mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    const result = runCmd("node", [this.ctx.cli.restore, "restore", "--input-backup", report.finalPath, "--target-root", targetRoot, "--age-identity-file", this.secrets.identity, "--target-pg-url", targetUrl], this.postgresEnv(pg));
    if (result.status !== 0) return makeObs("restore-postgres-success", false, "postgres restore failed", start, this.env);
    const verify = await this.verifyPostgresRestore(targetRoot, targetUrl, pg.schema);
    return makeObs("restore-postgres-success", verify.ok, verify.detail, start, this.env);
  }

  private async verifyPostgresRestore(targetRoot: string, targetUrl: string, schema: string): Promise<{ ok: boolean; detail: string }> {
    const pool = new Pool({ connectionString: pgUrl(targetUrl, schema), max: 1, connectionTimeoutMillis: 5_000 });
    try {
      const ledger = await pool.query<{ version: unknown; name: unknown; checksum: unknown }>("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
      const sessions = await pool.query<{ id: unknown; conversation_ref: unknown }>("SELECT id, conversation_ref FROM sessions ORDER BY id");
      const valid = sessions.rows.find((row) => row.id === VALID_SESSION_ID);
      const missing = sessions.rows.find((row) => row.id === MISSING_SESSION_ID);
      const ledgerOk = ledger.rows.length === 1 && Number(ledger.rows[0]?.version) === 0 && ledger.rows[0]?.name === "initial-schema";
      const validOk = typeof valid?.conversation_ref === "string" && path.isAbsolute(valid.conversation_ref) && valid.conversation_ref.endsWith(".jsonl");
      const missingOk = missing?.conversation_ref === null;
      const recoveredJsonl = findFileSuffix(targetRoot, "session.jsonl");
      const jsonlOk = recoveredJsonl !== null && readFileSync(recoveredJsonl, "utf8").includes('"version":3');
      if (!ledgerOk || !validOk || !missingOk || !jsonlOk) return { ok: false, detail: `postgres restore mismatch (ledger=${ledgerOk ? "ok" : "bad"} valid=${validOk ? "ok" : "bad"} missing=${missingOk ? "NULL" : "not-null"} jsonl=${jsonlOk ? "ok" : "bad"})` };
      return { ok: true, detail: "postgres restore verified: canonical ledger, valid history, missing->NULL, JSONL readable" };
    } catch {
      return { ok: false, detail: "postgres restore verification query failed" };
    } finally {
      await pool.end();
    }
  }

  private async stepMonitorNormal(start: number): Promise<DrillObservation> {
    if (!this.monitor) return makeObs("monitor-normal", false, "monitoring stack not started", start, this.env);
    // node_exporter needs a few scrape cycles to pick up the freshly written textfile.
    let hasFreshness = false;
    let upOk = false;
    let firing: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      hasFreshness = this.promSeriesExists("pi_agent_server_backup_last_success_timestamp_seconds");
      upOk = this.promSeriesExists("up == 1");
      firing = this.alertNamesFiring();
      if (hasFreshness && upOk && firing.length === 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const ok = hasFreshness && upOk && firing.length === 0;
    return makeObs("monitor-normal", ok, ok ? "freshness metric present, expected target up, no critical alert firing" : `monitor abnormal (fresh=${hasFreshness} up=${upOk} firing=[${firing.join(",")}])`, start, this.env);
  }

  private promSeriesExists(query: string): boolean {
    if (!this.monitor) return false;
    const body = prometheusQuery(this.monitor, query);
    try {
      const parsed = JSON.parse(body) as { status: string; data?: { result?: unknown[] } };
      return parsed.status === "success" && Boolean(parsed.data?.result && parsed.data.result.length > 0);
    } catch {
      return false;
    }
  }

  private alertNamesFiring(): string[] {
    if (!this.monitor) return [];
    const body = prometheusAlertsJson(this.monitor);
    const names: string[] = [];
    try {
      const parsed = JSON.parse(body) as { data?: { alerts?: Array<{ labels?: { alertname?: string }; state?: string }> } };
      for (const a of parsed.data?.alerts ?? []) {
        if (a.state === "firing" && a.labels?.alertname) names.push(a.labels.alertname);
      }
    } catch {
      /* ignore */
    }
    return names;
  }

  private isAlertFiring(name: string): boolean {
    return this.alertNamesFiring().includes(name);
  }

  private async stepFault(stepId: string, start: number): Promise<DrillObservation> {
    const match = stepId.match(/^fault:(guard|recovery):(.+)$/);
    if (!match) return makeObs(stepId, false, "malformed fault step id", start, this.env);
    const phase = match[1]!;
    const fault = match[2]! as FaultKind;
    if (!(FAULT_KINDS as readonly string[]).includes(fault)) return makeObs(stepId, false, `unknown fault: ${fault}`, start, this.env);
    try {
      const ok = isAlertCycle(fault)
        ? (phase === "guard" ? await this.alertFaultGuard(fault) : await this.alertFaultRecovery(fault))
        : (phase === "guard" ? await this.faultGuard(fault) : await this.faultRecovery(fault));
      return makeObs(stepId, ok, ok ? `${fault} ${phase} ok` : `${fault} ${phase} failed`, start, this.env);
    } catch (error) {
      return makeObs(stepId, false, `${fault} ${phase} threw: ${error instanceof Error ? error.message : String(error)}`, start, this.env);
    }
  }

  // ---- Non-monitor fault guard / recovery (real helper + real file injection) ----
  private async faultGuard(fault: FaultKind): Promise<boolean> {
    switch (fault) {
      case "age-failure": {
        const prior = this.currentFreshnessValue("drill-sqlite");
        const badRecipient = path.join(this.envDir(), "staging", "bad-recipient.txt");
        writeFileSync(badRecipient, "not-a-real-age-recipient\n", { mode: 0o600 });
        const backing = await this.runBackupViaScheduler(this.backups.sqlite, badRecipient, this.sqliteCliEnv(this.fixtures.sqlite.dataDir));
        if (backing.ok) return false; // must not publish with a broken recipient
        const after = this.currentFreshnessValue("drill-sqlite");
        return after === prior; // freshness unchanged
      }
      case "pg-tool-failure": {
        const pg = this.pgResources;
        if (!pg) return false;
        const prior = this.currentFreshnessValue("drill-postgres");
        await this.installFakePgTools();
        const env = this.postgresEnv(pg);
        env.PI_DATABASE_URL = pgUrl(pg.containerUrl, pg.schema);
        const fakePath = path.join(this.envDir(), "faultbin");
        env.DRILL_PREPEND_PATH = fakePath;
        const backing = await this.runBackupViaScheduler(this.backups.postgres, this.secrets.recipient, env);
        if (backing.ok) return false;
        const after = this.currentFreshnessValue("drill-postgres");
        return after === prior;
      }
      case "sqlite-snapshot-failure": return this.sqliteSnapshotFailureGuard();
      case "report-missing": return this.helperGuardRejects("backup created: x\n");
      case "report-duplicate": {
        const good = this.successReportLine(this.backups.sqlite);
        return this.helperGuardRejects(`${good}${good}`);
      }
      case "report-unparseable": return this.helperGuardRejects("backup-json-report: {not json}");
      case "report-dryrun": return this.helperGuardRejects('backup-json-report: {"dialect":"sqlite","status":"published","dryRun":true,"finalPath":"/x","payloadCount":1,"missingSessionReferences":0}\n');
      case "finalpath-escape": return this.helperGuardRejects('backup-json-report: {"dialect":"sqlite","status":"published","dryRun":false,"finalPath":"/etc/passwd","payloadCount":1,"missingSessionReferences":0}\n', this.backups.sqlite);
      case "finalpath-perm": return this.permGuard();
      case "finalpath-owner": return this.ownerGuard();
      case "single-flight": return this.singleFlightGuard();
      case "late-run": return this.lateRunGuard();
      case "clock-rollback": return this.clockRollbackGuard();
      case "crash-rename": return this.crashRenameGuard();
      case "symlink-unsafe-perm": return this.symlinkGuard();
      default: return false;
    }
  }

  private async faultRecovery(fault: FaultKind): Promise<boolean> {
    switch (fault) {
      case "age-failure": return this.recoveryRunSuccess(this.backups.sqlite, "drill-sqlite", this.sqliteCliEnv(this.fixtures.sqlite.dataDir));
      case "sqlite-snapshot-failure": return this.recoveryRunSuccess(this.backups.sqlite, "drill-sqlite", this.sqliteCliEnv(this.fixtures.sqlite.dataDir));
      case "pg-tool-failure": {
        const pg = this.pgResources;
        if (!pg) return false;
        this.removeFakePgTools();
        const env = this.postgresEnv(pg);
        env.PI_DATABASE_URL = pgUrl(pg.containerUrl, pg.schema);
        return this.recoveryRunSuccess(this.backups.postgres, "drill-postgres", env);
      }
      case "report-missing":
      case "report-duplicate":
      case "report-unparseable":
      case "report-dryrun": return this.recoveryRunSuccess(this.backups.sqlite, "drill-sqlite", this.sqliteCliEnv(this.fixtures.sqlite.dataDir));
      case "finalpath-escape": case "finalpath-perm": case "finalpath-owner": {
        const restored = await this.recoveryRunSuccess(this.backups.sqlite, "drill-sqlite", this.sqliteCliEnv(this.fixtures.sqlite.dataDir));
        // also restore the package perms that permGuard may have loosened.
        this.restorePackagePerms();
        return restored;
      }
      case "single-flight": return this.recoveryRunSuccess(this.backups.sqlite, "drill-sqlite", this.sqliteCliEnv(this.fixtures.sqlite.dataDir));
      case "late-run": return this.lateRunRecovery();
      case "clock-rollback": return this.clockRollbackRecovery();
      case "crash-rename": return this.recoveryRunSuccess(this.backups.sqlite, "drill-sqlite", this.sqliteCliEnv(this.fixtures.sqlite.dataDir));
      case "symlink-unsafe-perm": return this.recoveryRunSuccess(this.backups.sqlite, "drill-sqlite", this.sqliteCliEnv(this.fixtures.sqlite.dataDir));
      default: return false;
    }
  }

  private async recoveryRunSuccess(backupRoot: string, targetId: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    const backing = await this.runBackupViaScheduler(backupRoot, this.secrets.recipient, env, "watch");
    if (!backing.ok) return false;
    const write = await this.updateFreshnessFromBackup(backing, backupRoot, targetId);
    return write.ok;
  }

  private async helperGuardRejects(stdout: string, backupRoot?: string): Promise<boolean> {
    const root = backupRoot ?? this.backups.sqlite;
    const result = await this.runFreshnessHelper({
      textfileDir: this.texts.dir,
      targetId: "drill-sqlite",
      backupRoot: root,
      exitCode: 0,
      reportText: stdout,
      backupStartSec: Math.floor(Date.now() / 1000),
    });
    return !result.ok;
  }

  /** Invoke the same helper used by every success/recovery/fault write in a
   * separate process. The source fallback is only for tsx development runs;
   * compiled drills use the packaged helper child. */
  private runFreshnessHelper(request: FreshnessUpdateRequest): Promise<FreshnessUpdateResult> {
    const packageRoot = findPackageRoot();
    const currentFile = fileURLToPath(import.meta.url);
    const compiledChild = path.join(packageRoot, "dist-drill", "scripts", "freshness-helper-child.js");
    const sourceChild = path.join(packageRoot, "scripts", "freshness-helper-child.ts");
    const tsx = path.join(packageRoot, "node_modules", ".bin", "tsx");
    const command = currentFile.endsWith(".ts") && existsSync(tsx) ? tsx : process.execPath;
    const args = command === tsx ? [sourceChild] : [compiledChild];
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: packageRoot,
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["pipe", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.on("error", () => resolve({ ok: false, updated: false, staleLockReclaimed: false, detail: "freshness helper child failed" }));
      child.on("close", (code, signal) => {
        if (signal !== null || code !== 0 && stdout.trim() === "") {
          resolve({ ok: false, updated: false, staleLockReclaimed: false, detail: "freshness helper child failed" });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as FreshnessUpdateResult;
          if (typeof parsed.ok !== "boolean" || typeof parsed.updated !== "boolean") throw new Error("invalid helper result");
          resolve(parsed);
        } catch {
          resolve({ ok: false, updated: false, staleLockReclaimed: false, detail: "freshness helper child returned invalid result" });
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }

  private successReportLine(backupRoot: string): string {
    const backups = this.listCompletedBackups(backupRoot);
    if (backups.length === 0) return "backup-json-report: {\"status\":\"published\",\"dryRun\":false,\"finalPath\":\"/nomatch\"}\n";
    const fp = backups[0]!;
    return `backup-json-report: {"dialect":"sqlite","status":"published","dryRun":false,"finalPath":"${fp}","payloadCount":1,"missingSessionReferences":0}\n`;
  }

  private async permGuard(): Promise<boolean> {
    const report = this.reports.sqlite;
    if (!report) return false;
    const complete = path.join(report.finalPath, "COMPLETE");
    try { chmodSync(report.finalPath, 0o777); chmodSync(complete, 0o666); } catch { return false; }
    const result = await this.runFreshnessHelper({
      textfileDir: this.texts.dir, targetId: "drill-sqlite", backupRoot: this.backups.sqlite,
      exitCode: 0, reportText: `backup-json-report: ${JSON.stringify(report)}\n`, backupStartSec: Math.floor(Date.now() / 1000),
    });
    return !result.ok;
  }

  private async ownerGuard(): Promise<boolean> {
    const report = this.reports.sqlite;
    if (!report) return false;
    const current = typeof process.getuid === "function" ? process.getuid() : 0;
    const wrongOwner = current === 0 ? 1 : 0;
    // The helper inspects the real package inode and compares it with the
    // deliberately wrong required owner. No host-side boolean is injected.
    const result = await this.runFreshnessHelper({
      textfileDir: this.texts.dir, targetId: "drill-sqlite", backupRoot: this.backups.sqlite,
      exitCode: 0, reportText: `backup-json-report: ${JSON.stringify(report)}\n`, backupStartSec: Math.floor(Date.now() / 1000), requiredPackageOwnerUid: wrongOwner,
    });
    return !result.ok;
  }

  private async sqliteSnapshotFailureGuard(): Promise<boolean> {
    const prior = this.currentFreshnessValue("drill-sqlite");
    const before = this.listCompletedBackups(this.backups.sqlite).length;
    const badDb = path.join(this.envDir(), "staging", "not-a-sqlite-database");
    writeFileSync(badDb, "not a sqlite database\n", { mode: 0o600 });
    const env = this.sqliteCliEnv(this.fixtures.sqlite.dataDir, { DB_PATH: badDb });
    const backing = await this.runBackupViaScheduler(this.backups.sqlite, this.secrets.recipient, env);
    const after = this.listCompletedBackups(this.backups.sqlite).length;
    return !backing.ok && after === before && this.currentFreshnessValue("drill-sqlite") === prior;
  }

  private restorePackagePerms(): void {
    for (const backupRoot of [this.backups.sqlite, this.backups.postgres]) {
      for (const pkg of this.listCompletedBackups(backupRoot)) {
        try { chmodSync(pkg, 0o700); } catch { /* ignore */ }
        const complete = path.join(pkg, "COMPLETE");
        if (existsSync(complete)) { try { chmodSync(complete, 0o600); } catch { /* ignore */ } }
      }
    }
  }

  private faultTextDir(targetId: string): string {
    return path.join(this.envDir(), "logs", "freshness-faults", targetId);
  }

  private prepareFaultTextDir(targetId: string): string {
    const dir = this.faultTextDir(targetId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return dir;
  }

  private async singleFlightGuard(): Promise<boolean> {
    const report = this.reports.sqlite;
    if (!report) return false;
    const targetId = "single-flight";
    const textfileDir = this.prepareFaultTextDir(targetId);
    const reportText = `backup-json-report: ${JSON.stringify(report)}\n`;
    const now = Math.floor(Date.now() / 1000);
    const request = (value: number): FreshnessUpdateRequest => ({
      textfileDir, targetId, backupRoot: this.backups.sqlite, exitCode: 0,
      reportText, backupStartSec: value, holdMs: 1500,
    });
    const first = this.runFreshnessHelper(request(now));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = this.runFreshnessHelper({ ...request(now + 1), holdMs: 0 });
    const results = await Promise.all([first, second]);
    return results.filter((result) => result.updated).length === 1 && results.some((result) => !result.ok && result.detail.includes("held"));
  }

  private async lateRunGuard(): Promise<boolean> {
    const report = this.reports.sqlite;
    if (!report) return false;
    const targetId = "late-run";
    const textfileDir = this.prepareFaultTextDir(targetId);
    const now = Math.floor(Date.now() / 1000);
    const reportText = `backup-json-report: ${JSON.stringify(report)}\n`;
    const seed = await this.runFreshnessHelper({ textfileDir, targetId, backupRoot: this.backups.sqlite, exitCode: 0, reportText, backupStartSec: now - 99, nowSec: now });
    const late = await this.runFreshnessHelper({ textfileDir, targetId, backupRoot: this.backups.sqlite, exitCode: 0, reportText, backupStartSec: now - 100, nowSec: now });
    return seed.ok && seed.updated && !late.ok && late.detail.includes("regress") && this.readFreshnessValueFromFile(path.join(textfileDir, `${targetId}.prom`)) === now - 99;
  }

  private async lateRunRecovery(): Promise<boolean> {
    const report = this.reports.sqlite;
    if (!report) return false;
    const targetId = "late-run";
    const textfileDir = this.faultTextDir(targetId);
    const now = Math.floor(Date.now() / 1000);
    const result = await this.runFreshnessHelper({ textfileDir, targetId, backupRoot: this.backups.sqlite, exitCode: 0, reportText: `backup-json-report: ${JSON.stringify(report)}\n`, backupStartSec: now, nowSec: now });
    return result.ok && this.readFreshnessValueFromFile(path.join(textfileDir, `${targetId}.prom`)) === now;
  }

  private async clockRollbackGuard(): Promise<boolean> {
    const report = this.reports.sqlite;
    if (!report) return false;
    const targetId = "clock-rollback";
    const textfileDir = this.prepareFaultTextDir(targetId);
    const now = Math.floor(Date.now() / 1000);
    const reportText = `backup-json-report: ${JSON.stringify(report)}\n`;
    const seed = await this.runFreshnessHelper({ textfileDir, targetId, backupRoot: this.backups.sqlite, exitCode: 0, reportText, backupStartSec: now - 5000, nowSec: now });
    const result = await this.runFreshnessHelper({ textfileDir, targetId, backupRoot: this.backups.sqlite, exitCode: 0, reportText, backupStartSec: now + 100000, nowSec: now });
    return seed.ok && seed.updated && !result.ok && result.detail.includes("rollback")
      && this.readFreshnessValueFromFile(path.join(textfileDir, `${targetId}.prom`)) === now - 5000;
  }

  private async clockRollbackRecovery(): Promise<boolean> {
    const report = this.reports.sqlite;
    if (!report) return false;
    const targetId = "clock-rollback";
    const textfileDir = this.faultTextDir(targetId);
    const now = Math.floor(Date.now() / 1000);
    const result = await this.runFreshnessHelper({ textfileDir, targetId, backupRoot: this.backups.sqlite, exitCode: 0, reportText: `backup-json-report: ${JSON.stringify(report)}\n`, backupStartSec: now, nowSec: now });
    return result.ok;
  }

  private async crashRenameGuard(): Promise<boolean> {
    const report = this.reports.sqlite;
    if (!report) return false;
    const targetId = "crash-rename";
    const textfileDir = this.prepareFaultTextDir(targetId);
    const metric = path.join(textfileDir, `${targetId}.prom`);
    const now = Math.floor(Date.now() / 1000);
    const reportText = `backup-json-report: ${JSON.stringify(report)}\n`;
    const baseline = await this.runFreshnessHelper({ textfileDir, targetId, backupRoot: this.backups.sqlite, exitCode: 0, reportText, backupStartSec: now - 2000, nowSec: now });
    const before = await this.runFreshnessHelper({ textfileDir, targetId, backupRoot: this.backups.sqlite, exitCode: 0, reportText, backupStartSec: now, nowSec: now, crashHook: "before-rename" });
    const beforeValueIntact = this.readFreshnessValueFromFile(metric) === now - 2000;
    const recoveredBefore = await this.runFreshnessHelper({ textfileDir, targetId, backupRoot: this.backups.sqlite, exitCode: 0, reportText, backupStartSec: now, nowSec: now });
    const after = await this.runFreshnessHelper({ textfileDir, targetId, backupRoot: this.backups.sqlite, exitCode: 0, reportText, backupStartSec: now + 1, nowSec: now + 1, crashHook: "after-rename" });
    const afterValueComplete = this.readFreshnessValueFromFile(metric) === now + 1;
    const recoveredAfter = await this.runFreshnessHelper({ textfileDir, targetId, backupRoot: this.backups.sqlite, exitCode: 0, reportText, backupStartSec: now + 2, nowSec: now + 2 });
    return baseline.ok && !before.ok && beforeValueIntact && recoveredBefore.ok && recoveredBefore.staleLockReclaimed
      && !after.ok && afterValueComplete && recoveredAfter.ok && recoveredAfter.staleLockReclaimed
      && this.readFreshnessValueFromFile(metric) === now + 2;
  }

  private async symlinkGuard(): Promise<boolean> {
    const report = this.reports.sqlite;
    if (!report) return false;
    const base = path.join(this.envDir(), "logs", "freshness-security");
    rmSync(base, { recursive: true, force: true });
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const reportText = `backup-json-report: ${JSON.stringify(report)}\n`;
    const request = (dir: string, targetId: string, start: number): FreshnessUpdateRequest => ({
      textfileDir: dir, targetId, backupRoot: this.backups.sqlite, exitCode: 0, reportText, backupStartSec: start, nowSec: start,
    });
    const now = Math.floor(Date.now() / 1000);

    const fileDir = path.join(base, "file-link");
    mkdirSync(fileDir, { mode: 0o700 });
    const fileSeed = await this.runFreshnessHelper(request(fileDir, "file-link", now - 1));
    const file = path.join(fileDir, "file-link.prom");
    const original = path.join(fileDir, "original.prom");
    renameSync(file, original);
    symlinkSync(original, file);
    const fileLinkRejected = !(await this.runFreshnessHelper(request(fileDir, "file-link", now))).ok
      && this.readFreshnessValueFromFile(original) === now - 1;

    const fileModeDir = path.join(base, "file-mode");
    mkdirSync(fileModeDir, { mode: 0o700 });
    const fileModeSeed = await this.runFreshnessHelper(request(fileModeDir, "file-mode", now - 1));
    chmodSync(path.join(fileModeDir, "file-mode.prom"), 0o666);
    const fileModeRejected = !(await this.runFreshnessHelper(request(fileModeDir, "file-mode", now))).ok;

    const dirMode = path.join(base, "dir-mode");
    mkdirSync(dirMode, { mode: 0o700 });
    chmodSync(dirMode, 0o777);
    const dirModeRejected = !(await this.runFreshnessHelper(request(dirMode, "dir-mode", now))).ok;

    const realDir = path.join(base, "real-dir");
    const linkedDir = path.join(base, "linked-dir");
    mkdirSync(realDir, { mode: 0o700 });
    symlinkSync(realDir, linkedDir);
    const dirLinkRejected = !(await this.runFreshnessHelper(request(linkedDir, "dir-link", now))).ok;

    rmSync(base, { recursive: true, force: true });
    return fileSeed.ok && fileModeSeed.ok && fileLinkRejected && fileModeRejected && dirModeRejected && dirLinkRejected;
  }

  private readFreshnessValueFromFile(file: string): number | null {
    try {
      if (!existsSync(file)) return null;
      const st = lstatSync(file);
      if (st.isSymbolicLink()) return null;
      const match = readFileSync(file, "utf8").match(/\{target="[^"]+"\} (-?\d+)/);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  private async installFakePgTools(): Promise<void> {
    const dir = path.join(this.envDir(), "faultbin");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const tool of ["pg_dump", "pg_restore", "psql"]) {
      const f = path.join(dir, tool);
      writeFileSync(f, `#!/bin/sh\necho "${tool} fault injection" >&2\nexit 1\n`, { mode: 0o700 });
      chmodSync(f, 0o700);
    }
  }

  private removeFakePgTools(): void {
    const dir = path.join(this.envDir(), "faultbin");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  private currentFreshnessValue(targetId: string): number | null {
    try {
      const file = path.join(this.texts.dir, `${targetId}.prom`);
      if (!existsSync(file)) return null;
      const st = lstatSync(file);
      if (st.isSymbolicLink()) return null; // symlink never trusted as a real value
      const match = readFileSync(file, "utf8").match(/\{target="[^"]+"\} (-?\d+)/);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  private textfileDirFor(targetId: string): string {
    // Only the sqlite target feeds the monitored node_exporter textfile dir (keeps alert joins clean).
    return targetId === "drill-sqlite" ? this.texts.dir : path.join(this.envDir(), "textfile-pg");
  }

  // ---- Monitoring fault guard / recovery (real Prometheus + webhook verification) ----
  private async alertFaultGuard(fault: FaultKind): Promise<boolean> {
    if (!this.monitor) return false;
    const alert = this.alertNameFor(fault);
    // Start a new webhook generation. Historical firing/resolved records are
    // never accepted as evidence for this injected cycle.
    resetWebhookRecords(this.monitor);
    await this.clearAlertFault();
    if (!(await this.waitForAlertState(alert, false, 30000))) return false;
    const checkpoint = webhookRecordCount(this.monitor);
    await this.applyAlertFault(fault);
    if (!(await this.waitForAlertState(alert, true, 90000))) return false;
    // Prometheus firing and webhook delivery are separate asynchronous states.
    return this.waitForWebhookState(alert, "firing", 30000, checkpoint);
  }

  private async alertFaultRecovery(fault: FaultKind): Promise<boolean> {
    if (!this.monitor) return false;
    const alert = this.alertNameFor(fault);
    // Preserve the firing generation and accept only a resolved notification
    // appended after the recovery action.
    const checkpoint = webhookRecordCount(this.monitor);
    await this.clearAlertFault();
    if (!(await this.waitForAlertState(alert, false, 90000))) return false;
    return this.waitForWebhookState(alert, "resolved", 30000, checkpoint);
  }

  private alertNameFor(fault: FaultKind): string {
    switch (fault) {
      case "missing-alert": return "PiAgentServerBackupFreshnessMissing";
      case "stale-alert": return "PiAgentServerBackupStale";
      case "future-alert": return "PiAgentServerBackupFutureTimestamp";
      case "exporter-down": return "PiAgentServerBackupExporterDown";
      case "textfile-scrape-error": return "PiAgentServerBackupTextfileScrapeError";
      default: return "";
    }
  }

  /** Return to a healthy monitoring baseline (fresh value, no scrape error, exporter up). */
  private async clearAlertFault(): Promise<void> {
    if (!this.monitor || !this.reports.sqlite) return;
    const now = Math.floor(Date.now() / 1000);
    // Clearing an injected future/missing file is fault cleanup; the resulting
    // healthy value is still published only by the production helper.
    const file = path.join(this.texts.dir, "drill-sqlite.prom");
    if (existsSync(file)) rmSync(file);
    const reportText = `backup-json-report: ${JSON.stringify(this.reports.sqlite)}\n`;
    await this.runFreshnessHelper({ textfileDir: this.texts.dir, targetId: "drill-sqlite", backupRoot: this.backups.sqlite, exitCode: 0, reportText, backupStartSec: now, nowSec: now });
    const bad = path.join(this.texts.dir, "bad.prom");
    if (existsSync(bad)) rmSync(bad);
    if (this.podmanOk(["container", "inspect", this.monitor.nodeExporter])) this.podman(["start", this.monitor.nodeExporter]);
  }

  /** Inject the specific alert fault (the condition that must make the alert fire). */
  private async applyAlertFault(fault: FaultKind): Promise<void> {
    if (!this.monitor) return;
    const now = Math.floor(Date.now() / 1000);
    switch (fault) {
      case "missing-alert": {
        const file = path.join(this.texts.dir, "drill-sqlite.prom");
        if (existsSync(file)) rmSync(file);
        break;
      }
      case "stale-alert":
      case "future-alert": {
        const file = path.join(this.texts.dir, "drill-sqlite.prom");
        if (existsSync(file)) rmSync(file);
        if (!this.reports.sqlite) break;
        const value = fault === "stale-alert" ? now - 86400 * 2 : now + 36000;
        await this.runFreshnessHelper({ textfileDir: this.texts.dir, targetId: "drill-sqlite", backupRoot: this.backups.sqlite, exitCode: 0, reportText: `backup-json-report: ${JSON.stringify(this.reports.sqlite)}\n`, backupStartSec: value, nowSec: fault === "future-alert" ? value : now });
        break;
      }
      case "exporter-down":
        if (this.podmanOk(["container", "inspect", this.monitor.nodeExporter])) this.podman(["stop", this.monitor.nodeExporter]);
        break;
      case "textfile-scrape-error": {
        const bad = path.join(this.texts.dir, "bad.prom");
        writeFileSync(bad, "this is not valid prometheus {\n", { mode: 0o600 });
        break;
      }
      default: break;
    }
  }

  private async waitForAlertState(alert: string, firing: boolean, timeoutMs = 60000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = this.isAlertFiring(alert);
      if (active === firing) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  private async waitForWebhookState(alert: string, state: "firing" | "resolved", timeoutMs: number, checkpoint: number): Promise<boolean> {
    if (!this.monitor) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (webhookSeenSince(this.monitor, alert, checkpoint, state)) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  async cleanup(): Promise<void> {
    if (!this.toolchain.podman) {
      this._resourcesCleaned = true;
      return;
    }
    const failures: string[] = [];
    try { if (this.monitor) await stopMonitorStack(this.monitor); } catch { failures.push("monitor"); }
    try { if (this.scheduler) await stopScheduler(this.scheduler); } catch { failures.push("scheduler"); }
    for (const name of this.ownedContainers) {
      const exists = this.podman(["container", "exists", name]);
      if (exists.status === 1) continue;
      if (exists.status !== 0) { failures.push("container existence"); continue; }
      const expected = this.ownedContainerIds.get(name);
      const actual = this.podman(["container", "inspect", "-f", "{{.Id}}", name]);
      if (!expected || actual.status !== 0 || actual.stdout.trim() !== expected) { failures.push("container ownership"); continue; }
      if (this.podman(["rm", "-f", name]).status !== 0 || this.podman(["container", "exists", name]).status !== 1) failures.push("container");
    }
    if (this.pgVolume) {
      const exists = this.podman(["volume", "exists", this.pgVolume]);
      if (exists.status === null || exists.status > 1 || exists.status < 0) failures.push("volume existence");
      else if (exists.status === 0) {
        const label = this.podman(["volume", "inspect", "-f", '{{index .Labels "pi-agent-server.drill.run"}}', this.pgVolume]);
        if (label.status !== 0 || label.stdout.trim() !== this.resourcePrefix) failures.push("volume ownership");
        else if (this.podman(["volume", "rm", "-f", this.pgVolume]).status !== 0 || this.podman(["volume", "exists", this.pgVolume]).status !== 1) failures.push("volume");
      }
    }
    if (this.networkCreated) {
      const exists = this.podman(["network", "exists", this.network]);
      if (exists.status === null || exists.status > 1 || exists.status < 0) failures.push("network existence");
      else if (exists.status === 0) {
        const label = this.podman(["network", "inspect", "-f", '{{index .Labels "pi-agent-server.drill.run"}}', this.network]);
        if (label.status !== 0 || label.stdout.trim() !== this.resourcePrefix) failures.push("network ownership");
        else if (this.podman(["network", "rm", this.network]).status !== 0 || this.podman(["network", "exists", this.network]).status !== 1) failures.push("network");
      }
    }
    const runImage = `${this.resourcePrefix}scheduler:latest`;
    if (this.schedulerImageOwned) {
      const exists = this.podman(["image", "exists", runImage]);
      if (exists.status === null || exists.status > 1 || exists.status < 0) failures.push("image existence");
      else if (exists.status === 0 && (this.podman(["image", "rm", runImage]).status !== 0 || this.podman(["image", "exists", runImage]).status !== 1)) failures.push("image");
    }
    if (failures.length > 0) throw new Error("drill resource cleanup failed");
    this._resourcesCleaned = true;
  }

  /** 保留证据供查看；默认不清理运行目录。 */
  async writeEvidence(adjudication: DrillAdjudication, plan: DrillPlan, observations: readonly DrillObservation[], resourceCleanup: boolean): Promise<string> {
    const evidence = buildDrillEvidence(adjudication, plan, observations, this.versions, new Date().toISOString(), resourceCleanup);
    const runsDir = path.join(this.envDir(), "runs");
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    const runId = `run-${Date.now()}`;
    const runDir = path.join(runsDir, runId);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const summaryFile = path.join(runDir, "summary.json");
    const redactables = collectRedactables(this.env);
    writeFileSync(summaryFile, redactText(JSON.stringify(evidence), redactables), { mode: 0o600 });
    chmodSync(summaryFile, 0o600);
    return runId;
  }
}

/** 在 127.0.0.1 上找一个空闲 TCP 端口（用于映射 PG 端口）。 */
function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        const port = typeof address === "object" && address !== null ? address.port : 0;
        if (port === 0) reject(new Error("could not allocate a free host port"));
        else resolve(port);
      });
    });
  });
}

function writeJsonlV3(file: string, count: number): void {
  const lines: string[] = [JSON.stringify({ type: "session", id: "root", version: 3 })];
  for (let i = 0; i < count; i += 1) lines.push(JSON.stringify({ type: "message", id: `m${i}`, parentId: "root" }));
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function findFileSuffix(root: string, suffix: string): string | null {
  const result: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (entry.endsWith(suffix)) result.push(full);
      } catch { /* ignore */ }
    }
  };
  walk(root);
  return result[0] ?? null;
}

function pgUrl(url: string, schema: string): string {
  const u = new URL(url);
  const opts = u.searchParams.get("options");
  u.searchParams.set("options", `-csearch_path=${schema}${opts ? ` ${opts}` : ""}`);
  return u.toString();
}

/** 从 URL 提取可安全用作库名后缀的字段（仅字母数字下划线）。 */
function sanitizeDbName(url: string): string {
  return (new URL(url).pathname.replace(/^\//, "") || "drill").replace(/[^A-Za-z0-9_]/g, "_");
}

/** 把 URL 指向一个新的、空的同名宿主数据库：替换 database 并清空 options（回落到默认 public）。 */
function replaceDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.searchParams.delete("options");
  return u.toString();
}

/**
 * 从本模块位置向上定位包根（含 dist-backup / dist-migrate），使编译产物与已安装包都能
 * 找到执行器所需编译 CLI；找不到时回退进程 cwd。
 */
export function findPackageRoot(moduleDir = path.dirname(fileURLToPath(import.meta.url))): string {
  let current = moduleDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, "dist-backup", "scripts", "backup.js")) && existsSync(path.join(current, "dist-migrate", "scripts", "migrate.js"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

/** 解析执行上下文：完整 preflight（root/private/overlap/secrets/资源）。 */
export function resolveExecutorContext(env: DrillEnv, cwd = process.cwd()): ExecutorContext {
  const root = resolveDrillRoot(env);
  const info = validateDrillRoot(root);
  validateDrillSecrets(root);
  const formal = resolveFormalPaths(env);
  assertNoFormalOverlap(info.canonical, formal, env.PI_DRILL_DATABASE_URL);
  validateDrillResources(root, env);
  const allowMonitoring = env.PI_DRILL_ALLOW_MONITORING === "1" || env.PI_DRILL_MONITORING === "1";
  const pkgRoot = findPackageRoot();
  return {
    env,
    root,
    cli: {
      backup: path.resolve(pkgRoot, "dist-backup", "scripts", "backup.js"),
      restore: path.resolve(pkgRoot, "dist-backup", "scripts", "restore.js"),
      migrate: path.resolve(pkgRoot, "dist-migrate", "scripts", "migrate.js"),
    },
    allowMonitoring,
  };
}

/**
 * 运行完整演练：依次执行计划内每个 step，收集 observations，判定 PASS/FAIL/DEFERRED，
 * 构建脱敏证据。任何 step 异常都记为 FAIL，绝不伪造 PASS。
 */
export async function runDrill(executor: DrillExecutor, env: DrillEnv, plan = defaultDrillPlan()): Promise<RunDrillOutcome> {
  const observations: DrillObservation[] = [];
  const redactables = collectRedactables(env);
  for (const spec of plan.steps) {
    let observation: DrillObservation;
    try {
      observation = await executor.step(spec.id);
    } catch (error) {
      observation = { stepId: spec.id, passed: false, detail: redactText(`step threw: ${error instanceof Error ? error.message : String(error)}`, redactables), durationMs: 0 };
    }
    observations.push(observation);
  }
  const adjudication = adjudicateDrill(observations, plan);
  const evidence = buildDrillEvidence(adjudication, plan, observations, executor.versions, new Date().toISOString());
  return { adjudication, observations, evidence };
}

/** 纯校验：提供的故障场景集合必须全部属于授权枚举。 */
export function assertValidFaultSet(faults: readonly string[]): void {
  const valid = new Set<string>(FAULT_KINDS);
  for (const fault of faults) {
    if (!valid.has(fault)) throw new Error(`unknown drill fault: ${fault}`);
  }
}

export { guardStepId, recoveryStepId };
