import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const directory = mkdtempSync(path.join(tmpdir(), "pi-migrate-package-smoke-"));
// Hermetic plaintext staging root: the build smoke must never depend on the
// real per-user config staging root (the compiled CLIs honor this variable).
process.env.PI_BACKUP_STAGING_ROOT = mkdtempSync(path.join(tmpdir(), "pi-smoke-staging-"));
const cache = path.join(directory, "npm-cache");
const packageDir = path.join(directory, "package");
const installDir = path.join(directory, "install");
const dataDir = path.join(directory, "data");
const backupRoot = path.join(directory, "backups");
const dbPath = path.join(dataDir, "smoke.db");
const recipient = path.join(directory, "recipient");
const identity = path.join(directory, "identity");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} smoke failed`);
  return result;
}
function npm(args) {
  return run("npm", ["--no-audit", "--no-fund", ...args], { env: { ...process.env, npm_config_cache: cache, NPM_CONFIG_CACHE: cache } });
}
function lastJsonLine(stdout, stderr = "") {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch { /* human-readable target line */ }
  }
  throw new Error(`installed migration produced no machine result: ${stdout} ${stderr}`);
}

try {
  mkdirSync(packageDir, { recursive: true, mode: 0o700 });
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(dbPath, "", { mode: 0o600 });
  run("age-keygen", ["--output", identity], { stdio: "ignore" });
  const extracted = run("age-keygen", ["-y", identity]);
  writeFileSync(recipient, `${extracted.stdout.trim()}\n`, { mode: 0o600 });

  const packed = npm(["pack", "--pack-destination", packageDir]);
  const tarball = packed.stdout.trim().split(/\r?\n/).at(-1);
  if (!tarball || !existsSync(path.join(packageDir, tarball))) throw new Error("migration package tarball is missing");
  npm(["install", "--ignore-scripts", "--prefix", installDir, path.join(packageDir, tarball)]);
  const migrateBin = path.join(installDir, "node_modules", ".bin", "pi-agent-server-migrate");
  if (!existsSync(migrateBin) || packageJson.bin?.["pi-agent-server-migrate"] !== "./dist-migrate/scripts/migrate.js") throw new Error("installed migration bin is missing");

  const env = { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath, PI_STORAGE_DIALECT: "sqlite" };
  const failed = spawnSync(migrateBin, ["--apply"], { cwd: process.cwd(), env, encoding: "utf8" });
  if (failed.status === 0 || `${failed.stdout}${failed.stderr}`.includes("migration result")) throw new Error("installed migration failure smoke did not fail closed");
  const result = run(migrateBin, ["--apply", "--backup-root", backupRoot, "--age-recipient-file", recipient, "--maintenance-window", "CONFIRMED"], { cwd: process.cwd(), env });
  if (!result.stdout.includes('migration result') && !result.stdout.includes('"status":"success"')) {
    throw new Error(`installed migration unexpected exit=${result.status} signal=${result.signal}: stdout=${result.stdout} stderr=${result.stderr}`);
  }
  const report = lastJsonLine(result.stdout, result.stderr);
  if (report.status !== "success" || report.migration?.mode !== "apply" || report.migration?.status !== "applied" || report.migration?.pending !== 0 || report.verify?.mode !== "verify" || report.verify?.status !== "verified" || report.verify?.pending !== 0 || report.migration.appliedVersion !== report.verify.appliedVersion) throw new Error("installed migration machine result is incomplete");
  if (readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-")).length !== 1) throw new Error("installed migration did not publish prebackup");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const ledger = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
  db.close();
  if (JSON.stringify(ledger) !== JSON.stringify([{ version: 0, name: "initial-schema" }, { version: 1, name: "file-operations-outbox" }])) throw new Error("installed migration ledger is incomplete");
  console.log("installed npm migration real apply/prebackup/verify smoke: ok");
} finally {
  rmSync(process.env.PI_BACKUP_STAGING_ROOT, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}
