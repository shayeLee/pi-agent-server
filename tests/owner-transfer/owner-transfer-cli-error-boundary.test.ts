// WP5D-4 CLI 统一错误边界（reviewer 修复）：
// - 稳定错误码类别：code=usage（退出码 2，参数用法文本不含输入值）/ code=connection /
//   code=internal（退出码 1）；底层连接/query 原文、IPv4/IPv6/hostname/path/url/凭证
//   一律不得透传；
// - 单元层直接验证 render/sanitize 管线；进程层以真实 CLI（tsx）验证 ECONNREFUSED
//   （IPv4 与 IPv6 环回、DNS NXDOMAIN hostname）与参数用法错误的输出边界。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBinPath } from "../../scripts/test-postgres.js";
import { renderOwnerTransferCliError, sanitizeOwnerTransferDiagnostic } from "../../scripts/owner-transfer.js";

const ownerTransferEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "owner-transfer.ts");

const cleanups: string[] = [];
afterEach(() => { for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { root: string; cwd: string; dataDir: string; backupRoot: string; recipient: string } {
  const root = mkdtempSync(path.join(tmpdir(), "pi-owner-transfer-err-"));
  cleanups.push(root);
  const cwd = path.join(root, "app-cwd");
  const dataDir = path.join(root, "data");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const recipient = path.join(root, "recipient.txt");
  writeFileSync(recipient, "age1testrecipientpublickey\n", { mode: 0o600 });
  return { root, cwd, dataDir, backupRoot: path.join(root, "backups"), recipient };
}

function runCli(args: readonly string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [resolveBinPath("tsx", "tsx"), ownerTransferEntry, ...args], {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 90_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const PG_CLI_ARGS = [
  "--apply", "--source-ip", "10.1.2.3", "--target-ip", "10.1.2.4",
  "--confirm-transfer", "TRANSFER_IP_OWNERSHIP", "--maintenance-window", "CONFIRMED",
  "--backup-root", "PLACEHOLDER_BACKUP_ROOT", "--age-recipient-file", "PLACEHOLDER_RECIPIENT",
  "--target-schema", "otcli",
];

describe("owner-transfer CLI error boundary (unit)", () => {
  it("classifies network failures into the stable connection category without leaking targets", () => {
    for (const raw of [
      "connect ECONNREFUSED 127.0.0.1:5432",
      "connect ECONNREFUSED [::1]:5432",
      "connect ECONNREFUSED ::1:5432",
      "getaddrinfo ENOTFOUND db.internal.example",
      "connect ETIMEDOUT 10.0.0.7:5432",
      "could not connect to server: Connection refused",
      "socket hang up",
    ]) {
      const rendered = renderOwnerTransferCliError(new Error(raw));
      expect(rendered.code, raw).toBe("connection");
      expect(rendered.exitCode).toBe(1);
      expect(rendered.message).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(rendered.message).not.toMatch(/[0-9a-fA-F:]{2,}:/);
      expect(rendered.message).not.toMatch(/[a-z0-9-]+\.[a-z]{2,}/i);
    }
  });

  it("keeps safe internal fail-closed messages and strips anything with IP/path/url/query content", () => {
    const kept = renderOwnerTransferCliError(new Error("owner-transfer: the target owner already holds 1 project(s) and 2 session(s); merge is not supported"));
    expect(kept.code).toBe("internal");
    expect(kept.message).toContain("merge is not supported");
    const verifyKept = renderOwnerTransferCliError(new Error("owner-transfer: post-transfer verification failed: the source owner still holds resources; rolling back"));
    expect(verifyKept.message).toContain("the source owner still holds resources; rolling back");
    // Raw pg/client text is never passed through.
    const withSecrets = renderOwnerTransferCliError(new Error("connect ECONNREFUSED 192.168.1.9:5432 postgres://user:pass@192.168.1.9/db /private/tmp/secret/path.sql"));
    expect(withSecrets.code).toBe("connection");
    for (const needle of ["192.168.1.9", "postgres://", "/private/tmp/secret"]) expect(withSecrets.message).not.toContain(needle);
    // A raw query / statement echo becomes a stable generic message.
    const queryEcho = renderOwnerTransferCliError(new Error("ERROR: cannot execute UPDATE in a read-only transaction"));
    expect(queryEcho.message).toBe("a database operation failed; details withheld");
    const randomFsError = renderOwnerTransferCliError(new Error(`ENOENT: no such file or directory, open '${path.join("/tmp", "u", "x", "db.sqlite")}'`));
    expect(randomFsError.message).toBe("the operation failed; details withheld");
  });

  it("classifies usage errors with exit code 2 and never echoes argument values", () => {
    const rendered = renderOwnerTransferCliError(new Error("用法：pnpm owner-transfer -- --dry-run|--apply --source-ip CANONICAL_IP；--confirm-transfer 必须为 TRANSFER_IP_OWNERSHIP"));
    expect(rendered.code).toBe("usage");
    expect(rendered.exitCode).toBe(2);
    expect(rendered.message).toContain("用法：");
  });

  it("sanitizer removes IPv4/IPv6/hostname literals from arbitrary text", () => {
    const sanitized = sanitizeOwnerTransferDiagnostic("failed for 10.0.0.5:5433, [2001:db8::1]:5432, ::1, host.example.com:5432 and /var/run/x.sock");
    for (const needle of ["10.0.0.5", "2001:db8", "::1", "host.example.com", "/var/run/x.sock"]) expect(sanitized).not.toContain(needle);
  });
});

describe("owner-transfer CLI error boundary (spawned CLI)", () => {
  it("reports a stable connection error for ECONNREFUSED over IPv4 without leaking the IP/URL/paths", () => {
    const f = fixture();
    const args = PG_CLI_ARGS.map((arg) => arg === "PLACEHOLDER_BACKUP_ROOT" ? f.backupRoot : arg === "PLACEHOLDER_RECIPIENT" ? f.recipient : arg);
    const run = runCli(args, {
      AGENT_CWD: f.cwd, DATA_DIR: f.dataDir, PI_STORAGE_DIALECT: "postgres",
      PI_DATABASE_URL: "postgres://user:secret@127.0.0.1:1/connect_test",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("code=connection");
    for (const needle of ["127.0.0.1", "postgres://", "user:secret", "ECONNREFUSED", f.root, "connect_test"]) expect(run.stderr).not.toContain(needle);
    // Stage telemetry may appear on stdout, but never any sensitive value.
    for (const needle of ["127.0.0.1", "postgres://", "user:secret", f.root, "connect_test"]) expect(run.stdout).not.toContain(needle);
  });

  it("reports a stable connection error for ECONNREFUSED over IPv6 without leaking the address", () => {
    const f = fixture();
    const args = PG_CLI_ARGS.map((arg) => arg === "PLACEHOLDER_BACKUP_ROOT" ? f.backupRoot : arg === "PLACEHOLDER_RECIPIENT" ? f.recipient : arg);
    const run = runCli(args, {
      AGENT_CWD: f.cwd, DATA_DIR: f.dataDir, PI_STORAGE_DIALECT: "postgres",
      PI_DATABASE_URL: "postgres://user:secret@[::1]:1/connect_test_v6",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("code=connection");
    for (const needle of ["::1", "[::1]", "postgres://", f.root]) expect(run.stderr).not.toContain(needle);
  });

  it("reports a stable connection error for a DNS NXDOMAIN hostname without leaking it", () => {
    const f = fixture();
    const args = PG_CLI_ARGS.map((arg) => arg === "PLACEHOLDER_BACKUP_ROOT" ? f.backupRoot : arg === "PLACEHOLDER_RECIPIENT" ? f.recipient : arg);
    const run = runCli(args, {
      AGENT_CWD: f.cwd, DATA_DIR: f.dataDir, PI_STORAGE_DIALECT: "postgres",
      PI_DATABASE_URL: "postgres://user:secret@owner-transfer-nonexistent.invalid:5432/connect_test_dns",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("code=connection");
    for (const needle of ["owner-transfer-nonexistent.invalid", "postgres://", f.root]) expect(run.stderr).not.toContain(needle);
  });

  it("exits 2 for usage errors and never echoes the rejected input value", () => {
    const f = fixture();
    const secret = "SUPERSECRET_TOKEN_VALUE";
    const args = PG_CLI_ARGS.map((arg) => arg === "PLACEHOLDER_BACKUP_ROOT" ? f.backupRoot : arg === "PLACEHOLDER_RECIPIENT" ? f.recipient : arg)
      .map((arg) => arg === "TRANSFER_IP_OWNERSHIP" ? secret : arg);
    const run = runCli(args, { AGENT_CWD: f.cwd, DATA_DIR: f.dataDir });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("code=usage");
    expect(run.stderr).toContain("用法：");
    expect(run.stderr).not.toContain(secret);
  });
});