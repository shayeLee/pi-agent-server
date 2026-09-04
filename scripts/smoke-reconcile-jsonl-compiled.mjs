// WP4C（方案 A 收敛）compiled-CLI smoke：只读 DB reference analyzer 契约。
// - default/--dry-run 零写：DB 字节指纹不变、无 -wal/-shm 伴生创建；
// - 分析纯字符串：DATA_DIR 不要求存在（绝不创建目录）；相对/root DATA_DIR 非零退出；
// - DB_PATH 指向不存在目标：绝不创建 DB/WAL/SHM（非零退出）；
// - --apply 立即 fail-closed（退出码 2），确认词/执行器参数一律拒绝；
// - stdout JSON 与 stderr 均不包含绝对/相对路径、URL、session id；
// - 报告明确 filesystemNotScanned / cannotDetect（不扫描文件系统）。
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkDistHygiene } from "./dist-hygiene.mjs";
import { checkReconcileClosure } from "./reconcile-closure.mjs";

// 发布产物卫生：编译产物树中不允许出现已移除执行器残留文件或任何符号链接。
checkDistHygiene("dist-reconcile");
// 最小依赖闭包（strict hygiene）：dist-reconcile 只允许 scripts/ 与
// src/{application,file-operations,storage}——不含 server/start runtime、
// backup/cutover、outbox writer / WP4B planner 域等文件系统副作用模块。
checkReconcileClosure("dist-reconcile");

const { runSqliteMigrations } = await import(pathToFileURL(path.resolve("dist-reconcile/src/storage/migration-engine.js")));
const DEFAULT_PROJECT_ID = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const directory = mkdtempSync(path.join(tmpdir(), "pi-reconcile-smoke-"));
// DATA_DIR 仅作词法绑定字符串：不创建（证明 compiled CLI 不触碰文件系统）。
const dataDir = path.join(directory, "data");
const dbPath = path.join(directory, "pi-agent-server.db");

function cli(args, options = {}) {
  return spawnSync("node", ["dist-reconcile/scripts/reconcile-jsonl.js", "run", ...args], { ...options, stdio: "pipe", encoding: "utf8" });
}
const env = () => ({ ...process.env, DB_PATH: dbPath, DATA_DIR: dataDir });

function insertSession(db, sessionId, piSessionFile) {
  db.prepare("INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, model_provider, model_id, thinking_level, system_prompt, capability_versions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    sessionId, "owner", DEFAULT_PROJECT_ID, "title", 1, 1, piSessionFile, null, null, null, null, null,
  );
}

function sidecars() {
  return readdirSync(directory).filter((name) => name.startsWith("pi-agent-server.db")).sort();
}

