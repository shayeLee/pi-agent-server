// WP4B（方案 A）compiled-CLI smoke：只读 planner 契约。
// - default/--dry-run 零写：行状态不变、DB 字节指纹不变、无 -wal/-shm 伴生创建；
// - DB_PATH 指向不存在目标：绝不创建 DB/WAL/SHM（非零退出）；
// - --apply 立即 fail-closed（退出码 2），旧确认词/维护窗口词与执行器参数一律拒绝；
// - stdout JSON 与 stderr 均不包含绝对/相对路径。
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkDistHygiene } from "./dist-hygiene.mjs";

// 发布产物卫生：编译产物树中不允许出现已移除执行器的残留文件或任何符号链接。
checkDistHygiene("dist-file-ops");

const { runSqliteMigrations } = await import(pathToFileURL(path.resolve("dist-file-ops/src/storage/migration-engine.js")));
const directory = mkdtempSync(path.join(tmpdir(), "pi-file-ops-smoke-"));
const dataDir = path.join(directory, "data");
const dbPath = path.join(dataDir, "pi-agent-server.db");
const sessionDir = path.join(dataDir, "sessions", "s1");
const sessionFile = path.join(sessionDir, "history.jsonl");

function run(args, options = {}) {
  return spawnSync("node", ["dist-file-ops/scripts/file-ops.js", "run", ...args], { ...options, stdio: "pipe", encoding: "utf8" });
}
const env = () => ({ ...process.env, DB_PATH: dbPath });

function fixtureDeleteOp(db, opKey, relativePath, extra = {}) {
  const createdAt = extra.createdAt ?? Date.now();
  db.prepare("INSERT INTO file_operations (id, operation_key, kind, relative_path, session_id, project_id, state, attempt_count, available_at, lease_until, lease_token, last_error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    extra.id ?? randomUUID(), opKey, "delete", relativePath, null, null, "pending", 0, createdAt, null, null, null, createdAt, createdAt,
  );
}

function rowState() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT state, attempt_count FROM file_operations WHERE operation_key = 'smoke-delete'").get();
    return row ? { state: row.state, attemptCount: Number(row.attempt_count) } : null;
  } finally {
    db.close();
  }
}

function sidecars() {
  return readdirSync(dataDir).filter((name) => name.startsWith("pi-agent-server.db")).sort();
}

try {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/smoke"}\n{"type":"message","id":"entry","parentId":null,"timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":"smoke","timestamp":1}}\n', { mode: 0o600 });
  const db = new DatabaseSync(dbPath);
  await runSqliteMigrations(db, { mode: "apply" });
  fixtureDeleteOp(db, "smoke-delete", "sessions/s1/history.jsonl");
  db.close();
  const beforeBytes = readFileSync(dbPath);

  // 1) default = dry-run：零写、行不动、DB 字节指纹不变、无 -wal/-shm。
  const dry = run([], { env: env() });
  if (dry.status !== 0) throw new Error(`compiled dry-run failed: ${dry.stderr}`);
  const dryReport = JSON.parse(dry.stdout.trim());
  if (dryReport.status !== "planned" || dryReport.mode !== "dry-run" || dryReport.executable !== false || dryReport.planned !== 1) {
    throw new Error("compiled dry-run planner contract violated");
  }
  if (!existsSync(sessionFile)) throw new Error("compiled dry-run touched the session file");
  const dryRow = rowState();
  if (!dryRow || dryRow.state !== "pending" || dryRow.attemptCount !== 0) throw new Error("compiled dry-run changed outbox state");
  if (!readFileSync(dbPath).equals(beforeBytes)) throw new Error("compiled dry-run modified the database file");
  if (sidecars().length !== 1) throw new Error("compiled dry-run created -wal/-shm sidecars");
  if (dry.stdout.includes(dataDir) || dry.stderr.includes(dataDir) || dry.stdout.includes("history.jsonl") || dry.stderr.includes("history.jsonl")) {
    throw new Error("compiled dry-run leaked a path");
  }

  // 2) DB_PATH 指向不存在目标：绝不创建 DB/WAL/SHM，非零退出。
  const missingDir = path.join(directory, "missing");
  mkdirSync(missingDir);
  const missing = spawnSync("node", ["dist-file-ops/scripts/file-ops.js", "run"], { env: { ...process.env, DB_PATH: path.join(missingDir, "pi-agent-server.db") }, stdio: "pipe", encoding: "utf8" });
  if (missing.status === 0) throw new Error("missing DB must not be created or planned");
  if (readdirSync(missingDir).length !== 0) throw new Error("missing DB run created DB/WAL/SHM");
  if (missing.stdout.includes(missingDir) || missing.stderr.includes(missingDir)) throw new Error("missing DB run leaked the path");

  // 3) --apply：立即 fail-closed（exit 2）、零写；旧确认词/维护窗口词与执行器参数不可绕过。
  const noApply = run(["--apply"], { env: env() });
  if (noApply.status !== 2) throw new Error("--apply must fail closed with exit 2");
  if (noApply.stdout.trim() !== "" || !noApply.stderr.includes("--apply 未实现")) throw new Error("--apply fail-closed message missing");
  const legacy = run(["--apply", "--confirm-maintenance", "EXECUTE_FILE_OPERATIONS", "--maintenance-window", "CONFIRMED"], { env: env() });
  if (legacy.status !== 2 || !existsSync(sessionFile)) throw new Error("legacy confirmation tokens must not bypass fail-closed");
  const flag = run(["--limit", "5"], { env: env() });
  if (flag.status !== 2) throw new Error("executor flags must be rejected with exit 2");
  const unknown = run(["--frobnicate"], { env: env() });
  if (unknown.status !== 2) throw new Error("unknown argument must exit 2");
  const repeated = run(["--dry-run", "--dry-run"], { env: env() });
  if (repeated.status !== 2) throw new Error("repeated argument must exit 2");
  if (rowState()?.state !== "pending" || !existsSync(sessionFile)) throw new Error("fail-closed paths wrote something");

  console.log("compiled file-ops planner smoke: ok");
} finally {
  rmSync(directory, { recursive: true, force: true });
}