# Offline operations runbook

This runbook describes the current **RC, offline-only** migration and backup tools. It is not a production-readiness claim. The tools are not imported by `startServer`, do not start the server, and do not install a scheduler, retention worker, outbox, or IAM integration.

## Controlled cutover (WP2A, implemented; NOT executed)

WP2A adds a separate offline **controlled cutover** CLI (`pnpm cutover` / bin `pi-agent-server-cutover`) that performs the one-time RC reset: pre-reset encrypted backup → backup verification → controlled reset (SQLite: DB/WAL/SHM + `sessions/` + `projects/` roots; PostgreSQL: DROP/CREATE of an allowlisted dedicated `pi_cutover_*` schema only, never `DROP DATABASE`/`public`) → Manifest-driven migration apply → strict head verify → a redacted machine report. It requires the full confirmation chain (`--reset-rc-data`, `--confirm-reset DELETE_RC_DATA`, `--maintenance-window CONFIRMED`) and absolute paths; `--dry-run` writes nothing. **The real cutover has not been executed; WP2 is not complete.** The WP2A reviewer re-review fixes are implemented and pending re-acceptance (snapshot-time SQLite DB/WAL/SHM binding, whole-agentDir reset-surface exclusion, PG cluster/database/schema identity binding with fail-closed revalidation, published-manifest identity verification). Procedures, reset scope, the strict opt-in startup migration gate (`PI_MIGRATION_GATE=verify`), and the manual-restore-only rollback are documented in [cutover-runbook.md](cutover-runbook.md).

## Fixed safety boundary

- `pi-agent-server-migrate --apply` requires all of: an explicit absolute `--backup-root`, an explicit absolute `--age-recipient-file`, and `--maintenance-window CONFIRMED`.
- The maintenance-window value is an operator confirmation that the service has been stopped. It is **not a process lock and cannot prove or prevent another process from running**. The migration remains an offline operator action.
- Apply order is: resolve and display a redacted target summary → create an encrypted `kind=pre-migration` backup → validate `COMPLETE`, manifest, hashes, and non-empty age outputs → migrate → verify/head check → emit a secret-free JSON result. For PostgreSQL, age availability plus `pg_dump --version` and `pg_restore --version` are checked before publication; both client majors must exactly equal `SHOW server_version_num / 10000`, and `pg_restore --list` validates the custom archive before its plaintext dump is removed.
- A backup or verification failure stops the operation before migration. A migration failure leaves the valid backup in place; there is no automatic `down`, restore, or retry.
- Use an absolute `AGENT_CWD`, `DATA_DIR`, and `DB_PATH`. The production CLI must not infer the application target from its process working directory. Keep `backup-root` outside all source roots.

## Preconditions

1. Identify the exact instance, database/schema, data directory, and maintenance window.
2. Stop the service using the deployment's own service manager. Confirm the process and all writers are gone. Do not treat the CLI flag as that confirmation.
3. Use a dedicated age recipient file containing public recipients only. Protect it as a regular file (`0600` or stricter); never put an age identity/private key in the recipient file.
4. Restrict data and backup directories to the operator/service account (`0700` where applicable). Do not put credentials, URLs, keys, or passwords in command arguments, manifests, or logs.
5. For PostgreSQL, use the explicitly selected `PI_STORAGE_DIALECT=postgres` and `PI_DATABASE_URL`. Use the already validated application schema and matching `pg_dump`/`pg_restore` client major; all three PostgreSQL majors (server, dump client, restore client) must match exactly. See [backup-restore.md](backup-restore.md).

## Migration procedure

Set placeholders in the shell environment rather than copying secrets into a command line:

```bash
export AGENT_CWD=/absolute/application/cwd
export DATA_DIR=/absolute/application/data
export DB_PATH=/absolute/application/data/pi-agent-server.db
export PI_STORAGE_DIALECT=sqlite
export BACKUP_ROOT=/absolute/separate/backup-root
export AGE_RECIPIENT_FILE=/absolute/secure/age-recipient-file

# Inspect without writes; the target must already exist.
pnpm migrate -- --dry-run

# Confirm the stopped-service condition separately, then run the gated apply.
pnpm migrate -- --apply \
  --backup-root "$BACKUP_ROOT" \
  --age-recipient-file "$AGE_RECIPIENT_FILE" \
  --maintenance-window CONFIRMED

# Verify again as an explicit read-only check.
pnpm migrate -- --verify
```

The apply success line is machine-readable and contains only status, dialect, backup id/kind/checksum/version, and migration verification metadata. A non-zero exit is failure; do not interpret a partial human-readable line as success.

For PostgreSQL, set `PI_STORAGE_DIALECT=postgres` and `PI_DATABASE_URL` in the environment, keep the same absolute path variables, and use the same commands. The CLI displays only a safe host/port/database summary and effective schema; it never prints the connection URL.

## Failure handling

- **Before migration:** preserve the error and correct the prerequisite. No migration is run when backup creation, age availability, package validation, manifest/hash verification, or target checks fail.
- **Migration error:** leave the published `pre-migration` package untouched. Do not run an automatic down migration or restore. Capture the secret-free result, investigate, and follow the manual restore procedure only after an operator decision.
- **Post-migration verify error:** treat the migration as not accepted. Stop the service, preserve the pre-migration backup, and perform a separately reviewed restore/verification; the CLI does not restore automatically.

## Daily online backup

