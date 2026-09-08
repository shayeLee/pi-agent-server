**English** · [简体中文](README.zh-CN.md)

# pi-agent-server

A long-running, session-oriented HTTP/SSE server around the Pi Agent runtime, designed for multi-user access. Project and session management provide supporting organization for work and conversations, alongside streaming task control, persistence, concurrency limits, route RBAC, and configurable tool access. The React/Vite app in `web/` is an optional standalone client; Fastify does not serve it.

> **Status: Release Candidate (RC). Not production-ready.**

## Current boundaries

- **Intranet-focused today:** support for public deployment is planned for a future release.
- **Single instance today:** multi-instance deployment is planned for a future release.
- **Default Pi tools:** `read`, `ls`, `find`, and `grep`. Configure the complete tool list through the `TOOLS` environment variable.
- **Pi Session JSONL files are not cleaned up automatically yet:** deleting a project or session leaves the corresponding JSONL files in place.
- **Local encrypted backups are available:** backup and restore tooling is included; off-site disaster recovery is still planned. See [Backup and restore](docs/backup-restore.md).
- **Initialize the database on first deployment:** follow [Operations](docs/operations.md) before starting the service. If the release notes require a database schema update, follow [Operations](docs/operations.md) to upgrade the database before starting the new service version.

## Highlights

- Multi-user access as a first-class capability.
- Project and session management as supporting capabilities for organizing work and conversations.
- HTTP/JSON API plus Server-Sent Events.
- `steer`, `follow-up`, and `abort` controls while a task is running.
- SQLite by default; explicit PostgreSQL opt-in.
- Conversations are saved as Pi JSONL files, with project, session, and task state kept in the database; repeated requests return the already-recorded result instead of running again.
- Role-based route access control that denies by default: `viewer`, `user`, `operator`, and `admin`. IPs in the allowed range without an explicit profile default to `user`.
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

### Real server from source (development mode)

```bash
pnpm dev:real
```

`dev:real` presets `DATA_DIR=/tmp/pi-agent-server`, `PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8`, and a default model and thinking level (see `package.json`). `PI_ALLOWED_CLIENT_CIDRS` is mandatory and matched against the direct socket peer IP for every route, including probes.

`dev:real` keeps its database under `/tmp/pi-agent-server`; the server verifies but never initializes it. Initialize once before the first run (or after clearing `/tmp`):

```bash
pnpm dev:real:init
```

This runs the offline bootstrap and verifies it back; re-running it is rejected once the database is non-empty. After that, just run `pnpm dev:real`.

The default credential source is `~/.pi/agent/auth.json`. For a deployment, point `PI_AUTH_PATH` at a dedicated service credential file. A runtime default API key may instead be injected with `PI_MODEL_PROVIDER` and `PI_MODEL_API_KEY`.

For a custom setup, set the variables and run `pnpm dev`:

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8
pnpm dev
```

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

All routes first check the source IP. `/health` and `/readyz` do not require a token. `/metrics` is for operational monitoring and is available only to `admin` and `operator`. If the policy file requires a token for an IP, requests to `/metrics` from that IP must also provide its configured token.

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

An unregistered IP inside an allowed CIDR receives `role=user` with token disabled. Tokens cannot bypass CIDR admission, change role, or move between IPs.


## Configuration

| Variable | Current default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `DATA_DIR` | process cwd | JSONL, service agent directory, and default SQLite location |
| `DB_PATH` | `<DATA_DIR>/pi-agent-server.db` | SQLite file |
| `PI_STORAGE_DIALECT` | `sqlite` | `sqlite` or explicit `postgres` |
| `PI_DATABASE_URL` | unset | Required with PostgreSQL |
| `PI_ALLOWED_CLIENT_CIDRS` | **none; required** | Source IP ranges allowed to access the service, for example `127.0.0.0/8` |
| `PI_IP_ACCESS_POLICY_FILE` | unset | Absolute path to an optional policy file that sets roles, disabled status, and token requirements for specific IPs |
| `PI_AUTH_PATH` | `~/.pi/agent/auth.json` | Use a dedicated service file outside development |
| `PI_MODEL_PROVIDER` / `PI_MODEL_API_KEY` | unset | Runtime default-provider credential injection |
| `PI_DEFAULT_MODEL` | unset | `provider/modelId` |
| `PI_DEFAULT_THINKING_LEVEL` | Pi default | `off` through `max` |
| `TOOLS` | `read,ls,find,grep` | Complete comma-separated tool list; replaces the defaults when set, for example `read,ls,find,grep,bash,edit,write` |
| `CORS_ORIGINS` | empty | Web page addresses allowed to call this service from a browser; separate multiple addresses with commas, for example `http://127.0.0.1:5173` |
| `PI_BACKUP_STAGING_ROOT` | per-user private application directory | Temporary working directory for backups or database upgrades; usually does not need to be set |

## Persistence and operations

- Metadata lives in SQLite or PostgreSQL; full conversation history lives in Pi-managed JSONL files.
- DELETE writes a durable cleanup intent to `file_operations`, but the repository supplies only a read-only planner. Physical execution is outside the current scope.
- Backup, restore, migration, reconciliation, and owner-transfer tools are offline commands. They do not start the service or install timers/workers. The same holds for `pi-agent-server-drill`: it gates (preflight), executes an isolated one-shot drill (run), and cleans up isolated run artifacts (cleanup). It never auto-starts the service, installs a timer, or touches formal resources.
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
- [ADR index and maintenance rules](docs/decisions/README.md)
- [ADR 0002: canonical baseline and migration gate](docs/decisions/0002-canonical-baseline-and-migration-gate.md)
- [Backup and restore](docs/backup-restore.md)
- [Operations index](docs/operations.md)
- [Future public IAM plan](docs/identity-access-plan.md)
