**English** · [简体中文](README.zh-CN.md)

# pi-agent-server

An Agent Server that turns the Pi Agent runtime into a long-running, session-oriented HTTP/SSE service. It handles request authentication and caller identity resolution, project and session lifecycle, persistence, streaming task control, concurrency, and tool permissions.

Users and integrators can interact with the service through its HTTP/SSE API and build their own UI, workflows, or business systems on top of it. A separate Web UI (built with React and Vite, in `web/`) is included as a standalone client; it is not the only or required UI, and it is not part of the server itself.

> **Status:** Release Candidate (RC)

> **Important limits**
>
> - **PostgreSQL** storage is implemented, but real acceptance is claimed only when the `PI_TEST_PG_URL`-gated PostgreSQL integration suite is run in the current environment. Without that URL, PostgreSQL tests are not acceptance evidence and are not reported as passed. It is only used when enabled explicitly (`PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL`). It is **not production-ready**: service startup is not yet wired to formal migration, backup, or rollback (RC stage).
> - **Backup/restore status:** WP3's offline SQLite/PG backup, restore, pre-migration and runbook cores are implemented. Real PostgreSQL and age gates are environment-gated; this checkout makes no real-PG/age acceptance claim unless the required URL and binaries are present and the gate runs. Published pre-reset/pre-migration packages return a creation-time identity (manifest-ciphertext SHA-256 plus source-roots/binding digests) that `verifyPublishedBackup` re-checks against the published bytes; SQLite pre-reset backups additionally bind the full DB/WAL/SHM surface at snapshot-generation time. Restore selects the authenticated historical migration prefix (including v0), verifies its physical schema without migrating, and validates/counts every v1 `file_operations` row. PostgreSQL restore rejects authenticated public/source schemas (an unconfigured libpq default `public` namespace is only a bootstrap target), requires the canonical explicit empty `pi_restore_*` target contract, and does not publish a zero-byte dump. All WP3 tools are offline dev-time tools, not wired into service startup; service-level formal backup/rollback/runtime integration is not implemented, so WP3 remains not production-ready.
> - **WP4A status: ✅ accepted; later lifecycle work remains.** The v1 Manifest migration adds a persistent `file_operations` outbox on both SQLite and PostgreSQL. Session/project deletion enqueues relative, whitelist-checked JSONL paths in one locked database transaction, preserves the outbox without cascading, and never calls `unlink`; lease tokens fence stale workers, lazy JSONL creation has a durable path reservation, and restore validates/counts each outbox row. This acceptance is based on the supplied successful real PG16+age `verify:release` evidence; no test counts are asserted. WP4B has **not** implemented a physical executor (including unlink) or quarantine — only a safe read-only planner exists today (see next bullet); WP4C (reconcile) has not started; WP5/WP6 have not started. No outbox worker is installed and HTTP never drives execution.
> - **WP4B status: ✅ accepted (Plan A scope: safe read-only planner only; no physical execution).** The offline CLI (`pnpm file-ops` / bin `pi-agent-server-file-ops`) is a **read-only planner**: it lists/counts pending, expired-processing (crashed lease) and due-failed operations plus safe state/error counts from the persistent `file_operations` outbox (only `store.list()`, zero claims/lease/complete/fail, no filesystem access, no operation generation). SQLite is opened `readOnly` — a missing DB is never created (no DB/WAL/SHM) and existing DB bytes stay fingerprint-identical; PostgreSQL requires explicit `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL` and the connection enforces `default_transaction_read_only=on`. `--apply` fails closed immediately (exit code 2): the WP4B physical executor/quarantine is **not implemented**, no confirmation token can bypass this, and reports/errors are redacted (counts/error codes only, never relative/absolute paths). Acceptance evidence from the supplied successful real PG16+age `verify:release` run includes the file-ops planner gate and compiled/npm smoke; no test counts are recorded or inferred. The following safeguards are part of the accepted read-only planner scope: `last_error` is restricted to a fixed finite error-code allowlist (repository read, planner report keys and restore validation all enforce the same policy; unknown free text, relative paths and `credential=` values map to `unsafeErrors`/fallback code, never JSON keys); unknown CLI arguments are rejected without echoing the raw argv; the mandatory real-PostgreSQL gate now actually runs the planner CLI's PG branch (source entry via tsx, fixture-created random role bound to the random schema, forced `default_transaction_read_only=on`) and verifies random-schema isolation, read-only, zero DB changes and no URL/path/credential leakage, while the readOnly test URL keeps both the schema `search_path` and the read-only constraint; `build`/`build:backup`/`build:file-ops` clean their output directories before compiling and the compiled/npm-package smokes assert no residual executor/file-system-policy/error-codes artifacts and no symlinks in published trees. The planner accurately states that execution requires an audited external ops tool or a future native helper (a separate, not-yet-started item). The offline CLI does not start the service or a worker. WP4A's outbox schema/repository/lease contract is unchanged and remains the future executor foundation. WP4C (reconcile) has not started. The real-PostgreSQL planner gate (`pnpm test:file-ops-pg`) is wired into `verify:release` and fails closed without `PI_TEST_PG_URL`; the supplied evidence shows that the gate ran successfully. See [docs/file-operations.md](docs/file-operations.md).
> - **Controlled cutover status (WP2A): implementation and reviewer re-review fixes are present; current acceptance is environment-gated and is not claimed without real PG/age evidence; the actual reset has not been started.** The offline controlled-cutover CLI (`pnpm cutover` / bin `pi-agent-server-cutover`) and an opt-in strict startup migration gate (`PI_MIGRATION_GATE=verify`, read-only ledger/head check, default off) are implemented, with mandatory real-age and real-PostgreSQL drill gates wired into `verify:release`. The **actual cutover has NOT been executed** — no real user SQLite/PG/JSONL has ever been reset by this tool; running it against a real target requires explicit operator authorization. After the WP2A re-review, the reviewer-required hardening (P0–P3) is in place: (1) the PostgreSQL cutover performs the same controlled JSONL cleanup as SQLite — after a verified pre-reset backup it clears only the `sessions/`/`projects/` roots under `DATA_DIR`, preserving `models.json` and never touching credentials (checked by the real-PG CLI/compiled/installed-bin drills when their gate prerequisites are present); (2) the cutover path-safety resolver includes `PI_AUTH_PATH`/`PI_AGENT_DIR`, requires an explicit absolute `DATA_DIR` that never equals/contains/is contained in `AGENT_CWD`, and rejects any overlap — in either direction, through realpath aliases — between the resolved credential, the whole canonical `agentDir` root (including `PI_AGENT_DIR=DATA_DIR`, ancestors, and symlinks), or `agentDir/models.json` and the reset surface (custom credential names/locations are protected by resolved path, never by the `auth.json` file name; the backup whitelist and the pre-reset re-check enforce the same); (3) `migrationGate="verify"` runs on a dedicated gate Pool/Kysely that is always destroyed (also on failure) before a fresh actual Pool bootstraps the service — the SQLite gate is truly read-only: a missing database is never created, the snapshot copy connection opens `readOnly: true`, and existing DB/WAL/SHM remain stat+byte fingerprint-identical; (4) published backup packages bind the canonical source roots plus a SQLite DB stat/content fingerprint or a PostgreSQL database/schema identity, and the cutover revalidates the binding immediately before the destructive step — any target change or identity mismatch before DDL fails with zero reset (a replaced SQLite DB inode/dev/nlink/fingerprint is rejected; the PG authenticated target must equal `--target-schema`/the current schema; for PG, if revalidation passes but DDL/COMMIT later fails, the JSONL cleanup that ran before the DDL transaction cannot be undone, so the pre-reset backup must be preserved for manual restore); (5) `--maintenance-window` accepts only the exact literal `CONFIRMED` (case/whitespace variants are rejected); (6) for `kind=pre-reset`, the SQLite binding covers the full DB/WAL/SHM surface (existence/dev/ino/nlink/mode/size/mtime/SHA-256) and is FIXED at snapshot-generation time: fingerprinted immediately before the `VACUUM INTO`, re-asserted right after it against the verified identical state, and then written into the manifest as one immutable baseline before any JSONL/age work runs — later publish/reset steps only COMPARE against that binding (re-collection is never allowed to replace the baseline), so any change — including a WAL-only commit between the snapshot and the manifest — fails the backup and any later cutover with zero deletion (daily `sqlite-online` backups keep no no-write requirement); (7) the PostgreSQL binding additionally covers cluster/server identity — `pg_control_system().system_identifier` (preferred, read as text), database/schema OIDs, server address/port, and `cluster_name` — captured inside ONE dedicated read-only `REPEATABLE READ` transaction on a single pool client that also exports its snapshot via `pg_export_snapshot()`: `pg_dump --snapshot=<id>` consumes exactly that snapshot while the transaction is held open for the whole dump, and an unsupported or failed export fails the backup closed; the cutover reset path holds one re-verified dedicated pool client and performs the identity revalidation plus `DROP SCHEMA`/`CREATE SCHEMA`/`GRANT` inside that same client/transaction (no pool switching; `DROP DATABASE` is never issued); the revalidation fails closed when the system identifier is unavailable or empty (same-name hashes are never trusted) or when any bound identity drifts (revalidation failure happens before DDL starts, so JSONL and schema are both zero-deletion), and the backup refuses a connection whose `current_database()` differs from the URL database; if DDL or COMMIT fails, the schema change rolls back but the JSONL cleanup that ran before the DDL transaction cannot be undone — the pre-reset backup must be preserved for manual operator restore, with no automatic restore/down/retry; (8) backup creation returns a published-package identity (manifest-ciphertext SHA-256 plus source-roots/binding digests), `verifyPublishedBackup` re-hashes the published manifest ciphertext, COMPLETE marker, and payloads against that creation identity, and a manifest ciphertext or COMPLETE marker replaced after creation fails with zero reset — without ever decrypting the manifest with a private identity; (9) the compiled/npm cutover failure smokes exercise a single verbatim-mismatched confirmation token and a dedicated fail fixture directory. WP2B (actual cutover execution) remains incomplete — it requires explicit user/operator authorization and is never automatic; nothing here is a production-readiness claim. See [docs/cutover-runbook.md](docs/cutover-runbook.md).
> - **PostgreSQL client compatibility:** the backup core and mandatory gate safely query `SHOW server_version_num` and parse both `pg_dump --version` and `pg_restore --version`. All three PostgreSQL majors must match; a mismatch fails before `pg_dump`/`pg_restore` with a safe diagnostic that contains only the client/server majors and “install matching client”. Dumps are not filtered or modified.
> - The web UI is a **separate Web UI, built with React and Vite** (`web/`). The Fastify server does **not** serve `web/dist`; you run the UI yourself (`pnpm web` / `pnpm web:mock`) and open it in a browser.