Daily full backups may run online from an **external cron/service manager** by calling the explicit backup CLI. This repository does not schedule or retain backups automatically. Use a separate absolute backup root and recipient file:

```bash
AGENT_CWD=/absolute/application/cwd \
DATA_DIR=/absolute/application/data \
DB_PATH=/absolute/application/data/pi-agent-server.db \
PI_STORAGE_DIALECT=sqlite \
pnpm backup -- create \
  --backup-root /absolute/separate/backup-root \
  --age-recipient-file /absolute/secure/age-recipient-file
```

Online daily backup is not a substitute for the strict stop-and-prebackup step before migration. Define cron ownership, alerting, off-host copy, and retention in deployment policy; they are not implemented here.

## Restore and drill entry point

Use the manual, offline restore/drill procedure in [backup-restore.md](backup-restore.md). A restore target must be explicitly isolated; never point a drill at a live production database or overwrite a source in place.

## Offline outbox planner (WP4B, ✅ accepted — read-only, no executor)

The persistent `file_operations` outbox is **not drained by anything yet**. The explicit offline CLI is a read-only planner that never executes:

```bash
# read-only plan (zero writes) — the default `run` mode
DB_PATH=/absolute/application/data/pi-agent-server.db \
pnpm file-ops -- run

# PostgreSQL (explicit dialect + URL; read-only session enforced)
PI_STORAGE_DIALECT=postgres \
PI_DATABASE_URL=postgresql://... \
pnpm file-ops -- run
```

`--apply` fails closed immediately (exit code 2): the WP4B physical executor (including unlink)/quarantine is not implemented, no confirmation word can bypass it, and the planner never claims/leases/completes/fails rows or touches files (a missing SQLite DB is never created — no DB/WAL/SHM sidecars; existing DB bytes stay fingerprint-identical). Reports and errors are redacted (counts/error codes only, no relative/absolute paths). Execution is reserved for a future audited native helper (separate item). The supplied successful real PG16+age `verify:release` evidence includes the file-ops planner gate and compiled/npm smoke; no test counts are recorded or inferred. The CLI does not start the service or install a worker; it is offline dev-time tooling and not production-ready. Full details: [file-operations.md](file-operations.md).

## Offline DB-only reconcile analyzer (WP4C, ✅ accepted — safe DB-only analyzer)

The explicit offline CLI performs a **read-only DB reference analysis** (read-only DB references: session id/project id/`pi_session_file` only, never content fields) with pure string/lexical validation of the canonical layout under the specified `DATA_DIR` string. It **never touches the filesystem** — no recursive traversal, no stat/open/read, no JSONL parsing — so it cannot detect orphan/lost/JSONL-corruption states, and it never executes anything:

```bash
# read-only DB reference analysis (zero writes) — the default `run` mode
DATA_DIR=/absolute/application/data \
DB_PATH=/absolute/application/data/pi-agent-server.db \
pnpm reconcile-jsonl -- run

# PostgreSQL (explicit dialect + URL; read-only session enforced)
PI_STORAGE_DIALECT=postgres \
PI_DATABASE_URL=postgresql://... \
DATA_DIR=/absolute/application/data \
pnpm reconcile-jsonl -- run
```

`DATA_DIR` is a pure string contract (explicit, absolute, non-root, no traversal segments; existence is not required and nothing is ever scanned) used to bind the canonical layouts `sessions/<sessionId>/<file>` (default project) and `projects/<projectId>/sessions/<sessionId>/<file>` (other projects). `NULL` `pi_session_file` rows are counted as normal unmaterialized (not an issue); non-NULL references are validated lexically (rejecting traversal/empty/wrong root/id mismatch/invalid file names) and duplicate references to the same canonical reference are detected. `--apply` fails closed immediately (exit code 2): WP4C Plan A performs **no delete/move/quarantine, no DB writes, no outbox enqueue and no v2 migration**; no confirmation word can bypass this. Reports contain counts, fixed issue codes (`invalid_reference`/`duplicate_reference`), fixed `filesystemNotScanned: true` / `cannotDetect` fields (orphan/lost/json validity cannot be determined), and opaque sha256 references — never paths, URLs, DATA_DIR, session ids or prompt content — with `executable:false`. SQLite is opened `readOnly` (missing DB never created — no DB/WAL/SHM sidecars; existing DB bytes stay fingerprint-identical); PostgreSQL requires explicit `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL` with `default_transaction_read_only=on` (URLs with an existing `options` parameter are rejected); migration-head verification is read-only. **WP4C is accepted** based on the supplied complete real PG16+age `verify:release` success evidence, which includes the real-PostgreSQL reconcile gate and compiled/npm smoke; no test counts are recorded or inferred. Real filesystem reconcile (orphan/lost/JSONL-corruption detection) and any remediation are reserved for a future audited native helper (separate item). The CLI does not start the service or install a worker; it is offline dev-time tooling and not production-ready. Full details: [reconcile-jsonl.md](reconcile-jsonl.md).

## Open operational decisions

RPO, RTO, retention duration, off-host replication, key custody/rotation, alerting, and the exact service-manager stop/start commands remain deployment decisions. Until they are decided and tested, this RC workflow is not production-ready. The WP4B physical executor (including unlink)/quarantine and worker remain unimplemented; WP4C is accepted as Plan A's safe DB-only reconcile analyzer only (never scans the filesystem and cannot detect orphan/lost/JSONL corruption; no executor), while WP5/WP6 have not started. The CLI does not start the service and the service remains non-production-ready.
