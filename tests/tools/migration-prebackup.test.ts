import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWithPreMigrationBackup, parseMigrateArgs, type PreMigrationApplyOperations } from "../../scripts/migrate.js";
import { MIGRATION_PREBACKUP_URL_ENV, resolveMigrationPrebackupUrl } from "../../scripts/test-migration-prebackup.js";
import { StageTimeoutError, withStageTimeout } from "../../src/backup/stage-guard.js";
import { createPostgresBackup, type PgBackupClient, type PgProcessAdapter } from "../../src/backup/postgres-backup-core.js";
import type { MigrationRunResult } from "../../src/storage/migration-engine.js";
import type { PublishedBackupVerification } from "../../src/backup/backup-core.js";

const verified: PublishedBackupVerification = {
  id: "backup-test",
  kind: "pre-migration",
  checksum: "a".repeat(64),
  version: 0,
  sourceRoots: null,
  sqliteTarget: null,
  sqliteTreeBinding: null,
  postgres: null,
};
const run: MigrationRunResult = { mode: "apply", status: "applied", appliedVersion: 1, pending: [] };
const checked: MigrationRunResult = { mode: "verify", status: "verified", appliedVersion: 1, pending: [] };

function operations(events: string[], overrides: Partial<PreMigrationApplyOperations<object>> = {}): PreMigrationApplyOperations<object> {
  return {
    createBackup: async () => { events.push("backup"); return {}; },
    verifyBackup: () => { events.push("backup-verify"); return verified; },
    applyMigration: async () => { events.push("apply"); return run; },
    verifyMigration: async () => { events.push("verify"); return checked; },
    ...overrides,
  };
}

function pgFixture(): { root: string; dataDir: string; backupRoot: string; recipient: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-migration-prebackup-gate-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const recipient = join(root, "recipient");
  writeFileSync(recipient, "age1fakerecipient\n", { mode: 0o600 });
  chmodSync(recipient, 0o600);
  return { root, dataDir, backupRoot: join(root, "backups"), recipient };
}

/** Fake backup source client: an empty non-public app schema, so no session/ledger rows are needed. */
function pgSourceClient(): PgBackupClient {
  return {
    async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      if (text.includes("pg_export_snapshot")) return { rows: [{ snapshot: "0003A0-1" } as unknown as T] };
      if (text.includes("current_database()")) return { rows: [{ database: "private-db", schema: "app_schema", user: "u" } as unknown as T] };
      if (text.includes("pg_control_system")) return { rows: [{ system_identifier: "7234567890123456789" } as unknown as T] };
      if (text.includes("inet_server_addr")) return { rows: [{ database_oid: "16384", schema_oid: "16401", server_address: "192.0.2.10", server_port: "5432", cluster_name: "" } as unknown as T] };
      if (text === "SHOW server_version_num") return { rows: [{ server_version_num: "160004" } as unknown as T] };
      if (text.includes("information_schema.tables")) return { rows: [{ present: false } as unknown as T] };
      return { rows: [] as T[] };
    },
  };
}

