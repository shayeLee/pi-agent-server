// WP4C（方案 A 收敛）installed-npm-bin smoke：发布的包必须携带
// pi-agent-server-reconcile-jsonl bin，且安装后的 bin 只提供只读 DB reference
// 分析：dry-run 零写、缺失 DB 零创建、--apply fail-closed、报告无路径泄漏、
// filesystemNotScanned 明确、DATA_DIR 不要求存在。
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkDistHygiene } from "./dist-hygiene.mjs";
import { checkReconcileClosure } from "./reconcile-closure.mjs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (
  packageJson.bin?.["pi-agent-server-reconcile-jsonl"] !== "./dist-reconcile/scripts/reconcile-jsonl.js" ||
  !packageJson.files?.includes("dist-reconcile") ||
  !existsSync("dist-reconcile/scripts/reconcile-jsonl.js")
) {
  throw new Error("compiled reconcile-jsonl package bin is missing or points outside dist-reconcile");
}
// 最小依赖闭包（strict hygiene）：本地 dist-reconcile 先于 pack 断言闭包范围。
checkReconcileClosure("dist-reconcile");
const DEFAULT_PROJECT_ID = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";
const directory = mkdtempSync(path.join(tmpdir(), "pi-reconcile-package-smoke-"));
const cache = path.join(directory, "npm-cache");
const packageDir = path.join(directory, "package");
const installDir = path.join(directory, "install");
// DATA_DIR 仅作词法绑定字符串：不创建（证明 installed bin 不触碰文件系统）。
const dataDir = path.join(directory, "data");
const dbPath = path.join(directory, "pi-agent-server.db");

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
  return { ...process.env, DB_PATH: dbPath, DATA_DIR: dataDir };
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
  // 最小依赖闭包（strict hygiene）：安装后的 dist-reconcile 同样只允许
  // scripts/ 与 src/{application,file-operations,storage}。
  checkReconcileClosure(path.join(packageRoot, "dist-reconcile"));
  const reconcileBin = path.join(installDir, "node_modules", ".bin", "pi-agent-server-reconcile-jsonl");
  if (!existsSync(reconcileBin)) throw new Error("installed reconcile-jsonl bin is missing");
  const { runSqliteMigrations } = await import(pathToFileURL(path.join(packageRoot, "dist-reconcile/src/storage/migration-engine.js")));

  const db = new DatabaseSync(dbPath);
  await runSqliteMigrations(db, { mode: "apply" });
  db.prepare("INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES (?,?,?,?,?)").run(DEFAULT_PROJECT_ID, "默认项目", "/tmp", "", 0);
  db.prepare(
    "INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, model_provider, model_id, thinking_level, system_prompt, capability_versions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("pkg-s1", "owner", DEFAULT_PROJECT_ID, "title", 1, 1, path.join(dataDir, "sessions", "pkg-s1", "2025-01-01T00-00-00_pkg-s1.jsonl"), null, null, null, null, null);
  db.prepare(
    "INSERT INTO sessions (id, owner_key, project_id, title, created_at, updated_at, pi_session_file, model_provider, model_id, thinking_level, system_prompt, capability_versions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("pkg-lazy", "owner", DEFAULT_PROJECT_ID, "title", 1, 1, null, null, null, null, null);
  db.close();
  const beforeBytes = readFileSync(dbPath);

  // 默认 dry-run：valid + unmaterialized、零写、无路径泄漏、不创建 DATA_DIR。
  const dry = spawnSync(reconcileBin, ["run"], { cwd: process.cwd(), env: binEnv(), encoding: "utf8" });
  if (dry.status !== 0) throw new Error("installed dry-run failed");
  const dryReport = JSON.parse(dry.stdout.trim());
  if (
    dryReport.status !== "analyzed" || dryReport.mode !== "dry-run" || dryReport.executable !== false ||
    dryReport.filesystemNotScanned !== true ||
    dryReport.cannotDetect?.orphanFile !== false || dryReport.cannotDetect?.lostFile !== false || dryReport.cannotDetect?.jsonlValidity !== false ||
    dryReport.references !== 2 || dryReport.unmaterialized !== 1 || dryReport.valid !== 1
  ) {
    throw new Error("installed dry-run reconcile analyzer contract violated");
  }
  if (!readFileSync(dbPath).equals(beforeBytes)) throw new Error("installed dry-run modified the database");
  if (readdirSync(directory).filter((name) => name.startsWith("pi-agent-server.db")).length !== 1) throw new Error("installed dry-run created -wal/-shm");
  const allOutput = `${dry.stdout}\n${dry.stderr ?? ""}`;
  for (const secret of [dataDir, dbPath, ".jsonl", "sessions/", "pkg-s1", "postgres://"]) {
    if (allOutput.includes(secret)) throw new Error(`installed dry-run leaked: ${secret}`);
  }
  if (!dry.stderr.includes("filesystemNotScanned")) throw new Error("installed dry-run note missing filesystemNotScanned");

  // --apply fail-closed：退出码 2，确认词不可绕过，零写。
  const apply = spawnSync(reconcileBin, ["run", "--apply", "--confirm-maintenance", "EXECUTE_RECONCILE", "--maintenance-window", "CONFIRMED"], { cwd: process.cwd(), env: binEnv(), encoding: "utf8" });
  if (apply.status !== 2) throw new Error("installed --apply must fail closed with exit 2");
  if (!apply.stderr.includes("--apply 未实现")) throw new Error("installed --apply fail-closed message missing");
  if (apply.stdout.trim() !== "" || !readFileSync(dbPath).equals(beforeBytes)) throw new Error("installed --apply wrote something");

  // 缺失 DB 零创建（DB/WAL/SHM 均不得出现）。
  const missingDir = path.join(directory, "missing");
  mkdirSync(missingDir);
  const missing = spawnSync(reconcileBin, ["run"], { cwd: process.cwd(), env: { ...process.env, DB_PATH: path.join(missingDir, "pi-agent-server.db"), DATA_DIR: dataDir }, encoding: "utf8" });
  if (missing.status === 0 || readdirSync(missingDir).length !== 0) throw new Error("installed missing-DB run created DB/WAL/SHM");

  console.log("installed npm reconcile-jsonl bin smoke: ok");
} finally {
  rmSync(directory, { recursive: true, force: true });
}