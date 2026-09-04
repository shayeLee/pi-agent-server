// Real PostgreSQL migration gate. Every test owns a random schema and never
// relies on file order; no public schema/database reset is performed.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import type { Kysely } from "kysely";
import { createPostgresKysely, createPostgresPool, initializePostgresDatabase } from "../../src/storage/postgres-bootstrap.js";
import { runPostgresMigrations, POSTGRES_MIGRATION_LOCK_KEY } from "../../src/storage/migration-engine.js";
import {
  migrationChecksum,
  migrationDefinitions,
  schemaManifestV0,
  SQLITE_PHYSICAL_TYPES,
  POSTGRES_PHYSICAL_TYPES,
} from "../../src/storage/migration-manifest.js";
import { DEFAULT_PROJECT_ID } from "../../src/application/ports/project-store-port.js";
import type { DatabaseSchema } from "../../src/storage/db-schema.js";
import { KyselyProjectRepository } from "../../src/storage/kysely-project-repository.js";
import { pgConstraintErrorMapper } from "../../src/storage/pg-constraint-errors.js";
import { assertRequiredPgTestEnvironment } from "../../scripts/pg-test-gate.js";

const pgUrl = process.env.PI_TEST_PG_URL?.trim();
assertRequiredPgTestEnvironment("tests/postgres/migration-engine", pgUrl, false);
const describePg = pgUrl ? describe : describe.skip;

function schemaName(): string {
  return `pi_migration_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

function withSchemaSearchPath(url: string, schema: string, timeoutMs?: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema}${timeoutMs ? ` -c statement_timeout=${timeoutMs}` : ""}`);
  return parsed.toString();
}

async function isolated<T>(action: (pool: Pool, kysely: Kysely<DatabaseSchema>, schema: string) => Promise<T>): Promise<T> {
  const schema = schemaName();
  const admin = new Pool({ connectionString: pgUrl! });
  const pool = createPostgresPool(withSchemaSearchPath(pgUrl!, schema));
  let kysely: Kysely<DatabaseSchema> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    kysely = createPostgresKysely(pool);
    return await action(pool, kysely, schema);
  } finally {
    if (kysely) await kysely.destroy().catch(() => undefined);
    await pool.end().catch(() => undefined);
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  }
}

const futureMigration = Object.freeze({
  version: 2,
  name: "test-future",
  manifest: schemaManifestV0,
  physicalTypeMaps: { SQLite: SQLITE_PHYSICAL_TYPES, PostgreSQL: POSTGRES_PHYSICAL_TYPES },
  operations: {
    SQLite: [{ kind: "ddl", dialect: "SQLite", sql: "CREATE TABLE test_future (id INTEGER)" }] as const,
    PostgreSQL: [{ kind: "ddl", dialect: "PostgreSQL", sql: "CREATE TABLE test_future (id BIGINT)" }] as const,
  },
  dataTransform: { kind: "none", format: "pi-agent-server.data-transform.v1" },
});

const futureFailure = Object.freeze({
  version: 2,
  name: "test-failure",
  manifest: schemaManifestV0,
  physicalTypeMaps: { SQLite: SQLITE_PHYSICAL_TYPES, PostgreSQL: POSTGRES_PHYSICAL_TYPES },
  operations: {
    SQLite: [{ kind: "ddl", dialect: "SQLite", sql: "SELECT 1" }] as const,
    PostgreSQL: [
      { kind: "ddl", dialect: "PostgreSQL", sql: "CREATE TABLE migration_failure_marker (id INTEGER PRIMARY KEY)" },
      { kind: "ddl", dialect: "PostgreSQL", sql: "THIS IS INVALID" },
    ] as const,
  },
  dataTransform: { kind: "none", format: "pi-agent-server.data-transform.v1" },
});

