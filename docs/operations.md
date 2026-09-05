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

## Online backup (12h cadence, external timer)

Backup runs online via a **deployment-audited helper/timer** (or equivalent OS scheduler) that invokes the fixed root-owned absolute **compiled backup CLI** under a pinned node binary — **no pnpm/CLI automated timer example exists**; `pnpm backup` is a manual dev-only command. This repository does not schedule or retain backups automatically — the timer configuration lives and is audited in the deployment layer, not in this codebase. Use a separate absolute backup root and recipient file.

```bash
# Manual dev invocations ONLY (never an automated timer entry point)
AGENT_CWD=/absolute/application/cwd \
DATA_DIR=/absolute/application/data \
DB_PATH=/absolute/application/data/pi-agent-server.db \
PI_STORAGE_DIALECT=sqlite \
pnpm backup -- create \
  --backup-root /absolute/separate/backup-root \
  --age-recipient-file /absolute/secure/age-recipient-file
```

Online backup is not a substitute for the strict stop-and-prebackup step before migration. Define timer ownership, alerting, off-host copy, and retention in deployment policy; they are not implemented here. **Backup retention is 30 days (confirmed) but automatic deletion is not implemented yet, not scheduled** — over-retained backups are cleaned manually until a future work package delivers automated retention (explicitly out of WP5B and WP5C scope). Restore drill cadence is **quarterly + before every major migration (confirmed)**.

**Strict backup completeness foundation: ✅ accepted.** The supplied complete real PG16+age `verify:release` evidence after the fixture repair includes the strict completeness compiled/npm gates and the real PostgreSQL CLI gate passing; no test counts are recorded. This accepts the backup-core/CLI foundation only. **WP5C Option B remains formed, reviewable, and NOT accepted without an actual deployment drill** covering helper/timer → textfile → Prometheus → Alertmanager.