describe("WP3C migration pre-backup stage safety", () => {
  it("bounds an abortable stage, invokes abort once, and returns the timeout ONLY after the confirmed settle (no URL)", async () => {
    const stages: string[] = [];
    let aborted = 0;
    let settledAt = 0;
    const budget = 120;
    const started = Date.now();
    const err = await withStageTimeout(
      "migration-apply",
      budget,
      () => new Promise<void>((resolve) => {
        // The aborted action settles a measurable time after the kill: the
        // gate must wait for that CONFIRMED settlement before returning.
        const wait = setInterval(() => {
          if (aborted > 0) {
            clearInterval(wait);
            setTimeout(() => { settledAt = Date.now(); resolve(); }, 250);
          }
        }, 5);
      }),
      { abort() { aborted++; } },
      (stage, state) => stages.push(`${stage}:${state}`),
    ).catch((e) => e);
    expect(settledAt).toBeGreaterThan(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(settledAt - started);
    expect(err).toBeInstanceOf(StageTimeoutError);
    expect((err as StageTimeoutError).stage).toBe("migration-apply");
    expect((err as StageTimeoutError).timeoutMs).toBe(budget);
    expect(aborted).toBe(1);
    expect(stages).toContain("migration-apply:start");
    expect(stages).toContain("migration-apply:timeout");
    expect(String(err)).not.toContain("postgres://");
  });

  it("does NOT return from a non-cancellable stage while the action still runs; the next stage stays blocked; late completion fails closed", async () => {
    const events: string[] = [];
    let finishApply: (result: MigrationRunResult) => void = () => {};
    const applyDone = new Promise<MigrationRunResult>((resolve) => { finishApply = resolve; });
    const gate = applyWithPreMigrationBackup({
      createBackup: async () => { events.push("backup"); return {}; },
      verifyBackup: () => { events.push("backup-verify"); return verified; },
      applyMigration: () => { events.push("apply"); return applyDone; },
      verifyMigration: async () => { events.push("verify"); return checked; },
    }, { stageTimeoutMs: { migrationApply: 100 } });
    const probe = gate.then(() => "settled" as const, () => "settled" as const);
    // Well past the budget: the timeout fired but the gate must still be
    // blocking — no CLI rejection, no later stage started.
    await new Promise((resolve) => setTimeout(resolve, 350));
    let settled = false;
    void probe.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(events).toEqual(["backup", "backup-verify", "apply"]);
    // The action really settles: only NOW does the caller hear the safe error
    // (the over-budget run still fails closed; the late value is discarded).
    finishApply(run);
    const err = await gate.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageTimeoutError);
    expect((err as StageTimeoutError).stage).toBe("migration-apply");
    expect(events).toEqual(["backup", "backup-verify", "apply"]);
  });

  it("propagates a non-cancellable stage's own late failure instead of masking it", async () => {
    const events: string[] = [];
    let failApply: (error: Error) => void = () => {};
    const applyDone = new Promise<MigrationRunResult>((_resolve, reject) => { failApply = reject; });
    const gate = applyWithPreMigrationBackup({
      createBackup: async () => { events.push("backup"); return {}; },
      verifyBackup: () => { events.push("backup-verify"); return verified; },
      applyMigration: () => { events.push("apply"); return applyDone; },
      verifyMigration: async () => { events.push("verify"); return checked; },
    }, { stageTimeoutMs: { migrationApply: 100 } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    failApply(new Error("migration failed late"));
    await expect(gate).rejects.toThrow("migration failed late");
    expect(events).toEqual(["backup", "backup-verify", "apply"]);
  });

  it("aborts a hung pg_dump at the labeled stage, cleans up, and never publishes", async () => {
    const f = pgFixture();
    const aborts: string[] = [];
    const stages: string[] = [];
    const url = "postgres://secret-user:secret-password@example.test:5432/private-db";
    const adapter: PgProcessAdapter = {
      async run(request) {
        if (request.args[0] === "--version") {
          return { code: 0, stdout: Buffer.from(`${request.command} (PostgreSQL) 16.4\n`), stderr: Buffer.alloc(0) };
        }
        // The dump never settles on its own; the stage abort kills it and the
        // killed child settles shortly after (confirmed settle before the
        // timeout is returned).
        return new Promise((resolve) => {
          const wait = setInterval(() => {
            if (aborts.length > 0) {
              clearInterval(wait);
              setTimeout(() => resolve({ code: null, signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }), 200);
            }
          }, 5);
        });
      },
      abort() { aborts.push("abort"); },
    };
    const err = await createPostgresBackup({
      storageDialect: "postgres",
      databaseUrl: url,
      paths: { dataDir: f.dataDir, backupRoot: f.backupRoot, ageRecipientFile: f.recipient },
      age: { encrypt: () => Buffer.from("never-called") },
      pgClient: pgSourceClient(),
      pgProcess: adapter,
      stageTimeoutMs: { pgDump: 120 },
      onStage: (stage, state) => stages.push(`${stage}:${state}`),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(StageTimeoutError);
    expect((err as StageTimeoutError).stage).toBe("pg-dump");
    expect(aborts.length).toBeGreaterThan(0);
    expect(stages).toContain("pg-dump:start");
    // The backup core cleaned its staging/temp and never published a package.
    expect(existsSync(f.backupRoot) && readdirSync(f.backupRoot).some((name) => name === "COMPLETE" || name.includes("staging"))).toBe(false);
    // The timeout diagnostic is safe and never leaks the URL or its credentials.
    const message = String(err);
    expect(message).not.toContain(url);
    expect(message).not.toContain("secret-user");
    expect(message).not.toContain("secret-password");
  });
});

describe("WP3C migration pre-backup ordering", () => {
  it("fails closed for missing apply gates and missing real-PG URL", () => {
    expect(() => parseMigrateArgs(["--apply"])).toThrow(/backup-root/);
    expect(() => parseMigrateArgs(["--apply", "--backup-root", "/tmp/b", "--age-recipient-file", "/tmp/r"])).toThrow(/maintenance-window/);
    expect(resolveMigrationPrebackupUrl(undefined).reason).toContain(MIGRATION_PREBACKUP_URL_ENV);
    expect(resolveMigrationPrebackupUrl(" \n").ok).toBe(false);
  });

  it("runs verified pre-migration backup before apply and head verify", async () => {
    const events: string[] = [];
    const result = await applyWithPreMigrationBackup(operations(events));
    expect(events).toEqual(["backup", "backup-verify", "apply", "verify"]);
    expect(result.backup).toEqual(verified);
    expect(result.verification.status).toBe("verified");
  });

  it("does not call migration when backup creation or verification fails", async () => {
    const first: string[] = [];
    await expect(applyWithPreMigrationBackup(operations(first, {
      createBackup: async () => { first.push("backup"); throw new Error("backup failed"); },
    }))).rejects.toThrow("backup failed");
    expect(first).toEqual(["backup"]);

    const second: string[] = [];
    await expect(applyWithPreMigrationBackup(operations(second, {
      verifyBackup: () => { second.push("backup-verify"); throw new Error("integrity failed"); },
    }))).rejects.toThrow("integrity failed");
    expect(second).toEqual(["backup", "backup-verify"]);
  });

  it("does not restore or down-migrate after migration failure", async () => {
    const events: string[] = [];
    await expect(applyWithPreMigrationBackup(operations(events, {
      applyMigration: async () => { events.push("apply"); throw new Error("migration failed"); },
    }))).rejects.toThrow("migration failed");
    expect(events).toEqual(["backup", "backup-verify", "apply"]);
  });

  it("rejects an apply result that reports a pending migration or wrong status", async () => {
    for (const bad of [
      { ...run, pending: [{ version: 2, name: "pending", checksum: "a".repeat(64), applied: false }] },
      { ...run, status: "planned" as const },
      { ...run, mode: "dry-run" as const },
    ]) {
      const events: string[] = [];
      await expect(applyWithPreMigrationBackup(operations(events, { applyMigration: async () => bad }))).rejects.toThrow(/did not reach the migration head/);
      expect(events).toEqual(["backup", "backup-verify"]);
    }
  });

  it("rejects a post-verify pending/status/version mismatch", async () => {
    const cases = [
      { ...checked, pending: [{ version: 2, name: "pending", checksum: "a".repeat(64), applied: false }] },
      { ...checked, status: "planned" as const },
      { ...checked, mode: "dry-run" as const },
      { ...checked, appliedVersion: 0 },
    ];
    for (const bad of cases) {
      const events: string[] = [];
      await expect(applyWithPreMigrationBackup(operations(events, { verifyMigration: async () => { events.push("verify"); return bad; } }))).rejects.toThrow(/post-migration verification/);
      expect(events).toEqual(["backup", "backup-verify", "apply", "verify"]);
    }
  });
});