## Highlights

- **HTTP + SSE API** — streaming answers over Server-Sent Events, with `steer`, `follow-up` and `abort` controls.
- **Sessions & workspaces** — multiple projects (each with its own working directory) and per-user sessions, isolated by identity.
- **Web UI** — manage projects and sessions, pick the model and thinking level, and inspect the live event stream in an inspector pane.
- **Persistence** — full conversation history in Pi JSONL session files; project/session metadata, request idempotency, and the file-cleanup outbox in SQLite (default) or PostgreSQL (explicit opt-in). Deletion only enqueues cleanup; it never unlinks synchronously.
- **Security isolation** — a dedicated server `agentDir` (it does not load your personal `~/.pi/agent` extensions/skills), loopback binding by default, intranet IPs identified by source address (no token), Bearer-token auth for public networks.

## Quick Start

### Prerequisites

- **Node.js >= 22.19.0** and **pnpm** (the web app is a pnpm workspace member).

```bash
git clone <repository-url>
cd pi-agent-server
pnpm install
```

### Zero-credential mock experience

No model credentials needed — the mock server runs a built-in fake agent and an in-memory SQLite database.

```bash
# Terminal 1: mock server on http://127.0.0.1:8081
pnpm mock

# Terminal 2: web UI on http://127.0.0.1:5173 (proxies /v1 and /health to the mock)
pnpm web:mock
```

