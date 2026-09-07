import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkDistHygiene } from "./dist-hygiene.mjs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (packageJson.bin?.["pi-agent-server-backup"] !== "./dist-backup/scripts/backup.js" || packageJson.bin?.["pi-agent-server-restore"] !== "./dist-backup/scripts/restore.js" || !packageJson.files?.includes("dist-backup") || !existsSync("dist-backup/scripts/backup.js") || !existsSync("dist-backup/scripts/restore.js")) {
  throw new Error("compiled backup/restore package bin is missing or points outside dist-backup");
}
const directory = mkdtempSync(path.join(tmpdir(), "pi-backup-package-smoke-"));
// Hermetic plaintext staging root: the build smoke must never depend on the
// real per-user config staging root (the compiled CLIs honor this variable).
process.env.PI_BACKUP_STAGING_ROOT = mkdtempSync(path.join(tmpdir(), "pi-smoke-staging-"));
const cache = path.join(directory, "npm-cache");
const packageDir = path.join(directory, "package");
const installDir = path.join(directory, "install");
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

function npm(args) {
  return run("npm", ["--no-audit", "--no-fund", ...args], {
    env: { ...process.env, npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
  });
}

async function createFixture(runSqliteMigrations) {
  mkdirSync(path.join(dataDir, "projects", "p", "sessions", "s"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
  const sessionFile = path.join(dataDir, "projects", "p", "sessions", "s", "history.jsonl");
  writeFileSync(sessionFile, '{"type":"session","version":3,"id":"header","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/smoke"}\n{"type":"message","id":"entry","parentId":null,"timestamp":"2024-01-01T00:00:00.000Z","message":{"role":"user","content":"smoke","timestamp":1}}\n', { mode: 0o600 });
  const db = new DatabaseSync(dbPath);
  await runSqliteMigrations(db, { mode: "apply" });
  db.prepare("INSERT INTO projects (id,name,cwd,owner_key,created_at) VALUES (?,?,?,?,?)").run("p", "smoke", "/smoke", "owner", 1);
  db.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at,conversation_ref,capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("s", "owner", "p", "smoke", 1, 1, sessionFile, JSON.stringify({ schema: 1 }));
  db.close();
}

function createAgeKey() {
  run("age-keygen", ["--output", identity], { stdio: "ignore" });
  const extracted = run("age-keygen", ["-y", identity]);
  const publicRecipient = extracted.stdout.trim();
  if (!/^age1[0-9a-z]+$/.test(publicRecipient)) throw new Error("age recipient extraction failed");
  writeFileSync(recipient, `${publicRecipient}\n`, { mode: 0o600 });
}

function verifyRestore(bin, packagePath) {
  const targetRoot = path.join(directory, "restore-target");
  const result = run(bin, ["restore", "--input-backup", packagePath, "--target-root", targetRoot, "--age-identity-file", identity], { env: { ...process.env } });
  const report = JSON.parse(result.stdout.trim());
  if (report.status !== "success" || report.dryRun !== false || report.counts.sessions !== 1 || report.counts.jsonlFiles !== 1) throw new Error("installed restore safety report is incomplete");
  const published = readdirSync(targetRoot).find((entry) => entry.startsWith("restore-"));
  if (!published) throw new Error("installed restore did not publish a drill directory");
  const finalPath = path.join(targetRoot, published);
  const db = new DatabaseSync(path.join(finalPath, "pi-agent-server.db"), { readOnly: true });
  const row = db.prepare("SELECT conversation_ref FROM sessions WHERE id = 's'").get();
  db.close();
  const expected = path.join(finalPath, "projects/p/sessions/s/history.jsonl");
  if (!row || realpathSync(row.conversation_ref) !== realpathSync(expected) || row.conversation_ref.includes(path.join(dataDir, "sessions")) || !readFileSync(expected, "utf8").includes('"type":"session"')) throw new Error("installed restore data/remap verification failed");
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
  const backupBin = path.join(installDir, "node_modules", ".bin", "pi-agent-server-backup");
  const restoreBin = path.join(installDir, "node_modules", ".bin", "pi-agent-server-restore");
  if (!existsSync(backupBin) || !existsSync(restoreBin)) throw new Error("installed backup/restore bins are missing");
  const { runSqliteMigrations } = await import(pathToFileURL(path.join(packageRoot, "dist-backup/src/storage/migration-engine.js")));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  createAgeKey();
  await createFixture(runSqliteMigrations);
  run(backupBin, ["create", "--backup-root", backupRoot, "--age-recipient-file", recipient], {
    cwd: process.cwd(), env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath, PI_AUTH_PATH: authPath },
  });
  const packages = existsSync(backupRoot) ? readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-")) : [];
  if (packages.length !== 1) throw new Error("installed backup bin did not publish a package");
  verifyRestore(restoreBin, path.join(backupRoot, packages[0]));

  // Machine report contract (Phase 3 missing-as-empty) through the installed
  // npm bin: every published backup emits exactly one machine report line; a
  // missing session reference publishes and reports the count (never fails).
  const publishArgs = ["create", "--backup-root", backupRoot, "--age-recipient-file", recipient];
  const published2 = spawnSync(backupBin, publishArgs, { cwd: process.cwd(), env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath, PI_AUTH_PATH: authPath }, encoding: "utf8" });
  if (published2.status !== 0) throw new Error(`installed backup E2E failed: ${published2.stderr}`);
  const reportLine = published2.stdout.split(/\r?\n/).find((line) => line.startsWith("backup-json-report: "));
  if (!reportLine) throw new Error("installed backup did not emit the machine report line");
  const report = JSON.parse(reportLine.slice("backup-json-report: ".length));
  if (report.status !== "published" || report.dryRun !== false || report.missingSessionReferences !== 0 || report.strict !== undefined || !report.finalPath?.startsWith(backupRoot) || typeof report.payloadCount !== "number") throw new Error("installed machine report is invalid");
  if (readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-")).length !== 2) throw new Error("installed backup did not publish a second package");

  // Missing-as-empty：缺失引用照常发布，机器报告计数。
  const missingDb = new DatabaseSync(dbPath);
  missingDb.prepare("INSERT INTO sessions (id,owner_key,project_id,title,created_at,updated_at,conversation_ref,capability_versions) VALUES (?,?,?,?,?,?,?,?)").run("missing-session", "owner", "p", "missing", 1, 1, path.join(dataDir, "projects", "p", "sessions", "missing-session", "history.jsonl"), JSON.stringify({ schema: 1 }));
  missingDb.close();
  const missingPublished = spawnSync(backupBin, publishArgs, { cwd: process.cwd(), env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, DB_PATH: dbPath, PI_AUTH_PATH: authPath }, encoding: "utf8" });
  if (missingPublished.status !== 0) throw new Error(`installed backup did not publish with a missing reference: ${missingPublished.stderr}`);
  const missingLine = missingPublished.stdout.split(/\r?\n/).find((line) => line.startsWith("backup-json-report: "));
  if (!missingLine) throw new Error("installed backup with a missing reference did not emit the machine report line");
  const missingReport = JSON.parse(missingLine.slice("backup-json-report: ".length));
  if (missingReport.status !== "published" || missingReport.dryRun !== false || missingReport.missingSessionReferences !== 1 || missingReport.strict !== undefined) throw new Error("installed machine report did not count the missing reference as missing-as-empty");
  if ((missingPublished.stdout ?? "").includes("missing-session") || (missingPublished.stdout ?? "").includes(path.join("projects", "p", "sessions", "missing-session"))) throw new Error("installed backup leaked a reference/path on the missing path");
  if (readdirSync(backupRoot).filter((entry) => entry.startsWith("backup-")).length !== 3) throw new Error("installed backup with a missing reference did not publish a third package");

  // Keep the safety-failure smoke independent of the successful E2E path.
  const failed = spawnSync(restoreBin, ["restore", "--input-backup", dataDir, "--target-root", path.join(directory, "bad-target"), "--age-identity-file", identity], { cwd: process.cwd(), env: { ...process.env }, encoding: "utf8" });
  if (failed.status === 0 || failed.stdout.includes(dataDir) || failed.stderr.includes(dataDir) || existsSync(path.join(directory, "bad-target"))) throw new Error("installed restore safe-failure smoke failed");
  console.log("installed npm backup/restore E2E, safe-failure smoke and missing-as-empty machine smoke: ok");
} finally {
  rmSync(process.env.PI_BACKUP_STAGING_ROOT, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
}
