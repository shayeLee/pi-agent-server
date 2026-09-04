# Backup and restore procedure

This is the RC backup/restore contract for offline operator use. It covers the SQLite and PostgreSQL cores, but does not claim production readiness. The repository does not start services, schedule backups, perform retention, or automatically roll back a migration.

## Backup package contract

`pnpm backup -- create` and migration pre-backup use the shared encrypted backup core:

- SQLite uses a read-only source and `VACUUM INTO` for a consistent database snapshot; whitelisted JSONL and server `agentDir/models.json` files are included.
- PostgreSQL queries the effective non-system application schema and runs `pg_dump --format=custom --no-owner --no-privileges --schema=<effective-schema> --snapshot=<id>`. The schema is explicitly selected; public/system schemas are rejected. Identity verification, the cluster-identity queries, and `pg_export_snapshot()` all run inside one dedicated read-only `REPEATABLE READ` transaction on a single pool client, and the dump consumes exactly that exported snapshot while the transaction is held open for the whole dump; an unsupported or failed snapshot export fails the backup closed.
- The manifest and every payload are age-encrypted. `COMPLETE` is written last and binds the package to the encrypted manifest hash. Published packages are atomic and private. Pre-reset/pre-migration creation results also return a published-package identity (manifest-ciphertext SHA-256 plus source-roots/binding digests) that `verifyPublishedBackup` re-checks against the published bytes, so a manifest ciphertext or COMPLETE marker replaced after creation fails without any private-identity decryption; SQLite pre-reset backups additionally bind the full DB/WAL/SHM surface at snapshot-generation time: the binding is fingerprinted immediately before the `VACUUM INTO`, re-asserted right after it against the verified identical state, and then fixed as the manifest's immutable baseline — publish/reset steps only compare against it and never re-collect a replacement baseline.
- Credentials and auth files are excluded. PostgreSQL credentials are used through a temporary private `PGPASSFILE` for client tools, never in argv, logs, or manifests.
- Staging is split into two surfaces. Plaintext staging (the SQLite `VACUUM INTO` snapshot, `pg_dump` output, whitelisted JSONL copies, and the manifest plaintext) lives in a private per-user 0700 directory under an independent root: by default the per-user config staging root `$HOME/Library/Application Support/pi-agent-server-backup-staging` (created 0700 on first use) — never the shared OS temporary directory — or an explicit absolute current-user 0700 root via `PI_BACKUP_STAGING_ROOT` (or the `stagingRoot` option). The root's FULL existing ancestor chain is validated on every use: every component must be a non-sticky, non-group/world-writable directory owned by the current user or root; sticky (shared) or third-party ancestors are rejected outright. It is never placed inside the backup root or its parent, and rejected outright if configured there — so the backup root's parent never needs to be writable and an existing backup root works even when its parent is read-only. The staging directory FD is held for the whole backup and revalidated (fstat + O_NOFOLLOW reopen, dev/ino identity) before every sensitive staging operation, so a path rename/substitution between operations fails closed. Publish staging lives inside the backup root and holds only ciphertext (`payload/*.age`, `manifest.json.age`, `COMPLETE`), so publication is one same-filesystem atomic rename. Both staging surfaces are removed on every failure path; the published package therefore contains ciphertext and `COMPLETE` only.
- `pre-migration` is a manifest kind reserved for the migration CLI. It is not a different encryption format.
- The authenticated `migrationLedger` selects the immutable migration prefix represented by the package. Restore verifies that prefix's ledger checksums and physical schema; it never applies a pending migration. Therefore a v0 package is restored as v0 by v1 code and must be upgraded separately with the offline migration command. A package with `present: false` is an explicit legacy branch: restore accepts only a complete known v0/v1 physical schema, reports `legacy: true`, and never infers or applies a migration.
- For v1 packages, restore validates every `file_operations` row (state, lease fields, timestamps, kind, and relative JSONL path) and includes its row count in the report. Invalid or inconsistent outbox data fails closed before publication.

Create a normal daily backup with explicit absolute paths:

```bash
AGENT_CWD=/absolute/application/cwd \
DATA_DIR=/absolute/application/data \
DB_PATH=/absolute/application/data/pi-agent-server.db \
PI_STORAGE_DIALECT=sqlite \
pnpm backup -- create \
  --backup-root /absolute/separate/backup-root \
  --age-recipient-file /absolute/secure/age-recipient-file
```

The migration CLI applies the same core automatically, but only after `--maintenance-window CONFIRMED`, an absolute backup root, and an absolute recipient file are supplied. There is no `--skip-backup` escape hatch.

## Tool and permission checks