Open **http://127.0.0.1:5173** in your browser.

Notes:

- The default intranet CIDRs include `127.0.0.0/8`, so requests from your local machine are treated as intranet and need **no token**.
- The mock replies with canned messages — there is **no real model** behind it.

### Real models

Credentials can come from three sources:

1. **Default — your pi CLI auth file:** the server reads `~/.pi/agent/auth.json` by default (the same file the pi CLI uses).
2. **`PI_AUTH_PATH`** — point the server at a dedicated credentials file (recommended for deployments).
3. **`PI_MODEL_PROVIDER` + `PI_MODEL_API_KEY`** — inject a runtime API key for the default provider (not persisted to disk).

Optional, to change the default model for new sessions:

```bash
export PI_DEFAULT_MODEL=provider/modelId   # only the first "/" splits provider from model id
export PI_DEFAULT_THINKING_LEVEL=medium    # off | minimal | low | medium | high | xhigh | max
```

### Start the backend API server

Start only the Fastify Agent Server (the Web UI is optional):

```bash
# API server on http://127.0.0.1:8080
pnpm dev
```

For a persistent local SQLite deployment initialized through the migration workflow, use explicit absolute paths and verify the migration head at startup:

```bash
export AGENT_CWD="$PWD"
export DATA_DIR="$HOME/Library/Application Support/pi-agent-server"
export DB_PATH="$DATA_DIR/pi-agent-server.db"
export PI_MIGRATION_GATE=verify
export PI_BACKUP_STAGING_ROOT="$HOME/Library/Application Support/pi-agent-server-backup-staging"

pnpm dev
```

