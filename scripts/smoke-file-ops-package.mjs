// WP4B（方案 A）installed-npm-bin smoke：发布的包必须携带
// pi-agent-server-file-ops bin，且安装后的 bin 只提供只读 planner：
// dry-run 零写、缺失 DB 零创建、--apply fail-closed、报告无路径泄漏。
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkDistHygiene } from "./dist-hygiene.mjs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (packageJson.bin?.["pi-agent-server-file-ops"] !== "./dist-file-ops/scripts/file-ops.js" || !packageJson.files?.includes("dist-file-ops") || !existsSync("dist-file-ops/scripts/file-ops.js")) {
  throw new Error("compiled file-ops package bin is missing or points outside dist-file-ops");
}
const directory = mkdtempSync(path.join(tmpdir(), "pi-file-ops-package-smoke-"));
const cache = path.join(directory, "npm-cache");
const packageDir = path.join(directory, "package");
const installDir = path.join(directory, "install");
const dataDir = path.join(directory, "data");
const dbPath = path.join(dataDir, "pi-agent-server.db");
const sessionDir = path.join(dataDir, "sessions", "s1");
const sessionFile = path.join(sessionDir, "history.jsonl");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, stdio: options.stdio ?? "pipe", encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${result.stderr}`);
  return result;
}

function npm(args) {
  return run("npm", ["--no-audit", "--no-fund", ...args], {
    env: { ...process.env, npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
  });
}

function binEnv() {
  return { ...process.env, DB_PATH: dbPath };
}

try {
  mkdirSync(packageDir, { recursive: true, mode: 0o700 });
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  const packed = npm(["pack", "--pack-destination", packageDir]);
  const tarball = packed.stdout.trim().split(/\r?\n/).at(-1);
  if (!tarball || !existsSync(path.join(packageDir, tarball))) throw new Error("npm pack tarball is missing");
  npm(["install", "--ignore-scripts", "--prefix", installDir, path.join(packageDir, tarball)]);
  const packageRoot = path.join(installDir, "node_modules", packageJson.name);
  // 发布产物卫生：安装后的包内不允许出现已移除执行器残留文件或任何符号链接。
  checkDistHygiene(packageRoot);
  const fileOpsBin = path.join(installDir, "node_modules", ".bin", "pi-agent-server-file-ops");
  if (!existsSync(fileOpsBin)) throw new Error("installed file-ops bin is missing");
  const { runSqliteMigrations } = await import(pathToFileURL(path.join(packageRoot, "dist-file-ops/src/storage/migration-engine.js")));

  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/smoke"}\n', { mode: 0o600 });
  const db = new DatabaseSync(dbPath);
  await runSqliteMigrations(db, { mode: "apply" });
  const createdAt = Date.now();
  db.prepare("INSERT INTO file_operations (id, operation_key, kind, relative_path, session_id, project_id, state, attempt_count, available_at, lease_until, lease_token, last_error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "pkg-smoke-delete", "delete", "sessions/s1/history.jsonl", null, null, "pending", 0, createdAt, null, null, null, createdAt, createdAt,
  );
  db.close();
  const beforeBytes = readFileSync(dbPath);

  // 默认 dry-run 零写 + 无路径泄漏。
  const dry = spawnSync(fileOpsBin, ["run"], { cwd: process.cwd(), env: binEnv(), encoding: "utf8" });
  if (dry.status !== 0) throw new Error("installed dry-run failed");
  const dryReport = JSON.parse(dry.stdout.trim());
  if (dryReport.status !== "planned" || dryReport.executable !== false || dryReport.planned !== 1 || !existsSync(sessionFile)) {
    throw new Error("installed dry-run zero-write contract violated");
  }
  if (!readFileSync(dbPath).equals(beforeBytes)) throw new Error("installed dry-run modified the database");
  if (readdirSync(dataDir).filter((name) => name.startsWith("pi-agent-server.db")).length !== 1) throw new Error("installed dry-run created -wal/-shm");
  if (dry.stdout.includes(dataDir) || dry.stderr.includes(dataDir) || dry.stdout.includes("history.jsonl")) throw new Error("installed dry-run leaked a path");

  // --apply fail-closed：退出码 2，确认词不可绕过，零写。
  const apply = spawnSync(fileOpsBin, ["run", "--apply", "--confirm-maintenance", "EXECUTE_FILE_OPERATIONS", "--maintenance-window", "CONFIRMED"], { cwd: process.cwd(), env: binEnv(), encoding: "utf8" });
  if (apply.status !== 2) throw new Error("installed --apply must fail closed with exit 2");
  if (!apply.stderr.includes("--apply 未实现")) throw new Error("installed --apply fail-closed message missing");
  if (apply.stdout.trim() !== "" || !existsSync(sessionFile)) throw new Error("installed --apply wrote something");

  // 缺失 DB 零创建（DB/WAL/SHM 均不得出现）。
  const missingDir = path.join(directory, "missing");
  mkdirSync(missingDir);
  const missing = spawnSync(fileOpsBin, ["run"], { cwd: process.cwd(), env: { ...process.env, DB_PATH: path.join(missingDir, "pi-agent-server.db") }, encoding: "utf8" });
  if (missing.status === 0 || readdirSync(missingDir).length !== 0) throw new Error("installed missing-DB run created DB/WAL/SHM");

  console.log("installed npm file-ops planner bin smoke: ok");
} finally {
  rmSync(directory, { recursive: true, force: true });
}