import { describe, expect, it, afterAll } from "vitest";
import { Pool } from "pg";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPostgresKysely, createPostgresPool } from "../../src/storage/postgres-bootstrap.js";
import { createPostgresBackup, verifyPublishedBackup } from "../../src/backup/backup-core.js";
import { runPostgresMigrations } from "../../src/storage/migration-engine.js";
import { migrationDefinitions } from "../../src/storage/migration-manifest.js";
import { applyWithPreMigrationBackup } from "../../scripts/migrate.js";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";
import { checkPgBackupBinaries } from "../../scripts/test-pg-backup.js";

const baseUrl = process.env.PI_TEST_PG_URL?.trim();
const binaryGate = checkPgBackupBinaries();
assertRequiredPgTestEnvironment("tests/postgres/migration-prebackup", baseUrl, true);
const describeGate = Boolean(baseUrl) && binaryGate.ok ? describe : describe.skip;
const cleanup: string[] = [];
let admin: Pool | undefined;

function ident(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedUrl(url: string, schema: string): string {
  const parsed = new URL(url);
  // Bounded statement_timeout so a blocked query (e.g. a stale advisory lock)
  // self-terminates instead of hanging the gate until the opaque test timeout.
  parsed.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=20000`);
  return parsed.toString();
}

describeGate("WP3C real PostgreSQL pre-migration backup gate", () => {
  let schema: string;
  let scoped: string;

  afterAll(async () => {
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
    for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("publishes COMPLETE pre-migration backup before apply and verify in a random schema", async () => {
    schema = `pi_w3c_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    admin = new Pool({ connectionString: baseUrl! });
    await admin.query(`CREATE SCHEMA ${ident(schema)}`);
    scoped = scopedUrl(baseUrl!, schema);
    const pool = createPostgresPool(scoped, { connectionTimeoutMillis: 5_000 });
    const kysely = createPostgresKysely(pool);
    const root = mkdtempSync(path.join(tmpdir(), "pi-w3c-pg-prebackup-"));
    cleanup.push(root);
    const dataDir = path.join(root, "data");
    const backupRoot = path.join(root, "backups");
    const recipient = path.join(root, "recipient");
    const identity = path.join(root, "identity");
    mkdirSync(path.join(dataDir, "sessions", "s1"), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dataDir, ".pi-agent"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dataDir, "sessions", "s1", "history.jsonl"), '{"type":"session","id":"gate"}\n', { mode: 0o600 });
    const generated = spawnSync("age-keygen", ["--output", identity], { encoding: "utf8" });
    expect(generated.status).toBe(0);
    const publicKey = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8" }).stdout.trim();
    expect(publicKey).toMatch(/^age1[0-9a-z]+$/);
    writeFileSync(recipient, `${publicKey}\n`, { mode: 0o600 });
    chmodSync(recipient, 0o600);

    try {
      // The schema is intentionally untouched here: the prebackup must see
      // the never-migrated state, not a test setup no-op.
      const order: string[] = [];
      const result = await applyWithPreMigrationBackup({
        createBackup: async () => {
          order.push("backup");
          return createPostgresBackup({
            storageDialect: "postgres", databaseUrl: scoped,
            paths: { dataDir, backupRoot, ageRecipientFile: recipient },
            backupKind: "pre-migration",
          });
        },
        verifyBackup: (backup) => {
          order.push("backup-verify");
          return verifyPublishedBackup(backup);
        },
        applyMigration: async () => {
          order.push("migration-apply");
          return runPostgresMigrations(kysely, { mode: "apply" });
        },
        verifyMigration: async () => {
          order.push("migration-verify");
          return runPostgresMigrations(kysely, { mode: "verify" });
        },
      });
      expect(order).toEqual(["backup", "backup-verify", "migration-apply", "migration-verify"]);
      expect(result.backup.kind).toBe("pre-migration");
      expect(result.verification.status).toBe("verified");
      expect(result.backup.checksum).toMatch(/^[0-9a-f]{64}$/);
      const packagePath = path.join(backupRoot, result.backup.id);
      expect(existsSync(path.join(packagePath, "COMPLETE"))).toBe(true);
      const manifest = spawnSync("age", ["--decrypt", "--identity", identity, path.join(packagePath, "manifest.json.age")], { encoding: "utf8" });
      expect(manifest.status).toBe(0);
      const metadata = JSON.parse(manifest.stdout);
      expect(metadata.kind).toBe("pre-migration");
      expect(metadata.migrationLedger.present).toBe(false);
      expect(metadata.migrationLedger.appliedVersion).toBeNull();
      expect(metadata.migrationLedger.pending).toBe(0);
      const ledger = await pool.query(`SELECT version, name FROM ${ident(schema)}.schema_migrations ORDER BY version`);
      expect(ledger.rows).toEqual(migrationDefinitions.map(({ version, name }) => ({ version, name })));
      expect(result.verification.mode).toBe("verify");
      expect(result.verification.status).toBe("verified");
      expect(result.verification.pending).toHaveLength(0);
      expect(result.verification.appliedVersion).toBe(migrationDefinitions.at(-1)!.version);
      expect(readFileSync(path.join(packagePath, "COMPLETE"), "utf8").trim()).toBe(createHash("sha256").update(readFileSync(path.join(packagePath, "manifest.json.age"))).digest("hex"));
      expect(readdirSync(backupRoot)).toEqual([result.backup.id]);
    } finally {
      await kysely.destroy();
    }
  }, 150_000); // real PG gate worst-case bound (stage budgets sum ≈ backup 90s + apply/verify 40s); standalone it completes in well under a second
});