`PI_MIGRATION_GATE=verify` only verifies the migration ledger; it never migrates, resets, or rebuilds data. Initialize an empty persistent database first with the offline migration workflow in the [cutover runbook](docs/cutover-runbook.md). Stop a foreground server with `Ctrl-C`.

### Optional: start the Web UI

In a second terminal, start the separate Web UI on http://127.0.0.1:5173; it proxies `/v1` and `/health` to the backend on port 8080:

```bash
pnpm web
```

## Usage

### Web UI

The UI lets you create/rename/delete sessions, switch projects, set a session's model and thinking level, watch streaming answers, and open the right-hand **Inspector** to follow the raw SSE event stream. When the intranet probe fails (non-loopback access), a Bearer-token field appears; the token is kept **in browser memory only** and never written to `localStorage`.

### HTTP API

API routes live under `/v1` (JSON); `GET /health` is unauthenticated. Quick index:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness (unauthenticated) |
| `GET` | `/v1/models` | Available models, thinking levels, server default model/thinking level |
| `GET` | `/v1/projects` | List projects |
| `POST` | `/v1/projects` | Create a project (`name` + `cwd`) |
| `DELETE` | `/v1/projects/:id` | Delete a project |
| `GET` | `/v1/sessions?projectId=` | List sessions |
| `POST` | `/v1/sessions` | Create a session (optionally with project + model config) |
| `PATCH` | `/v1/sessions/:id` | Rename a session |
| `PATCH` | `/v1/sessions/:id/config` | Change model / thinking level |
| `DELETE` | `/v1/sessions/:id` | Delete a session |
| `POST` | `/v1/sessions/:id/messages` | Submit a prompt (`requestId` + `prompt` required; `202` = accepted/queued) |
| `GET` | `/v1/sessions/:id/events` | SSE event stream (resume via `Last-Event-ID`) |
| `POST` | `/v1/sessions/:id/steer` | Steer the running task (text) |
| `POST` | `/v1/sessions/:id/follow-ups` | Ask a follow-up (text) |
| `POST` | `/v1/sessions/:id/abort` | Abort the running task |
| `GET` | `/v1/sessions/:id/export` | Export a `{ messages, lastEventId }` snapshot |

> Exact response shapes evolve during RC — **the running API (see `src/server/app.ts`) is authoritative**.

### Curl examples

```bash
# 1. Liveness (no auth)
curl http://127.0.0.1:8080/health
# {"status":"ok"}

# 2. Create a session from localhost (intranet → no token required)
curl -i -X POST http://127.0.0.1:8080/v1/sessions \
  -H 'Content-Type: application/json' \
  -d '{"title":"demo"}'
# 201 + the session record

# Send a prompt (requestId + prompt are required; 202 = accepted)
curl -i -X POST http://127.0.0.1:8080/v1/sessions/<SESSION_ID>/messages \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"req-1","prompt":"Hello"}'
# 202 {"status":"accepted"} ; the streamed answer is delivered via GET /v1/sessions/<id>/events

# 3. Public network — Bearer token from the static TOKENS mapping
curl http://<public-host>:8080/v1/models -H "Authorization: Bearer <TOKEN>"
```

## Configuration