**Strict completeness is mandatory for automation**: any automated run of the fixed compiled backup CLI (deployment-audited helper/timer) MUST pass `--require-complete-session-references`; only strict + published success (exit 0 + exactly one `backup-json-report:` machine line with `status=published`, `strict=true`, `dryRun=false`, `missingSessionReferences=0`) constitutes freshness advancement — dry-run and non-strict runs never count, and a strict run with any missing session reference fails non-zero before publish/COMPLETE with a desensitized count-only error, publishes nothing and cleans staging (see [backup-restore.md](backup-restore.md)). The manual dev invocation above (no strict flag) keeps the default compatible behavior and **explicitly has no freshness meaning**; `pnpm backup` remains a manual dev-only command and is never an automated entry point. **Backup freshness monitoring:** see [backup-freshness-exporter.md](backup-freshness-exporter.md) — WP5C Option B **deployment contract**, formed and **reviewable, not accepted (no acceptance without an actual deployment drill)** (the complete `dist-backup` runtime closure and its ancestor chain are root-owned, non-symlink, and not group/world-writable; its fixed compiled backup bin runs under an exact pinned node (root:root, ≥ 22.19, resolved-path/version-verified as the backup user), never AGENT_CWD/pnpm; `age`/`age-keygen`/`pg_dump`/`pg_restore` use only audited absolute paths or a controlled root-owned safe PATH, with resolved binary/version verification and no uncontrolled PATH; the automation entry point is a **deployment-audited helper/timer** (the contract ships no helper code, shell script, systemd unit, launchd plist or run script and no cross-OS atomic publish claim); secrets never travel in any argv (restricted root 0600 config, strict single `KEY=VALUE` semantics, env-channel only); the service auth token file is service-account 0600 (backup user cannot read its content) with a precise traverse-only (search, no list) ACL on every ancestor (no root-preflight substitute); a per-target metric (node_exporter textfile `pi_agent_server_backup_last_success_timestamp_seconds`) is updated **only after** the target's CLI exit 0 AND machine-readable published-output validation (dry-run rejected; **automation must pass the strict flag `--require-complete-session-references`, machine contract = one `backup-json-report:` line with status=published/strict=true/dryRun=false/missingSessionReferences=0; strict success implies zero missing session references**; published path inside `BACKUP_ROOT`, owned by backup user), with a conservative backup-start timestamp; **failure never updates the metric**; target root/ACL/atomicity are **deployment-audited** (ancestor chain root-owned/non-symlink/without group-or-world write; atomic replacement proven on the target OS — no fd-safety or cross-OS claim); PromQL uses the independent persistent inventory `pi_agent_server_backup_expected_target_info{job,cluster,instance}=1` from the monitoring control plane (not the monitored target), joined to actual freshness/up/textfile on the complete tuple, with inventory-`unless`-actual missing rules (no global `absent()`), stale/future/exporter rules and Q1–Q3 exact-count/cross-job-cluster/set-equality checks; cadence fixed at 12h (≤ 12h, no daily 24h example); backup root owned by `pi-agent-backup` 0700, parent root-controlled; Alertmanager configured externally; nothing is installed by this codebase). Contract formed/reviewable, **not accepted**; the in-repo Option A scanner has been **abandoned** (future native/age-identity approaches remain separate discussion items).

## Backup freshness deployment drill SOP

The WP5C Option B deployment contract is accompanied by the actual deployment drill SOP in [backup-freshness-drill-sop.md](backup-freshness-drill-sop.md). The SOP is landed, but the actual drill is **DEFERRED by the user's decision**; before execution the user must re-authorize the target-like environment. It forbids production data/services, defines SQLite and matching-major PostgreSQL fixtures, the external reviewed helper/timer chain, failure injection, evidence and cleanup. Strict backup completeness foundation is accepted separately; **WP5C and WP5 remain unaccepted and this service is not production-ready**.

## Restore and drill entry point

Use the manual, offline restore/drill procedure in [backup-restore.md](backup-restore.md). A restore target must be explicitly isolated; never point a drill at a live production database or overwrite a source in place. The WP5C deployment-chain procedure is [backup-freshness-drill-sop.md](backup-freshness-drill-sop.md), not a repository scheduler or helper implementation.

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

## Minimal ops gate surface (WP5A, ✅ accepted — process readiness only)

WP5A adds two unauthenticated probe endpoints to the running service, plus the injectable process status backing them:

- `GET /readyz` — reports only that **this process** completed safe startup (storage initialized, optional strict migration gate passed) and is listening: `200 {"ready":true,"migrationGate":"off","schema":"rc-bootstrap"}` when no gate is configured — explicitly an **RC bootstrap ready, not a schema endorsement** — or `200 {"ready":true,"migrationGate":"verify","schema":"migration-head"}` when the startup migration gate passed. Not ready → `503 {"ready":false,...}`. **Effective readiness is fail-closed**: ready requires `ready && (migrationGate="off" || migrationGateVerified)` and a known storage dialect — any inconsistent (ready=true but verify not passed) or unknown state renders 503 with `ready:false` (never a false positive). Startup failure means the process never listens (fail-fast, nothing to probe). `startServer` validates `migrationGate` at runtime (only the exact `"off"` / `"verify"` literals; any other value — JS/typed bypass — rejects before any resource is created). The request path never runs migrations and never writes to the database. `Cache-Control: no-store`.
- `GET /metrics` — Prometheus text exposition (0.0.4), a fixed small surface: `pi_agent_server_ready`, `pi_agent_server_start_time_seconds`, `pi_agent_server_uptime_seconds`, `pi_agent_server_migration_gate_enabled`, `pi_agent_server_migration_gate_verified`, and `pi_agent_server_storage_dialect_info` with a safe `dialect` label. `pi_agent_server_ready` follows effective readiness (inconsistent/unknown states expose `0`). No URL/path/session/prompt/DB counts anywhere; `Cache-Control: no-store`; **route-level strict GET-only**: only `/readyz` and `/metrics` set route-level `exposeHeadRoute: false`, so `HEAD /readyz` / `HEAD /metrics` return 404 while `/health` and every other GET route keep Fastify's default HEAD behavior (`HEAD /health` = 200); any rendering exception fails closed with an empty 503 and never leaks internals. No Prometheus dependency is added; the surface is rendered in-process.

The status object is created and maintained by `startServer` (injected into `buildApp`; the default object in `buildApp` is only for test/non-production compositions and never reports ready): `migrationGateVerified` flips to `true` only after an enabled gate actually passes on the startup path; `ready`/`readyAt` flip to true only after `listen` succeeds. On `preClose` both are lowered best-effort (`/readyz` → 503, `/metrics` ready 0) — an ops-status state change only, with **no new shutdown guarantee**; the existing close/storage-order semantics are untouched.

**Scope boundary (explicit):** WP5A delivers process readiness/metrics only. It does **not** change request idempotency (the existing in-memory `requestId` dedupe plus persisted terminal-result reads stay as-is) and does **not** change shutdown persistence (close order, grace drain and idempotent storage close keep their existing semantics). It is **not** backup freshness, is **not** a scheduler, and is **not** production readiness: there is no backup scheduler/timer, no retention, no backup-missing/stale age alerts, no RPO/RTO default thresholds, and no restore-drill scheduling — those remain WP5 items: WP5B is **DEFERRED by the user's decision and not complete**, while backup-freshness alerting is the WP5C Option B backup freshness **deployment contract** (formed, reviewable, NOT accepted — no acceptance without an actual deployment drill), and retention automation is a future work package (not started); `/readyz` does not know the last backup time; `/metrics` exposes no backup or database-count metrics. See [phase-3-data-retention-plan.md](phase-3-data-retention-plan.md) §8.1. The real-PostgreSQL wiring gate (`tests/postgres/start-ops-pg.test.ts`) is `PI_TEST_PG_URL`-gated; the supplied real PG16+age `verify:release` evidence includes this gate and compiled/smoke passes. No test counts are recorded or inferred.

## WP5B (DEFERRED by the user's decision; not complete)

WP5B is **DEFERRED by the user's decision** and is **not complete**; this is a decision record only, with no implementation or test claim. Current behavior is limited to **in-memory in-flight dedupe plus persisted terminal-result reads**. If the process crashes before the terminal state is persisted, the same `requestId` may execute again. The service makes no exactly-once or durable at-most-once guarantee. Re-trigger WP5B when side-effect tools are formally enabled, multiple instances are deployed, the service is public, or a strict replay-prevention requirement is explicitly introduced. Backup-freshness alerting is the WP5C Option B backup freshness **deployment contract** (formed, reviewable, NOT accepted without an actual deployment drill — see [backup-freshness-exporter.md](backup-freshness-exporter.md)); audit-retention handoff and 30-day retention automation are a **future work package** (not started, not scheduled) and are NOT part of WP5B or WP5C. WP5A delivers only `/readyz` + `/metrics` + startup migration-gate readiness; nothing in WP5A claims or provides any of the above.

## Open operational decisions

**Confirmed decisions** (RPO 24h, RTO 4h, backup retention 30 days, restore drill quarterly + before major migration, external launchd/systemd timer, Prometheus metrics + external Alertmanager) are documented in [phase-3-data-retention-plan.md](phase-3-data-retention-plan.md) §2.2, §6.4, §6.5, §9 and [backup-restore.md](backup-restore.md) §RPO/RTO and retention.

**Still open** deployment decisions: off-host replication, key custody/rotation, and the exact service-manager stop/start commands remain deployment decisions. **WP5C Option B: backup freshness exporter — deployment contract formed, reviewable, NOT accepted (no acceptance without an actual deployment drill; no test counts recorded or inferred).** All automated entry points are **deployment-audited helper/timers (see contract)**; the contract requires fixed build artifacts (the entire `dist-backup` runtime closure and its ancestor chain are root-owned, non-symlink, and not group/world-writable; the compiled backup CLI runs only under an exact pinned node ≥ 22.19, never AGENT_CWD/pnpm; `pnpm backup` is a manual dev-only command), and approved absolute paths or a controlled root-owned safe PATH for `age`/`age-keygen`/`pg_dump`/`pg_restore`, with helper verification of resolved binaries and versions and no uncontrolled PATH, a fixed ≤ 12h cadence (no daily 24h example, random delay ≤ 300s), secrets never in any argv (root 0600 restricted config, env-channel only), the service auth token file service-account 0600 (backup user cannot read its content; precise traverse-only ACL on every ancestor, no root-preflight substitute), per-target node_exporter textfile metric `pi_agent_server_backup_last_success_timestamp_seconds` updated **only after** the target's CLI exit 0 AND machine-readable published-output validation (dry-run rejected) — **failure never updates it**; target root/ACL/atomicity are **deployment-audited** (textfile directory root-owned 0750, node_exporter group read-only, full ancestor chain root-owned/non-symlink/without group-or-world write; atomic replacement proven on the target OS — no cross-OS atomic-publish or fd-safety claim); PromQL uses the **independent persistent inventory metric `pi_agent_server_backup_expected_target_info{job,cluster,instance}=1`** (from the monitoring control plane, not the monitored target) joined to actual freshness/up/textfile metrics on the complete `(job, cluster, instance)` tuple; Q1–Q3 verify exact tuple counts, no instance duplication across job/cluster, and bidirectional inventory/actual set equality, with inventory-`unless`-actual missing rules (no global `absent()`), plus `time() - metric > 24h`, exporter-down, scrape-error and future-timestamp rules; backup root owned by `pi-agent-backup` 0700, parent root-controlled; Alertmanager is configured externally; the contract ships no helper source, shell script, systemd unit, launchd plist or run script. See [backup-freshness-exporter.md](backup-freshness-exporter.md). The in-repo Option A read-only scanner has been **abandoned**; future native in-process metrics or age-identity-based freshness approaches remain separate discussion items. Until the WP5C Option B deployment contract is verified by an actual deployment drill (freshness alerting; WP5B is DEFERRED and not complete, with the current in-memory in-flight dedupe plus persisted terminal-result-read limitation described above; retention automation remains a future work package), RPO/RTO have no automated acceptance loop. This RC workflow is not production-ready. The WP4B physical executor (including unlink)/quarantine and worker remain unimplemented; WP4C is accepted as Plan A's safe DB-only reconcile analyzer only (never scans the filesystem and cannot detect orphan/lost/JSONL corruption; no executor). WP5A (minimal ops gate: `/readyz` + `/metrics` + startup migration-gate readiness, see above) is **✅ accepted** based on the supplied real PG16+age `verify:release` evidence and is **not** backup freshness or production readiness and does **not** change request idempotency or shutdown persistence; the remaining WP5 items are WP5B (durable idempotency/shutdown persistence — DEFERRED and not complete), WP5C (deployment contract — formed, reviewable, not accepted without a deployment drill) and future retention automation (not started); WP6 has not started. The CLI does not start the service and the service remains non-production-ready.
