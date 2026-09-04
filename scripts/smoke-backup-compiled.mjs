import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { runSqliteMigrations } = await import(pathToFileURL(path.resolve("dist-backup/src/storage/migration-engine.js")));
const directory = mkdtempSync(path.join(tmpdir(), "pi-backup-build-smoke-"));
// Hermetic plaintext staging root: the build smoke must never depend on the
// real per-user config staging root (the compiled CLIs honor this variable).
process.env.PI_BACKUP_STAGING_ROOT = mkdtempSync(path.join(tmpdir(), "pi-smoke-staging-"));
const dataDir = path.join(directory, "data");
const backupRoot = path.join(directory, "backups");
const dbPath = path.join(dataDir, "pi-agent-server.db");
const recipient = path.join(directory, "recipient.txt");
const identity = path.join(directory, "identity");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, stdio: options.stdio ?? "pipe", encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed`);
  return result;
}

function createAgeKey() {
  run("age-keygen", ["--output", identity], { stdio: "ignore" });
  const extracted = run("age-keygen", ["-y", identity]);
  const publicRecipient = extracted.stdout.trim();
  if (!/^age1[0-9a-z]+$/.test(publicRecipient)) throw new Error("age recipient extraction failed");
  writeFileSync(recipient, `${publicRecipient}\n`, { mode: 0o600 });
}

async function createFixture() {
  mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
  const sessionFile = path.join(dataDir, "sessions", "s1", "history.jsonl");
  writeFileSync(sessionFile, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/smoke"}\n{"type":"message","id":"entry","parentId":null,"timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":"smoke","timestamp":1}}\n', { mode: 0o600 });
  const db = new DatabaseSync(dbPath);
  await runSqliteMigrations(db, { mode: "apply" });
  db.prepare("INSERT INTO projects (id,name,cwd,owner_key,created_at) VALUES (?,?,?,?,?)").run("p", "smoke", "/smoke", "owner", 1);
  db.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at,pi_session_file,capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("s", "owner", "p", "smoke", 1, 1, sessionFile, JSON.stringify({ schema: 1 }));
  db.close();
}

function assertRestoreReport(targetRoot, result) {
  if (result.status !== 0) throw new Error("compiled restore E2E failed");
  const report = JSON.parse(result.stdout.trim());
  if (report.status !== "success" || report.dryRun !== false || report.counts.sessions !== 1 || report.counts.jsonlFiles !== 1) throw new Error("compiled restore safety report is incomplete");
  const published = readdirSync(targetRoot).find((entry) => entry.startsWith("restore-"));
  if (!published) throw new Error("compiled restore did not publish a drill directory");
  const finalPath = path.join(targetRoot, published);
  const db = new DatabaseSync(path.join(finalPath, "pi-agent-server.db"), { readOnly: true });
  const row = db.prepare("SELECT pi_session_file FROM sessions WHERE id = 's'").get();
  db.close();
  const expected = path.join(finalPath, "sessions/s1/history.jsonl");
  if (!row || realpathSync(row.pi_session_file) !== realpathSync(expected) || row.pi_session_file.includes(path.join(dataDir, "sessions")) || !readFileSync(expected, "utf8").includes('"type":"session"')) throw new Error("compiled restore data/remap verification failed");
}

try {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  createAgeKey();
  await createFixture();
  const create = run(process.execPath, ["dist-backup/scripts/backup.js", "create", "--backup-root", backupRoot, "--age-recipient-file", recipient], {
    cwd: process.cwd(), env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath },
  });
  const packages = readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-"));
  if (create.status !== 0 || packages.length !== 1) throw new Error("compiled backup E2E did not publish a package");
  const targetRoot = path.join(directory, "restore-target");
  const restore = run(process.execPath, ["dist-backup/scripts/restore.js", "restore", "--input-backup", path.join(backupRoot, packages[0]), "--target-root", targetRoot, "--age-identity-file", identity], { cwd: process.cwd(), env: { ...process.env } });
  assertRestoreReport(targetRoot, restore);

  // Keep the safety-failure smoke separate from the successful E2E path.
  const failed = spawnSync(process.execPath, ["dist-backup/scripts/restore.js", "restore", "--input-backup", dataDir, "--target-root", path.join(directory, "bad-target"), "--age-identity-file", identity], { cwd: process.cwd(), env: { ...process.env }, encoding: "utf8" });
  if (failed.status === 0 || failed.stdout.includes(dataDir) || failed.stderr.includes(dataDir) || existsSync(path.join(directory, "bad-target"))) throw new Error("compiled restore safe-failure smoke failed");
  console.log("compiled backup/restore E2E and safe-failure smoke: ok");
} finally {
  rmSync(process.env.PI_BACKUP_STAGING_ROOT, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}
