**English** · [简体中文](README.zh-CN.md)

# pi-agent-server

A long-running, session-oriented HTTP/SSE server around the Pi Agent runtime. It provides project and session management, streaming task control, persistence, concurrency limits, IP-based admission, route RBAC, and configurable tool access. The React/Vite app in `web/` is an optional standalone client; Fastify does not serve it.

> **Status: Release Candidate (RC). Not production-ready.**

## Current boundaries

- **Single instance only:** one pi-agent-server process per logical SQLite database or PostgreSQL schema and its associated `DATA_DIR`. Shared-storage replicas and overlapping rolling upgrades are unsupported.
- **Intranet only:** caller identity is the canonical direct TCP peer IP. Every route is gated by mandatory `PI_ALLOWED_CLIENT_CIDRS`; forwarded-IP headers are never trusted. Public exposure is prohibited until future OIDC/IAM and workspace/sandbox work is complete.
- **Not a sandbox:** IP-RBAC does not restrict project `cwd`, absolute tool paths, or OS permissions. The default tool allowlist is read-only. WP5B durable idempotency/shutdown hardening must be completed before enabling `bash`/`edit`/`write`, multiple instances, or public access; no runtime guard currently enforces that policy.
- **Logical deletion only:** deleting projects or sessions removes database-visible resources and records JSONL cleanup in `file_operations`. No worker drains the outbox and no physical JSONL unlink occurs.
- **Local encrypted backups:** offline SQLite/PostgreSQL backup and restore tooling uses age encryption and a local `BACKUP_ROOT`. It does not cover simultaneous host/disk and backup loss. The age identity/private key is managed by operations and supplied only during restore.
- **Recovery policy:** RPO target is 24 hours; backup retention is 30 days with manual cleanup. RTO target is 4 hours, but signoff is deferred until the service is in use and has a representative data scale.
- **Backup/runtime compatibility (Phase 3):** SQLite/PostgreSQL backup (including `--dry-run`) requires the exact canonical single-baseline source ledger before encryption, publication, success reporting, or freshness advancement; missing/legacy multi-row/checksum-mismatched ledgers fail closed. A DB reference to a missing JSONL remains missing-as-empty and may publish once that DB gate passes; JSONL is opaque during backup. Restore degrades a present-but-invalid history to empty (reference set to NULL, reported) while package-level age/hash/manifest integrity still fails the whole restore. Runtime and restore accept only current Pi JSONL v3; v1/v2 histories are never SDK-migrated (`migrateSessionEntries` is not used) and are fail-fast at runtime / invalid-as-empty during restore. Legacy backup packages remain **not recoverable**.
- **Migration startup gate:** `PI_MIGRATION_GATE` is fixed to read-only `verify`; `off` (including `PI_DATA_MODE=rc`) is rejected before resources are created. The service never bootstraps a baseline: run the offline migration, then start only after it verifies the canonical single baseline. `PI_DATA_MODE` remains a deployment classification and cannot relax this requirement.

## Highlights

- HTTP/JSON API plus Server-Sent Events.
- `steer`, `follow-up`, and `abort` controls while a task is running.
- Per-IP ownership isolation for projects and sessions.
- SQLite by default; explicit PostgreSQL opt-in.
- Pi JSONL conversation history plus database metadata and terminal request-idempotency records.
- Central default-deny route RBAC with `viewer`, `user`, `operator`, and `admin` roles.
- Optional exact-IP-bound Bearer tokens through a secure policy file.

## Quick start

### Prerequisites

- Node.js >= 22.19.0
- pnpm

```bash
git clone <repository-url>
cd pi-agent-server
pnpm install
```

### Mock server and Web UI

```bash
# Terminal 1
pnpm mock

# Terminal 2
pnpm web:mock
```

Open <http://127.0.0.1:5173>. The mock server uses an in-memory database and a fake agent; no model credentials are required.

### Real server

`PI_ALLOWED_CLIENT_CIDRS` is mandatory. It is matched against the direct socket peer IP for every route, including probes.

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8
pnpm dev
```

The default credential source is `~/.pi/agent/auth.json`. For a deployment, point `PI_AUTH_PATH` at a dedicated service credential file. A runtime default API key may instead be injected with `PI_MODEL_PROVIDER` and `PI_MODEL_API_KEY`.

Optional model defaults:

```bash
export PI_DEFAULT_MODEL=provider/modelId
export PI_DEFAULT_THINKING_LEVEL=medium
```

For a persistent migrated database, configure absolute `AGENT_CWD`, `DATA_DIR`, and `DB_PATH`, initialize or upgrade it through the offline migration procedure, then start with:

```bash
export PI_MIGRATION_GATE=verify
```

`verify` checks the immutable migration ledger and schema head; it never applies migrations, resets data, or bootstraps a baseline. PostgreSQL must use a non-`public`, non-system effective `current_schema()`. See [Backup and restore](docs/backup-restore.md).

Start the optional standalone Web UI with `pnpm web`.

## API overview

All routes first pass direct-peer-IP admission. `/health` and `/readyz` are token-free for any admitted role. `/metrics` is restricted to `admin`/`operator` and still requires the IP-bound token when that profile has `tokenRequired=true`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness |
| `GET` | `/readyz` | Process startup and migration-gate readiness |
| `GET` | `/metrics` | Fixed Prometheus process/readiness surface |
| `GET` | `/v1/models` | Available models and defaults |
| `GET` / `POST` | `/v1/projects` | List or create projects |
| `DELETE` | `/v1/projects/:id` | Logically delete a project |
| `GET` / `POST` | `/v1/sessions` | List or create sessions |
| `PATCH` / `DELETE` | `/v1/sessions/:id` | Rename or logically delete a session |
| `PATCH` | `/v1/sessions/:id/config` | Change model/thinking configuration |
| `POST` | `/v1/sessions/:id/messages` | Submit a prompt (`requestId` required) |
| `GET` | `/v1/sessions/:id/events` | SSE stream; viewer with no live runtime receives `204` |
| `POST` | `/v1/sessions/:id/steer` | Steer a running task |
| `POST` | `/v1/sessions/:id/follow-ups` | Queue a follow-up |
| `POST` | `/v1/sessions/:id/abort` | Abort a task |
| `GET` | `/v1/sessions/:id/export` | Read-only message snapshot; never creates a runtime |

The running API in `src/server/app.ts` is authoritative during RC.

## Access control

Startup requires an explicit CIDR allowlist:

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8
```