describePg("Manifest-driven migration engine (real PostgreSQL)", () => {
  it("applies the published path v0 → v1, preserving v0 data and its UUID default", async () => {
    await isolated(async (pool, kysely) => {
      const v0 = migrationDefinitions[0]!;
      const first = await runPostgresMigrations(kysely, { migrations: [v0] });
      expect(first.appliedVersion).toBe(v0.version);
      expect((await pool.query("SELECT version, name FROM schema_migrations ORDER BY version")).rows).toEqual([
        { version: v0.version, name: v0.name },
      ]);

      const v0Tables = [...v0.manifest.tables.map((table) => table.name), "schema_migrations"].sort();
      expect((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name")).rows.map((row) => row.table_name)).toEqual(v0Tables);

      const sessions = v0.manifest.tables.find((table) => table.name === "sessions")!;
      const projectIdColumn = sessions.columns.find((column) => column.name === "project_id")!;
      expect(projectIdColumn.default).toBe(DEFAULT_PROJECT_ID);
      const defaultColumn = await pool.query(
        "SELECT column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'sessions' AND column_name = 'project_id'",
      );
      expect(defaultColumn.rows[0]?.column_default).toContain(String(projectIdColumn.default));

      const keptProjectId = randomUUID();
      await pool.query(
        "INSERT INTO projects (id, name, cwd, owner_key, created_at) VALUES ($1, $2, $3, $4, $5)",
        [keptProjectId, "kept", "/kept", "owner", 1],
      );

      const second = await runPostgresMigrations(kysely);
      expect(second.appliedVersion).toBe(migrationDefinitions.at(-1)!.version);
      expect((await pool.query("SELECT version, name FROM schema_migrations ORDER BY version")).rows).toEqual(
        migrationDefinitions.map(({ version, name }) => ({ version, name })),
      );
      expect((await pool.query("SELECT id, name FROM projects WHERE id = $1", [keptProjectId])).rows).toEqual([
        { id: keptProjectId, name: "kept" },
      ]);
      const v1Tables = [...migrationDefinitions.at(-1)!.manifest.tables.map((table) => table.name), "schema_migrations"].sort();
      expect((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name")).rows.map((row) => row.table_name)).toEqual(v1Tables);
    });
  });

  it("empty bootstrap follows the v1 manifest, creates no migration ledger, and keeps the UUID default", async () => {
    await isolated(async (pool, kysely) => {
      void kysely;
      const initialized = await initializePostgresDatabase(pool);
      try {
        const expectedTables = migrationDefinitions.at(-1)!.manifest.tables.map((table) => table.name).sort();
        const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name");
        expect(tables.rows.map((row) => row.table_name)).toEqual(expectedTables);
        expect(tables.rows.map((row) => row.table_name)).not.toContain("schema_migrations");

        const sessions = migrationDefinitions[0]!.manifest.tables.find((table) => table.name === "sessions")!;
        const projectIdDefault = sessions.columns.find((column) => column.name === "project_id")!.default;
        const defaultColumn = await pool.query(
          "SELECT column_default, data_type, udt_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'sessions' AND column_name = 'project_id'",
        );
        expect(defaultColumn.rows[0]).toMatchObject({ data_type: "uuid", udt_name: "uuid" });
        expect(defaultColumn.rows[0]?.column_default).toContain(String(projectIdDefault));
      } finally {
        await initialized.destroy();
      }
    });
  });

  it("applies v0 and v1 on an empty random schema and is idempotent", async () => {
    await isolated(async (pool, kysely) => {
      const first = await runPostgresMigrations(kysely);
      expect(first.appliedVersion).toBe(1);
      expect((await pool.query("SELECT version, name, length(checksum) AS n, pg_typeof(applied_at)::text AS t FROM schema_migrations ORDER BY version")).rows).toEqual([
        { version: 0, name: "initial-schema", n: 64, t: "bigint" },
        { version: 1, name: "file-operations-outbox", n: 64, t: "bigint" },
      ]);
      expect((await runPostgresMigrations(kysely)).pending).toEqual([]);
    });
  });

  it("allows the declared name UNIQUE constraint and its backing index", async () => {
    await isolated(async (pool, kysely) => {
      await runPostgresMigrations(kysely);
      const objects = await pool.query<{ constraint_type: string; column_name: string; is_primary: boolean; is_unique: boolean }>(`
        SELECT con.contype AS constraint_type, a.attname AS column_name,
               ix.indisprimary AS is_primary, ix.indisunique AS is_unique
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        JOIN pg_index ix ON ix.indexrelid = con.conindid
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum
        WHERE ns.nspname = current_schema() AND rel.relname = 'schema_migrations'
        ORDER BY con.contype
      `);
      expect(objects.rows).toEqual([
        { constraint_type: "p", column_name: "version", is_primary: true, is_unique: true },
        { constraint_type: "u", column_name: "name", is_primary: false, is_unique: true },
      ]);
      await expect(runPostgresMigrations(kysely)).resolves.toMatchObject({ pending: [] });
    });
  });

  it("verify is fail-closed when a pending v1 leaves the database behind the registry head", async () => {
    await isolated(async (pool, kysely) => {
      await runPostgresMigrations(kysely);
      const before = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name")).rows;
      await expect(runPostgresMigrations(kysely, { mode: "verify", migrations: [...migrationDefinitions, futureMigration] })).rejects.toThrow(/canonical migration head|pending/);
      expect((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name")).rows).toEqual(before);
    });
  });

  it("rejects checksum tampering and physical drift without altering business data", async () => {
    await isolated(async (pool, kysely) => {
      await runPostgresMigrations(kysely);
      await pool.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 0");
      await expect(runPostgresMigrations(kysely)).rejects.toThrow(/checksum mismatch/);
      await pool.query("UPDATE schema_migrations SET checksum = $1 WHERE version = 0", [migrationChecksum(migrationDefinitions[0]!)]);
      await pool.query("DROP INDEX idx_projects_owner");
      await expect(runPostgresMigrations(kysely)).rejects.toThrow(/physical schema|不兼容/);
      expect((await pool.query("SELECT count(*)::int AS n FROM projects")).rows[0]?.n).toBe(0);
    });
  });

  it("rejects a managed table without a ledger without mutating it", async () => {
    await isolated(async (pool, kysely) => {
      await pool.query("CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, cwd TEXT NOT NULL, owner_key TEXT NOT NULL, created_at BIGINT NOT NULL)");
      await expect(runPostgresMigrations(kysely)).rejects.toThrow(/controlled reset\/adopt/);
      expect((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name")).rows).toEqual([{ table_name: "projects" }]);
    });
  });

  it("rejects empty/malformed/future PostgreSQL ledgers before any business DDL", async () => {
    const cases = [
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT UNIQUE NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT UNIQUE NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT UNIQUE NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL); INSERT INTO schema_migrations VALUES (0, 'initial-schema', '" + migrationChecksum(migrationDefinitions[0]!) + "', 1)",

      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL); INSERT INTO schema_migrations VALUES (2, 'initial-schema', '" + migrationChecksum(migrationDefinitions[0]!) + "', 1)",
    ];
    for (const ddl of cases) {
      await isolated(async (pool, kysely) => {
        await pool.query(ddl);
        await expect(runPostgresMigrations(kysely)).rejects.toThrow(/ledger|physical schema/);
        expect((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name <> 'schema_migrations'")).rows).toEqual([]);
      });
    }
  });

  it.each([
    {
      kind: "CHECK constraint",
      setup: async (pool: Pool) => {
        await pool.query("CREATE TABLE schema_migrations (version BIGINT PRIMARY KEY NOT NULL, name TEXT UNIQUE NOT NULL, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)");
        await pool.query("ALTER TABLE schema_migrations ADD CONSTRAINT ledger_check CHECK (version >= 0)");
      },
    },
    {
      kind: "extra UNIQUE constraint",
      setup: async (pool: Pool) => {
        await pool.query("CREATE TABLE schema_migrations (version BIGINT PRIMARY KEY NOT NULL, name TEXT UNIQUE NOT NULL, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)");
        await pool.query("ALTER TABLE schema_migrations ADD CONSTRAINT ledger_checksum_unique UNIQUE (checksum)");
      },
    },
    {
      kind: "extra index",
      setup: async (pool: Pool) => {
        await pool.query("CREATE TABLE schema_migrations (version BIGINT PRIMARY KEY NOT NULL, name TEXT UNIQUE NOT NULL, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)");
        await pool.query("CREATE INDEX ledger_extra_index ON schema_migrations(checksum)");
      },
    },
    {
      kind: "row-level security",
      setup: async (pool: Pool) => {
        await pool.query("CREATE TABLE schema_migrations (version BIGINT PRIMARY KEY NOT NULL, name TEXT UNIQUE NOT NULL, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)");
        await pool.query("ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY");
      },
    },
    {
      kind: "trigger",
      setup: async (pool: Pool) => {
        await pool.query("CREATE TABLE schema_migrations (version BIGINT PRIMARY KEY NOT NULL, name TEXT UNIQUE NOT NULL, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)");
        await pool.query("CREATE FUNCTION ledger_trigger_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
        await pool.query("CREATE TRIGGER ledger_extra_trigger AFTER INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION ledger_trigger_fn()");
      },
    },
  ])("rejects undeclared ledger $kind without business DDL", async ({ setup }) => {
    await isolated(async (pool, kysely) => {
      await setup(pool);
      await expect(runPostgresMigrations(kysely)).rejects.toThrow(/ledger/);
      expect((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name <> 'schema_migrations'")).rows).toEqual([]);
    });
  });

  it("rolls back failed DDL and leaves the pool usable", async () => {
    await isolated(async (pool, kysely) => {
      await expect(runPostgresMigrations(kysely, { migrations: [...migrationDefinitions, futureFailure] })).rejects.toThrow(/syntax error|syntax error at or near \"THIS\"/);
      expect((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()")).rows).toEqual([]);
      expect((await pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    });
  });

  it("holds advisory lock on the transaction connection, blocks with a bounded timeout, and releases on commit/rollback", async () => {
    await isolated(async (pool, _kysely, schema) => {
      const holder = await pool.connect();
      const waitingPool = createPostgresPool(withSchemaSearchPath(pgUrl!, schema, 500));
      const waiting = createPostgresKysely(waitingPool);
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1)", [POSTGRES_MIGRATION_LOCK_KEY]);
        const blocked = runPostgresMigrations(waiting);
        await expect(blocked).rejects.toThrow(/timeout|canceling statement/i);
        await holder.query("COMMIT");
        await runPostgresMigrations(waiting);
        expect((await waitingPool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);

        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1)", [POSTGRES_MIGRATION_LOCK_KEY]);
        const blockedAgain = runPostgresMigrations(waiting);
        await expect(blockedAgain).rejects.toThrow(/timeout|canceling statement/i);
        await holder.query("ROLLBACK");
        await runPostgresMigrations(waiting);
        expect((await waitingPool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
        await waiting.destroy();
      }
    });
  });

  it("CLI reports the connected database and effective search_path schema", async () => {
    await isolated(async (pool, _kysely, schema) => {
      const database = (await pool.query<{ current_database: string }>("SELECT current_database()" )).rows[0]!.current_database;
      const result = spawnSync("pnpm", ["exec", "tsx", "scripts/migrate.ts", "--", "--dry-run"], {
        cwd: process.cwd(),
        env: { ...process.env, PI_STORAGE_DIALECT: "postgres", PI_DATABASE_URL: withSchemaSearchPath(pgUrl!, schema) },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status).toBe(0);
      // The safe target summary uses "PostgreSQL host:port/database; effective schema=..."
      // Assert database name and effective schema are present without hard-coding the
      // full host:port string (which is fragile across environments) or leaking credentials.
      expect(result.stdout).toContain("migration target: PostgreSQL ");
      expect(result.stdout).toContain(`/${database}`);
      expect(result.stdout).toContain(`effective schema=${schema}`);
      expect(result.stdout).not.toContain(pgUrl!);          // full connection string must never appear
      expect(result.stdout).toContain("read-only inspection; no writes");
    });
  });

  it("bridges migrate -> Phase 2 initialize -> CRUD without data loss", async () => {
    await isolated(async (pool, kysely) => {
      await runPostgresMigrations(kysely);
      const initialized = await initializePostgresDatabase(pool);
      try {
        const projects = new KyselyProjectRepository(initialized, pgConstraintErrorMapper);
        await projects.create({ id: "00000000-0000-4000-8000-000000000001", name: "kept", cwd: "/kept", ownerKey: "owner", createdAt: 1 });
        expect((await projects.get("00000000-0000-4000-8000-000000000001"))?.name).toBe("kept");
        expect((await pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0]?.n).toBe(2);
      } finally {
        await initialized.destroy();
      }
    });
  });
});
