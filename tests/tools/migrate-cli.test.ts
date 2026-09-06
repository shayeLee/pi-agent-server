import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCliMigrationHead, parseMode, readPostgresTarget, redactedMessage } from "../../scripts/migrate.js";
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

  it("requires an explicit confirmation for bootstrap-baseline and rejects backup mixing", () => {
    expect(() => parseMode(["--bootstrap-baseline"])).toThrow(/bootstrap-confirm/);
    expect(parseMode(["--bootstrap-baseline", "--bootstrap-confirm", "CONFIRMED"])).toBe("bootstrap-baseline");
    expect(() => parseMode(["--bootstrap-baseline", "--bootstrap-confirm", "not-confirmed"])).toThrow(/必须为 CONFIRMED/);
    expect(() => parseMode(["--bootstrap-baseline", "--bootstrap-confirm", "CONFIRMED", "--backup-root", "/tmp/b"])).toThrow(/不接受 backup/);
    expect(() => parseMode(["--bootstrap-baseline", "--bootstrap-confirm", "CONFIRMED", "--age-recipient-file", "/tmp/r"])).toThrow(/不接受 backup/);
    expect(() => parseMode(["--bootstrap-baseline", "--bootstrap-confirm", "CONFIRMED", "--maintenance-window", "CONFIRMED"])).toThrow(/不接受 backup/);
    expect(() => parseMode(["--apply", "--backup-root", "/tmp/b", "--age-recipient-file", "/tmp/r", "--maintenance-window", "CONFIRMED", "--bootstrap-confirm", "CONFIRMED"])).toThrow(/不接受 --bootstrap-confirm/);
  });

  it("dry-run and verify reject any apply/bootstrap parameter", () => {
    expect(() => parseMode(["--dry-run", "--backup-root", "/tmp/b"])).toThrow(/dry-run.*不接受|不接受.*dry-run/);
    expect(() => parseMode(["--verify", "--age-recipient-file", "/tmp/r"])).toThrow(/verify.*不接受|不接受.*verify/);
    expect(() => parseMode(["--verify", "--maintenance-window", "CONFIRMED"])).toThrow(/verify.*不接受|不接受.*verify/);
    expect(() => parseMode(["--dry-run", "--bootstrap-confirm", "CONFIRMED"])).toThrow(/不接受.*bootstrap-confirm|dry-run/);
    expect(() => parseMode(["--verify", "--backup-root", "/tmp/b", "--age-recipient-file", "/tmp/r", "--maintenance-window", "CONFIRMED"])).toThrow(/verify.*不接受|不接受.*verify/);
  });

  it("rejects duplicate flags regardless of mode", () => {
    expect(() => parseMode(["--apply", "--backup-root", "/tmp/a", "--backup-root", "/tmp/b", "--age-recipient-file", "/tmp/r", "--maintenance-window", "CONFIRMED"])).toThrow(/重复参数 --backup-root/);
    expect(() => parseMode(["--apply", "--backup-root", "/tmp/a", "--age-recipient-file", "/tmp/r", "--age-recipient-file", "/tmp/s", "--maintenance-window", "CONFIRMED"])).toThrow(/重复参数 --age-recipient-file/);
    expect(() => parseMode(["--apply", "--backup-root", "/tmp/a", "--age-recipient-file", "/tmp/r", "--maintenance-window", "CONFIRMED", "--maintenance-window=CONFIRMED"])).toThrow(/重复参数 --maintenance-window/);
    expect(() => parseMode(["--bootstrap-baseline", "--bootstrap-confirm", "CONFIRMED", "--bootstrap-confirm", "CONFIRMED"])).toThrow(/重复参数 --bootstrap-confirm/);
    expect(() => parseMode(["--bootstrap-baseline", "--bootstrap-confirm=CONFIRMED", "--bootstrap-confirm", "CONFIRMED"])).toThrow(/重复参数 --bootstrap-confirm/);
  });

  it("bootstraps an empty SQLite database through the CLI and refuses a non-empty one", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-migrate-cli-bootstrap-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "bootstrap.db");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const env = { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, PI_STORAGE_DIALECT: "sqlite", DB_PATH: dbPath };
    try {
      const ok = spawnSync("pnpm", ["exec", "tsx", "scripts/migrate.ts", "--", "--bootstrap-baseline", "--bootstrap-confirm", "CONFIRMED"], {
        cwd: process.cwd(), env, encoding: "utf8",
      });
      expect(ok.status, `${ok.stdout}${ok.stderr}`).toBe(0);
      const machine = JSON.parse(ok.stdout.trim().split(/\r?\n/).at(-1)!);
      expect(machine.status).toBe("success");
      expect(machine.mode).toBe("bootstrap-baseline");
      expect(machine.migration.status).toBe("applied");
      expect(machine.migration.appliedVersion).toBe(0);
      expect(machine.migration.pending).toBe(0);
      expect(machine.verify.status).toBe("verified");
      expect(machine.verify.pending).toBe(0);
      expect(machine.verify.appliedVersion).toBe(machine.migration.appliedVersion);
      const db = new DatabaseSync(dbPath);
      const ledger = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
      db.close();
      expect(JSON.stringify(ledger)).toBe(JSON.stringify([{ version: 0, name: "initial-schema" }]));

      // A second bootstrap on the now-initialized database must refuse: it is no longer empty.
      const again = spawnSync("pnpm", ["exec", "tsx", "scripts/migrate.ts", "--", "--bootstrap-baseline", "--bootstrap-confirm", "CONFIRMED"], {
        cwd: process.cwd(), env, encoding: "utf8",
      });
      expect(again.status).not.toBe(0);
      expect(`${again.stdout}${again.stderr}`).toMatch(/non-empty SQLite|refusing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses bootstrap on a SQLite database that already contains an arbitrary table", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-migrate-cli-bootstrap-user-table-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "user.db");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE arbitrary_user_table (id INTEGER PRIMARY KEY)");
      db.close();
      const result = spawnSync("pnpm", ["exec", "tsx", "scripts/migrate.ts", "--", "--bootstrap-baseline", "--bootstrap-confirm", "CONFIRMED"], {
        cwd: process.cwd(), env: { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, PI_STORAGE_DIALECT: "sqlite", DB_PATH: dbPath }, encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/non-empty SQLite|any table|refusing/);
      const check = new DatabaseSync(dbPath);
      const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      check.close();
      expect(tables.some((table) => table.name === "arbitrary_user_table")).toBe(true);
      expect(tables.some((table) => table.name === "schema_migrations")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an absolute target; dry-run/verify existing SQLite remain read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-migrate-cli-existing-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "target.db");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const env = { ...process.env, AGENT_CWD: process.cwd(), DATA_DIR: dataDir, PI_STORAGE_DIALECT: "sqlite", DB_PATH: dbPath };
    const bootstrap = spawnSync("pnpm", ["exec", "tsx", "scripts/migrate.ts", "--", "--bootstrap-baseline", "--bootstrap-confirm", "CONFIRMED"], {
      cwd: process.cwd(), env, encoding: "utf8",
    });
    expect(bootstrap.status, `${bootstrap.stdout}${bootstrap.stderr}`).toBe(0);
    try {
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