Install and pin the `age`/`age-keygen` version used by the deployment. The recipient file must contain public `age1...` recipients only, be a non-symlink regular file, and be readable only by the operator/service account. Keep package and source directories non-group/world-writable.

For PostgreSQL, pin matching-major `pg_dump` and `pg_restore` binaries. The server major (`SHOW server_version_num`), `pg_dump` major, and `pg_restore` major must be equal. A mismatch fails closed before dump/restore; the migration prebackup also runs `pg_restore --list` against the staged custom archive before deleting plaintext. The PG test gate also requires a disposable test URL and permissions to create/drop its isolated schema or database; never use a real production URL. Without the test URL, no real-PG acceptance claim is made.

## Pre-migration sequence

1. Stop the service and every possible writer with the deployment's service manager.
2. Independently confirm no service process remains. The CLI confirmation is an operator statement, not a lock; it cannot detect or stop another process.
3. Run `--dry-run` and review the target and pending migration plan.
4. Run `--apply --backup-root ABSOLUTE_DIR --age-recipient-file ABSOLUTE_FILE --maintenance-window CONFIRMED`.
5. Confirm the output is the secret-free JSON success result. It includes the backup id, `kind`, encrypted manifest checksum, and pre-backup ledger version.
6. Run `--verify` before starting the service. Start the service only through the deployment procedure and observe health separately.

The apply command never calls `startServer`, scheduler, retention, outbox, or IAM code. It does not perform SQLite-to-PostgreSQL data migration.

## Dry-run and verify

```bash
pnpm migrate -- --dry-run
pnpm migrate -- --verify
```

Both modes use read-only inspection. They require explicit absolute `AGENT_CWD` and target paths and must not create a missing SQLite target. `--apply` is the only mode that creates a backup and writes migrations.

## Failure and manual restore

- If backup, age, `COMPLETE`, manifest, payload hash, target, schema, or version checks fail, migration must not run.
- If migration fails, retain the published valid pre-migration package. Never run an automatic down migration or automatic restore. The database transaction may roll back its own DDL, but the JSONL store is separate.
- If post-migration verification fails, treat the change as unaccepted. Stop writers, preserve the package, and have an operator choose a separately reviewed restore.

SQLite restore is a drill into a new absolute target root:

```bash
pnpm restore -- restore \
  --input-backup /absolute/backup-root/backup-<id> \
  --target-root /absolute/isolated/restore-target \
  --age-identity-file /absolute/secure/age-identity
```

Use `--dry-run` first when appropriate. The identity/private key is never stored in the package and must never be supplied as the recipient file. The restore drill decrypts, checks hashes and manifest policy, remaps session paths into the new root, verifies the authenticated historical schema/ledger and the reconstructed SQLite/JSONL relationship, and does not migrate the database. An example compatibility drill is: restore a v0 package, then run `pnpm migrate -- --apply` against the isolated restored database and verify that it reaches v1.

PostgreSQL restore requires an explicitly disposable empty target contract and a target URL supplied out-of-band; it must use a temporary isolated database/schema, matching `pg_restore` major, and a private credential mechanism. Do not restore into the source or into `public`/system schemas. It applies the same authenticated-prefix/explicit-legacy rules as SQLite, verifies the actual current historical head and `file_operations` row contract, then reports counts. A v0 dump is upgraded only by a separate offline migration run against the isolated target. Verify catalog shape, migration head, row counts, JSONL paths, and application connectivity before any reviewed cutover. The tool does not perform an automatic restore after a failed migration.

## RPO/RTO and retention

RPO, RTO, backup retention duration, off-host replication, encryption-key custody/rotation, monitoring, and the exact stop/start procedure are **TBD**. Daily online backup is an external cron/service-manager responsibility. Until those deployment decisions and a restore drill are accepted, these tools remain RC/offline tooling and are not production-ready.

## Offline outbox planner (WP4B, in progress — not accepted, no executor)

WP4B has **not implemented** a physical executor or quarantine (方案 A): the offline CLI (`pnpm file-ops` / bin `pi-agent-server-file-ops`) is a **read-only planner** that lists/counts pending, expired-processing and due-failed `file_operations` rows plus safe state/error counts — zero claims, zero writes, no filesystem access, no operation generation. `--apply` fails closed (exit code 2) with no bypassable confirmation words. SQLite is opened `readOnly` (a missing DB is never created; no WAL/SHM sidecars); PostgreSQL requires explicit `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL` and enforces `default_transaction_read_only=on`. Execution requires an audited external ops tool or a future native helper (a separate, not-yet-started item). The backup/restore contract above contains **no quarantine root**: the WP4A backup contract is unchanged. WP4B is not accepted without the real PostgreSQL planner gate (`pnpm test:file-ops-pg`) actually running in the accepting environment. See [file-operations.md](file-operations.md).