All settings are environment variables (parsing lives in `src/main.ts`).

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `127.0.0.1` | Bind address; expose only behind a firewall/proxy |
| `DATA_DIR` | current working directory | Server data directory: session JSONL, server `agentDir`, SQLite file |
| `DB_PATH` | `<DATA_DIR>/pi-agent-server.db` | SQLite database file |
| `PI_AUTH_PATH` | `~/.pi/agent/auth.json` | Credentials file (shared with the pi CLI by default) |
| `PI_MODEL_PROVIDER` | unset | Default provider for runtime API-key injection |
| `PI_MODEL_API_KEY` | unset | Runtime API key for the default provider (not persisted) |
| `PI_DEFAULT_MODEL` | unset | `provider/modelId` used as the default for new sessions |
| `PI_DEFAULT_THINKING_LEVEL` | unset (Pi default) | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `TOKENS` | empty | Static public-network mapping `token1:acct1,token2:acct2`; the server does not issue tokens |
| `INTRANET_CIDRS` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8` | Client IPs treated as intranet (identity from source IP, no token) |
| `TOOLS` | unset → `read,ls,find,grep` | Tool allowlist; `bash`/`edit`/`write` must be listed explicitly |
| `TRUST_PROXY` | unset (disabled) | Comma-separated concrete proxy IP allowlist; required behind a reverse proxy |
| `CORS_ORIGINS` | empty (CORS off) | Comma-separated allowed browser origins |
| `PI_STORAGE_DIALECT` | `sqlite` | `sqlite` or `postgres`; blank/empty normalizes to `sqlite`, unknown non-empty fails fast |
| `PI_DATABASE_URL` | unset | Required when `PI_STORAGE_DIALECT=postgres`; missing → fail at startup (no silent fallback) |
| `PI_BACKUP_STAGING_ROOT` | `$HOME/Library/Application Support/pi-agent-server-backup-staging` | Backup/migrate/cutover CLIs only: explicit absolute current-user 0700 root for the private plaintext staging directory (SQLite `VACUUM INTO` snapshot / `pg_dump` output / JSONL copies). Default is the per-user config staging root (never the shared OS temp dir); the root's full ancestor chain must be non-sticky, not group/world writable, and owned by the current user or root. Never inside the backup root or its parent; the backup root's parent never needs to be writable |
| `PI_MIGRATION_GATE` | `off` | Strict startup migration gate: `verify` read-only checks the migration ledger/head before schema bootstrap and fails fast on empty/legacy/stale databases (explicit instruction to run the offline cutover/migrate); never auto-migrates or resets; unknown non-empty values fail fast |

## Data & Storage

- **SQLite (default)** — project/session metadata, request idempotency, and the v1 `file_operations` outbox live in a SQLite file at `DB_PATH` (WAL mode, foreign keys on). PostgreSQL uses the same logical schema and repository contract. The outbox is **not drained yet**: the offline `pnpm file-ops` CLI (WP4B) is currently a read-only planner only (no physical executor), and future lifecycle workers do not exist — never by HTTP requests and never automatically.
- **Conversation history** — the Pi SDK writes full history as JSONL session files: `<DATA_DIR>/sessions/<sessionId>/` for the default project and `<DATA_DIR>/projects/<projectId>/sessions/<sessionId>` for extra projects. The DB records the JSONL path so sessions are restored after a restart.
- **Server agent directory** — `<DATA_DIR>/.pi-agent` holds server-side agent config (`models.json` etc.) and does not inherit your personal `~/.pi/agent`.
- **Credentials** — default `~/.pi/agent/auth.json`, overridable with `PI_AUTH_PATH`.
- **Schema** — tables/columns/indexes are generated from a single runtime Schema Manifest (`src/storage/schema-manifest.ts`); details in [docs/database-design.md](docs/database-design.md).
- **PostgreSQL** — real acceptance is **`PI_TEST_PG_URL`-gated** and is not claimed when that URL is absent (shared dialect-neutral repository contract, real unique-constraint mapping, old-schema fail-fast); the storage integration suite is only acceptance evidence when it runs against the current real PostgreSQL instance. Enable it explicitly with `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL`; a blank dialect stays on SQLite and an unknown non-empty dialect fails fast. WP3B2's offline `pg_dump`/`pg_restore` core and reviewer P0/P1 fixes are complete, and its mandatory real PG binary `pg_dump`/`pg_restore` gate is acceptance evidence only when it runs with a matching client. Restore uses the canonical explicit empty `pi_restore_*` contract, rejects authenticated public/source schemas, and can locate a non-public source schema from the target catalog without a target URL `search_path` (the unconfigured libpq default `public` namespace is only a bootstrap target). **The libpq client major must match the test server major and both `pg_dump` and `pg_restore` must use that same major.** Safely inspect the server with `psql ... -Atc 'SHOW server_version_num'`; install/use `libpq@<server-major>` (or the equivalent matching-major package) and put its `bin` first in `PATH`. Do not assume major 18. To re-run the gated suite locally, use the Podman setup in [docs/postgres-podman-test.md](docs/postgres-podman-test.md). Service-level migration/backup/rollback integration is not production-ready.

## Security & Limitations

- Binds to **127.0.0.1** by default; open it up only through a controlled network/firewall.
- Intranet IPs are trusted by **source IP** (no token). The public network requires a Bearer token from the static `TOKENS` mapping; there is **no token-issuance endpoint**.
- **Current authentication scope:** The server relies on a static `TOKENS` environment-variable mapping for public-network Bearer token authentication. There is no user login system, no token-issuance API, and no per-user identity management.
- **Planned improvements (not yet implemented):** Full user login and Identity & Access Management (IAM), encompassing three layers — Authentication (user login), Identity (caller identity resolution beyond source IP), and Authorization (permission checks). Planned capabilities include OAuth/OIDC integration, Access Tokens (the decided auth mechanism; session-based auth is excluded), API Key lifecycle management (generation, rotation, revocation, expiration), fine-grained permission scopes, and audit logging. No timeline or implementation details are committed at this stage. The detailed roadmap (terminology, target architecture, data-model direction, phased work packages, and open decisions) is documented in [docs/identity-access-plan.md](docs/identity-access-plan.md).
- The default tool allowlist is **read-only** (`read`, `ls`, `find`, `grep`); `bash`, `edit` and `write` are disabled unless explicitly listed in `TOOLS`.
- `POST /v1/projects` accepts a client-supplied `cwd` — do **not** expose it on public production deployments, because an authenticated client could create workspaces on arbitrary local paths.
- The web UI keeps tokens **in browser memory only** (no `localStorage`).
- Behind a reverse proxy, set `TRUST_PROXY` to the proxy's concrete IPs (full-trust and CIDR entries are rejected) and `CORS_ORIGINS` for browser clients; otherwise forwarded client IPs stay untrusted and cross-origin SSE is blocked.
- **PG/age status** — validated only by current, explicitly run real gates: `PI_TEST_PG_URL` is required for PG, and the age gates require `age`/`age-keygen`. Without those prerequisites, the result is skipped or fails closed, never “passed”. WP4A's storage/outbox/restore hardening is accepted based on the supplied real PG16+age gate evidence; WP4B's safe read-only planner is accepted based on the supplied evidence (physical executor, including unlink, retry/quarantine are **not implemented**); WP4C (reconcile) and WP5/WP6 have not started. Still **not production-ready**: service-level migration, backup, rollback and lifecycle integration is not implemented — treat as RC-only.

## Development & Testing

```bash
pnpm test               # server tests (vitest)
pnpm typecheck          # TypeScript check (no emit)
pnpm verify             # daily gate: typecheck + test + build:backup + build:file-ops
pnpm test:postgres      # real-PG integration tests only; FAILS (exit 1) when PI_TEST_PG_URL is missing/blank
pnpm test:pg-backup     # mandatory real pg_dump/pg_restore + age backup gate; preflights server/client majors and fails closed on mismatch
pnpm test:migration-prebackup # mandatory WP3C real PG pre-migration-backup gate; fails closed without URL/tools
pnpm cutover             # offline controlled-cutover CLI (WP2A; destructive only behind the full confirmation chain — see docs/cutover-runbook.md)
pnpm test:cutover        # mandatory real-age SQLite cutover drill gate (runs test:age first); fails closed without age/age-keygen
pnpm test:cutover-pg     # mandatory real-PostgreSQL cutover drill gate (random pi_cutover_* schema; library-level + real CLI E2E incl. JSONL reset/binding/redaction/fail paths); fails closed without URL/tools
pnpm file-ops            # offline WP4B read-only planner CLI: default/--dry-run lists/counts outbox operations; --apply fails closed (executor not implemented) — see docs/file-operations.md
pnpm test:file-ops-pg    # mandatory real-PostgreSQL WP4B planner gate (random dedicated schema); fails closed without PI_TEST_PG_URL
pnpm build:file-ops      # compile dist-file-ops + compiled CLI smoke + npm-installed bin smoke (dry-run zero-write, missing-DB zero-creation, --apply fail-closed, redacted reports)
pnpm test:restore-real  # real age integration + SQLite restore-core gate
pnpm verify:release     # full release gate: typecheck + test + test:postgres + test:pg-backup + test:migration-prebackup + test:cutover + test:cutover-pg + test:file-ops-pg + test:age (called by test:restore-real) + test:restore-real + build + build:migrate + build:backup + build:cutover + build:file-ops (requires PI_TEST_PG_URL and all real binaries)
pnpm build              # build the server (dist/)