try {
  const db = new DatabaseSync(dbPath);
  await runSqliteMigrations(db, { mode: "apply" });
  db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?,?,?,?,?)").run(DEFAULT_PROJECT_ID, "默认项目", "/tmp", "", 0);
  // s1 valid、s2 unmaterialized（null）、s3 traversal → invalid、s1-dup → duplicate。
  insertSession(db, "s1", path.join(dataDir, "sessions", "s1", "2025-01-01T00-00-00_s1.jsonl"));
  insertSession(db, "s2", null);
  insertSession(db, "s3", path.join(dataDir, "..", "escape.jsonl"));
  insertSession(db, "s1-dup", path.join(dataDir, "sessions", "s1", "2025-01-01T00-00-00_s1.jsonl"));
  db.close();
  const beforeBytes = readFileSync(dbPath);

  // 1) default = dry-run：分类正确、零写、DB 字节指纹不变、无 -wal/-shm、无路径泄漏。
  const dry = cli([], { env: env() });
  if (dry.status !== 0) throw new Error(`compiled dry-run failed: ${dry.stderr}`);
  const dryReport = JSON.parse(dry.stdout.trim());
  if (
    dryReport.status !== "analyzed" || dryReport.mode !== "dry-run" || dryReport.executable !== false ||
    dryReport.filesystemNotScanned !== true ||
    dryReport.cannotDetect?.orphanFile !== false || dryReport.cannotDetect?.lostFile !== false || dryReport.cannotDetect?.jsonlValidity !== false ||
    dryReport.references !== 4 || dryReport.unmaterialized !== 1 || dryReport.valid !== 1 ||
    dryReport.invalidReferences !== 1 || dryReport.duplicateReferences !== 1
  ) {
    throw new Error("compiled dry-run reconcile analyzer contract violated");
  }
  if (!readFileSync(dbPath).equals(beforeBytes)) throw new Error("compiled dry-run modified the database file");
  if (sidecars().length !== 1) throw new Error("compiled dry-run created -wal/-shm sidecars");
  const allOutput = `${dry.stdout}\n${dry.stderr ?? ""}`;
  for (const secret of [dataDir, dbPath, ".jsonl", "sessions/", "s1", "s1-dup", "escape.jsonl", "postgres://"]) {
    if (allOutput.includes(secret)) throw new Error(`compiled dry-run leaked: ${secret}`);
  }
  if (existsSync(dataDir)) throw new Error("compiled dry-run created the DATA_DIR");

  // 2) 缺失 DB：绝不创建 DB/WAL/SHM，非零退出，不回显路径。
  const missingDir = path.join(directory, "missing");
  mkdirSync(missingDir);
  const missing = cli([], { env: { ...process.env, DB_PATH: path.join(missingDir, "pi-agent-server.db"), DATA_DIR: dataDir } });
  if (missing.status === 0) throw new Error("missing DB must not be planned");
  if (readdirSync(missingDir).length !== 0) throw new Error("missing DB run created DB/WAL/SHM");
  if (missing.stdout.includes(missingDir) || missing.stderr.includes(missingDir)) throw new Error("missing DB run leaked the path");

  // 3) DATA_DIR 纯字符串契约：相对/root fail-closed；不存在的绝对路径合法（不扫描）。
  const relativeData = cli([], { env: { ...process.env, DB_PATH: dbPath, DATA_DIR: "relative/data" } });
  if (relativeData.status === 0) throw new Error("relative DATA_DIR must fail");
  const rootData = cli([], { env: { ...process.env, DB_PATH: dbPath, DATA_DIR: "/" } });
  if (rootData.status === 0) throw new Error("root DATA_DIR must fail");
  const neverCreated = path.join(directory, "never-created");
  const lexical = cli([], { env: { ...process.env, DB_PATH: dbPath, DATA_DIR: neverCreated } });
  if (lexical.status !== 0) throw new Error("non-existent absolute DATA_DIR must be accepted (lexical binding only)");
  if (!JSON.parse(lexical.stdout.trim()).filesystemNotScanned) throw new Error("lexical run lost filesystemNotScanned");
  if (existsSync(neverCreated)) throw new Error("lexical run created the DATA_DIR");

  // 4) --apply 立即 fail-closed（exit 2）、零写；确认词/执行器参数不可绕过。
  const noApply = cli(["--apply"], { env: env() });
  if (noApply.status !== 2) throw new Error("--apply must fail closed with exit 2");
  if (noApply.stdout.trim() !== "" || !noApply.stderr.includes("--apply 未实现")) throw new Error("--apply fail-closed message missing");
  const legacy = cli(["--apply", "--confirm-maintenance", "EXECUTE_RECONCILE", "--maintenance-window", "CONFIRMED", "--quarantine-root", "/tmp/q"], { env: env() });
  if (legacy.status !== 2) throw new Error("legacy confirmation tokens must not bypass fail-closed");
  const flag = cli(["--limit", "5"], { env: env() });
  if (flag.status !== 2) throw new Error("executor flags must be rejected with exit 2");
  const unknown = cli(["--frobnicate"], { env: env() });
  if (unknown.status !== 2) throw new Error("unknown argument must exit 2");
  const repeated = cli(["--dry-run", "--dry-run"], { env: env() });
  if (repeated.status !== 2) throw new Error("repeated argument must exit 2");
  if (!readFileSync(dbPath).equals(beforeBytes)) {
    throw new Error("fail-closed paths wrote something");
  }

  console.log("compiled reconcile-jsonl smoke: ok");
} finally {
  rmSync(directory, { recursive: true, force: true });
}