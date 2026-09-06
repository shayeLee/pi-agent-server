import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkDistHygiene } from "./dist-hygiene.mjs";

// 发布产物卫生：编译产物树中不允许出现已移除执行器的残留文件或任何符号链接。
checkDistHygiene("dist-backup");

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
// Hermetic credential path: the build smoke must never depend on the real
// per-user auth file (~/.pi/agent/auth.json); this fixture path does not
// exist and is only an overlap-check input.
const authPath = path.join(directory, "auth-not-backed-up.json");

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
    cwd: process.cwd(), env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath, PI_AUTH_PATH: authPath },
  });
  const packages = readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-"));
  if (create.status !== 0 || packages.length !== 1) throw new Error("compiled backup E2E did not publish a package");
  const targetRoot = path.join(directory, "restore-target");
  const restore = run(process.execPath, ["dist-backup/scripts/restore.js", "restore", "--input-backup", path.join(backupRoot, packages[0]), "--target-root", targetRoot, "--age-identity-file", identity], { cwd: process.cwd(), env: { ...process.env } });
  assertRestoreReport(targetRoot, restore);

  // Keep the safety-failure smoke separate from the successful E2E path.
  const failed = spawnSync(process.execPath, ["dist-backup/scripts/restore.js", "restore", "--input-backup", dataDir, "--target-root", path.join(directory, "bad-target"), "--age-identity-file", identity], { cwd: process.cwd(), env: { ...process.env }, encoding: "utf8" });
  if (failed.status === 0 || failed.stdout.includes(dataDir) || failed.stderr.includes(dataDir) || existsSync(path.join(directory, "bad-target"))) throw new Error("compiled restore safe-failure smoke failed");

  // Machine report contract (Phase 3 missing-as-empty): every published backup
  // emits exactly one stable machine report line; a missing session reference
  // does NOT fail — it publishes and reports the count.
  const publishArgs = ["dist-backup/scripts/backup.js", "create", "--backup-root", backupRoot, "--age-recipient-file", recipient];
  const published2 = spawnSync(process.execPath, publishArgs, { cwd: process.cwd(), env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath, PI_AUTH_PATH: authPath }, encoding: "utf8" });
  if (published2.status !== 0) throw new Error(`compiled backup E2E failed: ${published2.stderr}`);
  const reportLine = published2.stdout.split(/\r?\n/).find((line) => line.startsWith("backup-json-report: "));
  if (!reportLine) throw new Error("compiled backup did not emit the machine report line");
  const report = JSON.parse(reportLine.slice("backup-json-report: ".length));
  if (report.status !== "published" || report.dryRun !== false || report.missingSessionReferences !== 0 || report.strict !== undefined || !report.finalPath?.startsWith(backupRoot) || typeof report.payloadCount !== "number") throw new Error("compiled machine report is invalid");
  if (readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-")).length !== 2) throw new Error("compiled backup did not publish a second package");

  // Missing-as-empty：缺失引用照常发布，机器报告计数（绝不泄露引用/路径）。
  const missingDb = new DatabaseSync(dbPath);
  missingDb.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at,pi_session_file,capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("missing-session", "owner", "p", "missing", 1, 1, path.join(dataDir, "sessions", "gone", "history.jsonl"), JSON.stringify({ schema: 1 }));
  missingDb.close();
  const missingPublished = spawnSync(process.execPath, publishArgs, { cwd: process.cwd(), env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath, PI_AUTH_PATH: authPath }, encoding: "utf8" });
  if (missingPublished.status !== 0) throw new Error(`compiled backup did not publish with a missing reference: ${missingPublished.stderr}`);
  const missingLine = missingPublished.stdout.split(/\r?\n/).find((line) => line.startsWith("backup-json-report: "));
  if (!missingLine) throw new Error("compiled backup with a missing reference did not emit the machine report line");
  const missingReport = JSON.parse(missingLine.slice("backup-json-report: ".length));
  if (missingReport.status !== "published" || missingReport.dryRun !== false || missingReport.missingSessionReferences !== 1 || missingReport.strict !== undefined) throw new Error("compiled machine report did not count the missing reference as missing-as-empty");
  if (missingPublished.stdout.includes("missing-session") || missingPublished.stdout.includes(path.join("sessions", "gone"))) throw new Error("compiled backup leaked a reference/path on the missing path");
  if (readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-")).length !== 3) throw new Error("compiled backup with a missing reference did not publish a third package");
  console.log("compiled backup/restore E2E, safe-failure smoke and missing-as-empty machine smoke: ok");
} finally {
  rmSync(process.env.PI_BACKUP_STAGING_ROOT, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}
