import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCliMigrationHead, parseMode, readPostgresTarget, redactedMessage } from "../../scripts/migrate.js";
import { runSqliteMigrations } from "../../src/storage/migration-engine.js";
import { resolveMigrationCliPaths, summarizePostgresTarget } from "../../src/storage/storage-config.js";

describe("offline migration CLI", () => {
  it("requires an explicit absolute AGENT_CWD and rejects relative path combinations", () => {
    expect(() => resolveMigrationCliPaths({ DB_PATH: "relative.db" }, process.cwd())).toThrow(/absolute AGENT_CWD/);
    expect(() => resolveMigrationCliPaths({ AGENT_CWD: "/workspace", DB_PATH: "relative.db" }, process.cwd())).toThrow(/relative DB_PATH/);
    expect(resolveMigrationCliPaths({ AGENT_CWD: "/workspace", DATA_DIR: "/data", DB_PATH: "/db/target.sqlite" }, "/other")).toEqual({ cwd: "/workspace", dataDir: "/data", dbPath: "/db/target.sqlite" });
  });
  it("CLI head guard rejects a behind-head verify result without printing verified", () => {
    expect(() => assertCliMigrationHead({ mode: "verify", status: "verified", appliedVersion: 0, pending: [{ version: 1, name: "test-future", checksum: "a".repeat(64), applied: false }] }, 1)).toThrow(/canonical migration head|pending/);
    expect(() => assertCliMigrationHead({ mode: "verify", status: "verified", appliedVersion: 0, pending: [] }, 1)).toThrow(/canonical migration head/);
    expect(() => assertCliMigrationHead({ mode: "verify", status: "verified", appliedVersion: 1, pending: [] }, 1)).not.toThrow();
  });

  it("rejects missing or multiple mode arguments and requires apply gates", () => {
    expect(() => parseMode([])).toThrow(/用法/);
    expect(() => parseMode(["--apply", "--verify"])).toThrow(/用法/);
    expect(parseMode(["--", "--dry-run"])).toBe("dry-run");
    expect(() => parseMode(["--apply"])).toThrow(/backup-root/);
    expect(() => parseMode(["--apply", "--backup-root", "/tmp/b", "--age-recipient-file", "/tmp/r"])).toThrow(/maintenance-window/);
  });

  it("rejects an invalid mode in the executable", () => {
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/migrate.ts", "--", "--invalid"], {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("用法");
  });

  it("does not echo unknown arguments or common age/token credentials", () => {
    const unknown = "--token=do-not-echo-this-value";
    let parseError: unknown;
    try { parseMode(["--verify", unknown]); } catch (error) { parseError = error; }
    expect(parseError).toBeInstanceOf(Error);
    expect((parseError as Error).message).toMatch(/未知参数/);
    expect((parseError as Error).message).not.toContain(unknown);
    const ageSecret = "AGE-SECRET-KEY-1ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const bearer = "eyJhbGciOiJIUzI1NiJ9.secret-payload.signature";
    const message = redactedMessage(new Error(`${ageSecret} token=token-secret Authorization: Bearer bearer-secret --api-key=api-secret ${bearer}`), undefined);
    for (const secret of [ageSecret, "token-secret", "bearer-secret", "api-secret", bearer]) expect(message).not.toContain(secret);
    expect(message).toContain("[redacted age identity]");
    expect(message).toContain("[redacted token]");
  });

  it("dry-run and verify fail without creating a missing SQLite database", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-migrate-cli-"));
    const dbPath = join(dir, "not-created.db");
    try {
      const result = spawnSync("pnpm", ["exec", "tsx", "scripts/migrate.ts", "--", "--dry-run"], {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_CWD: process.cwd(), PI_STORAGE_DIALECT: "sqlite", DB_PATH: dbPath },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/does not exist|dry-run failed/);
      expect(existsSync(dbPath)).toBe(false);

      const verify = spawnSync("pnpm", ["exec", "tsx", "scripts/migrate.ts", "--", "--verify"], {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_CWD: process.cwd(), PI_STORAGE_DIALECT: "sqlite", DB_PATH: dbPath },
        encoding: "utf8",
      });
      expect(verify.status).not.toBe(0);
      expect(`${verify.stdout}${verify.stderr}`).toMatch(/does not exist|verify failed/);
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never includes PostgreSQL credentials in its safe target summary", () => {
    const summary = summarizePostgresTarget("postgres://secret-user:secret-password@example.test:5432/private-db?sslmode=require");
    expect(summary).toContain("example.test:5432/private-db");
    expect(summary).not.toContain("secret-user");
    expect(summary).not.toContain("secret-password");
    expect(summary).not.toContain("postgres://");
  });

  it("queries the effective PostgreSQL database and schema after connecting", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ database: "actual_db", schema: "tenant_a" }] });
    await expect(readPostgresTarget({ query } as never)).resolves.toEqual({ database: "actual_db", schema: "tenant_a" });
    expect(query).toHaveBeenCalledWith("SELECT current_database() AS database, current_schema() AS schema");
  });

  it("redacts URL credentials and PostgreSQL login names on CLI error paths", () => {
    const url = "postgres://secret-user:secret-password@example.test:5432/private-db?sslmode=require";
    const message = redactedMessage(new Error(`password authentication failed for user \"secret-user\" (${url}); password=secret-password`), url);
    expect(message).not.toContain("secret-user");
    expect(message).not.toContain("secret-password");
    expect(message).not.toContain(url);
    expect(message).toContain("[redacted user]");
    expect(message).toContain("[redacted password]");
  });

  it("does not claim a PostgreSQL target when the connection fails", () => {
    const url = "postgres://secret-user:secret-password@127.0.0.1:1/private-db?connect_timeout=1";
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/migrate.ts", "--", "--verify"], {
      cwd: process.cwd(),
      env: { ...process.env, PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: url },
      encoding: "utf8",
      timeout: 10_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).not.toContain("migration target:");
    expect(output).not.toContain("secret-user");
    expect(output).not.toContain("secret-password");
    expect(output).not.toContain(url);
  });

  it("reports an absolute target; dry-run/verify existing SQLite remain read-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-migrate-cli-existing-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "target.db");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const initialized = new DatabaseSync(dbPath);
    await runSqliteMigrations(initialized, { mode: "apply" });
    initialized.close();
    try {
      const env = { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, PI_STORAGE_DIALECT: "sqlite", DB_PATH: dbPath };
      const before = readFileSync(dbPath);
      const dry = spawnSync("pnpm", ["exec", "tsx", "scripts/migrate.ts", "--", "--dry-run"], {
        cwd: process.cwd(), env, encoding: "utf8",
      });
      expect(dry.status, `${dry.stdout}${dry.stderr}`).toBe(0);
      expect(dry.stdout).toContain("read-only inspection; no writes");
      expect(readFileSync(dbPath)).toEqual(before);
      const verify = spawnSync("pnpm", ["exec", "tsx", "scripts/migrate.ts", "--", "--verify"], {
        cwd: process.cwd(), env, encoding: "utf8",
      });
      expect(verify.status, `${verify.stdout}${verify.stderr}`).toBe(0);
      expect(readFileSync(dbPath)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
