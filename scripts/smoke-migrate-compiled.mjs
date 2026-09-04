import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (packageJson.bin?.["pi-agent-server-migrate"] !== "./dist-migrate/scripts/migrate.js" || !packageJson.files?.includes("dist-migrate") || !existsSync("dist-migrate/scripts/migrate.js")) {
  throw new Error("compiled migration package bin is missing or points outside dist-migrate");
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, { ...options, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`migration smoke failed: ${args.join(" ")}`);
  return result;
}

function lastJsonLine(stdout) {
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error("migration smoke produced no machine result");
  return JSON.parse(line);
}

function createAgeFiles(directory) {
  const identity = path.join(directory, "identity");
  const recipient = path.join(directory, "recipient");
  runExternal("age-keygen", ["--output", identity], { stdio: "ignore" });
  const extracted = runExternal("age-keygen", ["-y", identity]);
  const publicRecipient = extracted.stdout.trim();
  if (!/^age1[0-9a-z]+$/.test(publicRecipient)) throw new Error("compiled migration age recipient extraction failed");
  writeFileSync(recipient, `${publicRecipient}\n`, { mode: 0o600 });
  return { identity, recipient };
}

function runExternal(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} smoke failed`);
  return result;
}

const directory = mkdtempSync(path.join(tmpdir(), "pi-migrate-build-smoke-"));
// Hermetic plaintext staging root: the build smoke must never depend on the
// real per-user config staging root (the compiled CLIs honor this variable).
process.env.PI_BACKUP_STAGING_ROOT = mkdtempSync(path.join(tmpdir(), "pi-smoke-staging-"));
const dataDir = path.join(directory, "data");
const dbPath = path.join(dataDir, "smoke.db");
const backupRoot = path.join(directory, "backups");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
writeFileSync(dbPath, "", { mode: 0o600 });
const { recipient, identity } = createAgeFiles(directory);
const env = { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath, PI_STORAGE_DIALECT: "sqlite" };

try {
  // Keep a failure smoke: apply without the explicit prebackup gates must not
  // touch the empty database or emit a migration result.
  const missingGates = spawnSync(process.execPath, ["dist-migrate/scripts/migrate.js", "--apply"], { cwd: process.cwd(), env, encoding: "utf8" });
  if (missingGates.status === 0 || `${missingGates.stdout}${missingGates.stderr}`.includes("migration result")) throw new Error("compiled migration apply did not fail closed without pre-backup gates");

  const result = run(["dist-migrate/scripts/migrate.js", "--apply", "--backup-root", backupRoot, "--age-recipient-file", recipient, "--maintenance-window", "CONFIRMED"], { cwd: process.cwd(), env });
  const report = lastJsonLine(result.stdout);
  if (report.status !== "success" || report.mode !== "apply" || report.migration?.mode !== "apply" || report.migration?.status !== "applied" || report.migration?.pending !== 0 || report.verify?.mode !== "verify" || report.verify?.status !== "verified" || report.verify?.pending !== 0 || report.migration.appliedVersion !== report.verify.appliedVersion) throw new Error("compiled migration machine result is incomplete");
  const packages = readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-"));
  if (packages.length !== 1) throw new Error("compiled migration did not publish exactly one prebackup");
  const packagePath = path.join(backupRoot, packages[0]);
  const manifest = runExternal("age", ["--decrypt", "--identity", identity, path.join(packagePath, "manifest.json.age")]);
  const metadata = JSON.parse(manifest.stdout);
  if (metadata.kind !== "pre-migration" || metadata.migrationLedger.present !== false || metadata.migrationLedger.appliedVersion !== null || metadata.migrationLedger.pending !== 0) throw new Error("compiled prebackup was not captured before migration");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const ledger = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
  db.close();
  if (JSON.stringify(ledger) !== JSON.stringify([{ version: 0, name: "initial-schema" }, { version: 1, name: "file-operations-outbox" }])) throw new Error("compiled migration ledger is incomplete");
  console.log("compiled migration CLI real apply/prebackup/verify smoke: ok");
} finally {
  rmSync(process.env.PI_BACKUP_STAGING_ROOT, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}