pnpm --filter web test  # web unit tests
pnpm --filter web build # build the web app (tsc -b && vite build)
pnpm e2e                # Playwright end-to-end (starts its own mock backend + Vite server)
```

- **Release gate (P0):** a release must not claim full acceptance while `typecheck` was not run, the PG tests were skipped, the real PG backup gate was skipped, the real cutover drill gates were skipped, the real WP4B planner PG gate was skipped, or the real age restore gate was skipped. `pnpm verify:release` runs `typecheck` + `test` + `test:postgres` + `test:pg-backup` + `test:migration-prebackup` + `test:cutover` + `test:cutover-pg` + `test:file-ops-pg` + `test:age` (called by `test:restore-real`) + `test:restore-real` + `build` + `build:migrate` + `build:backup` + `build:cutover` + `build:file-ops`; `release:rc` calls `verify:release` before publishing. `pnpm verify` covers the daily loop (typecheck + test + build:backup + build:file-ops) without requiring a database.
- **Age is a release-gate dependency:** `test:restore-real` first runs `test:age`, which requires both `age` and `age-keygen`. If either binary is unavailable, the complete release verification fails closed (non-zero) rather than skipping the restore gate. `build:cutover` additionally runs the compiled and installed-bin cutover E2E against a real random `pi_cutover_*` PostgreSQL schema when `PI_TEST_PG_URL` and the required binaries are set (otherwise that section prints a skip note while the mandatory `test:cutover-pg` gate still fails closed without the URL).
- **PG integration tests vs. plain test skip (keep them distinct):**
  - `pnpm test` (no `PI_TEST_PG_URL`): the `tests/postgres/` group is **skipped** (existing gate; never reported as passing / never connects).
  - `pnpm test:postgres` (no `PI_TEST_PG_URL`): **exits non-zero with a clear reason** (release gate — skipping is not acceptance). Uses a cross-platform Node runner (`scripts/test-postgres.ts`), never prints the connection string.
  - With `PI_TEST_PG_URL` set, both `pnpm test` and `pnpm test:postgres` run the real-PG cases (`tests/postgres/`); `pnpm test:pg-backup` additionally requires `pg_dump`, `pg_restore`, age and age-keygen and runs the isolated dump→encrypt→restore gate. Use `pnpm verify:release` for the complete acceptance loop.
- **e2e** — not shipped as "green" in this RC; run `pnpm e2e` locally to verify (first run: `pnpm --filter web exec playwright install` to fetch browsers).
- Architecture & core data flow: [docs/architecture.md](docs/architecture.md). Storage design: [docs/database-design.md](docs/database-design.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — architecture and core data flow
- [docs/database-design.md](docs/database-design.md) — SQLite / PostgreSQL schema design
- [docs/pi-sdk-api.md](docs/pi-sdk-api.md) — Pi SDK usage index (the HTTP surface is defined in `src/server/app.ts`)
- [docs/postgres-podman-test.md](docs/postgres-podman-test.md) — local PostgreSQL testing with Podman
- [docs/operations.md](docs/operations.md) — offline migration/pre-backup operations runbook and gates
- [docs/cutover-runbook.md](docs/cutover-runbook.md) — WP2A controlled-cutover runbook (implemented; current PG/age acceptance is environment-gated; the actual cutover has not been executed)
- [docs/backup-restore.md](docs/backup-restore.md) — SQLite/PostgreSQL backup, restore, and drill contract

Internal phase plans and archived documents (`docs/archive/`) are not user-facing entry points.