An optional absolute `PI_IP_ACCESS_POLICY_FILE` may define exact-IP profiles with:

- `role`: `viewer`, `user`, `operator`, or `admin`;
- `disabled`;
- `tokenRequired` and globally unique `sha256:<64-lowercase-hex>` token hashes.

An unregistered IP inside an allowed CIDR receives `role=user` with token disabled. Tokens cannot bypass CIDR admission, change role, or move between IPs. Cross-owner resources remain hidden with `404`; `admin` does not have cross-owner access.

Legacy `INTRANET_CIDRS`, `TOKENS`, and `TRUST_PROXY`, plus removed workspace settings, cause startup to fail. See [IP-RBAC design](docs/ip-rbac-design.md).

## Configuration

| Variable | Current default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `DATA_DIR` | process cwd | JSONL, service agent directory, and default SQLite location |
| `DB_PATH` | `<DATA_DIR>/pi-agent-server.db` | SQLite file |
| `PI_STORAGE_DIALECT` | `sqlite` | `sqlite` or explicit `postgres` |
| `PI_DATABASE_URL` | unset | Required with PostgreSQL |
| `PI_ALLOWED_CLIENT_CIDRS` | **none; required** | Canonical direct-peer CIDRs |
| `PI_IP_ACCESS_POLICY_FILE` | unset | Optional absolute JSON v1 policy path |
| `PI_AUTH_PATH` | `~/.pi/agent/auth.json` | Use a dedicated service file outside development |
| `PI_MODEL_PROVIDER` / `PI_MODEL_API_KEY` | unset | Runtime default-provider credential injection |
| `PI_DEFAULT_MODEL` | unset | `provider/modelId` |
| `PI_DEFAULT_THINKING_LEVEL` | Pi default | `off` through `max` |
| `TOOLS` | `read,ls,find,grep` | Side-effect tools require explicit configuration and the WP5B deployment gate |
| `CORS_ORIGINS` | empty | Comma-separated browser origins |
| `PI_DATA_MODE` | `managed` | Deployment classification only; it cannot relax the required offline-migrated/verified baseline |
| `PI_MIGRATION_GATE` | `verify` | Fixed read-only startup verification; `off` is rejected and startup never bootstraps/migrates |
| `PI_BACKUP_STAGING_ROOT` | per-user private application directory | Offline backup/migration plaintext staging |

`PI_DEFAULT_WORKSPACE_ROOT`, `defaultWorkspaceRoot`, and `workspaceRoots` were removed and are rejected even when explicitly present with `undefined` through runtime configuration.

## Persistence and operations

- Metadata lives in SQLite or PostgreSQL; full conversation history lives in Pi-managed JSONL files.
- DELETE writes a durable cleanup intent to `file_operations`, but the repository supplies only a read-only planner. Physical execution is outside the current scope.
- Backup, restore, migration, reconciliation, and owner-transfer tools are offline commands. They do not start the service or install timers/workers.
- PostgreSQL requires matching server, `pg_dump`, and `pg_restore` major versions, and a non-`public`, non-system effective application schema.
- Real PostgreSQL/age acceptance claims require the corresponding environment-gated release checks to run; a skipped gate is not acceptance evidence.

See [Operations](docs/operations.md), [Backup and restore](docs/backup-restore.md), and [Database design](docs/database-design.md).

## Development

```bash
pnpm test
pnpm typecheck
pnpm verify
pnpm verify:release     # requires real PostgreSQL and age prerequisites
pnpm build
pnpm --filter web test
pnpm --filter web build
pnpm e2e
```

Specialized offline and PostgreSQL gate commands are documented in [docs/operations.md](docs/operations.md), [docs/postgres-podman-test.md](docs/postgres-podman-test.md), and `package.json`.

## Documentation

Start with the [documentation index](docs/README.md). Key references:

- [Architecture](docs/architecture.md)
- [Database design](docs/database-design.md)
- [IP-RBAC design](docs/ip-rbac-design.md)
- [Phase 3 status ledger](docs/phase-3-data-retention-plan.md)
- [Backup and restore](docs/backup-restore.md)
- [Operations index](docs/operations.md)
- [Future public IAM plan](docs/identity-access-plan.md)
