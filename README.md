**English** · [简体中文](README.zh-CN.md)

# pi-agent-server

A long-running, session-oriented HTTP/SSE server around the Pi Agent runtime, designed for multi-user access. Project and session management provide supporting organization for work and conversations, alongside streaming task control, persistence, concurrency limits, route RBAC, and configurable tool access. The React/Vite app in `web/` is an optional standalone client; Fastify does not serve it.

> **Status: Release Candidate (RC). Not production-ready.**

## Current boundaries

- **Intranet-focused today:** support for public deployment is planned for a future release.
- **Single instance today:** multi-instance deployment is planned for a future release.
- **Default Pi tools:** `read`, `ls`, `find`, and `grep`. Configure the complete tool list through the `TOOLS` environment variable.
- **Pi extensions:** specify extensions to load with `PI_EXTENSION_PATHS`. If unset, no extensions are loaded. See [Pi extensions](#pi-extensions) below for the supported scope.
- **Add business features as needed:** developers can package extra tools, endpoints, and other features as agent-server plugins and enable them through `PI_PLUGINS`. No configuration is needed otherwise.
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

`dev:real` loads the optional `.env.local` through tsx's `--env-file-if-exists=.env.local`. Copy the tracked template first:

```bash
cp .env.example .env.local
```

The template contains development values for `DATA_DIR`, `PI_ALLOWED_CLIENT_CIDRS`, `PI_DEFAULT_MODEL`, and `PI_DEFAULT_THINKING_LEVEL`; adjust machine-specific paths. `PI_ALLOWED_CLIENT_CIDRS` is required and applies to all routes.

`dev:real` keeps its database under `/tmp/pi-agent-server`; the server verifies but never initializes it. Initialize once before the first run (or after clearing `/tmp`):

```bash
pnpm dev:real:init
```

This runs the offline bootstrap and verifies it back; re-running it is rejected once the database is non-empty. After that, just run `pnpm dev:real`.

The default credential source is `~/.pi/agent/auth.json`. For a deployment, point `PI_AUTH_PATH` at a dedicated service credential file. A runtime default API key may instead be injected with `PI_MODEL_PROVIDER` and `PI_MODEL_API_KEY`.

### Pi extensions

Configure the Pi extensions to load with `PI_EXTENSION_PATHS`:

```bash
PI_EXTENSION_PATHS=/absolute/path/to/pi-extension
```

### Web UI

Start the optional standalone Web UI with `pnpm web`.

## Deployment

To deploy on an intranet server, follow [Operations](docs/operations.md) for installation, configuration, and startup checks.

## API overview

All routes first check the source IP. `/health` and `/readyz` do not require a token. `/metrics` is for operational monitoring and is available only to `admin` and `operator`. If the policy file requires a token for an IP, requests to `/metrics` from that IP must also provide its configured token.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness |
| `GET` | `/readyz` | Process startup and migration-gate readiness |
| `GET` | `/metrics` | Fixed Prometheus process/readiness surface |
| `GET` | `/v1/access` | Check whether the current user has read and write permissions; returns `canRead` and `canWrite` |
| `GET` | `/v1/capabilities/<plugin-id>/access` | Check which features of this plugin the current user can use; response fields are defined by the plugin |
| `GET` | `/v1/models` | Available models and defaults |
| `GET` / `POST` | `/v1/projects` | List or create projects |
| `DELETE` | `/v1/projects/:id` | Logically delete a project |
| `GET` / `POST` | `/v1/sessions` | List or create sessions |
| `PATCH` / `DELETE` | `/v1/sessions/:id` | Rename or logically delete a session |
| `PATCH` | `/v1/sessions/:id/config` | Change model/thinking configuration |
| `POST` | `/v1/sessions/:id/messages` | Submit a prompt (`requestId` required) |
| `GET` | `/v1/sessions/:id/events` | SSE stream; viewer with no live runtime receives `204`. Every turn-related event carries the `requestId` that produced it (`text_delta`, `thinking_delta`, `tool_start`, `tool_update`, `tool_end`, `status`, `usage`, `queued`, `error`, `completed`, `aborted`) |
| `POST` | `/v1/sessions/:id/steer` | Steer a running task |
| `POST` | `/v1/sessions/:id/follow-ups` | Queue a follow-up |
| `POST` | `/v1/sessions/:id/abort` | Abort the task currently running in this session. The request body can be empty; if provided, it must be `{ "requestId": "..." }`, and the task is aborted only when its request ID matches. A mismatch returns `409` and the task keeps running. |
| `GET` | `/v1/sessions/:id/export` | Read-only message snapshot; never creates a runtime |
| `GET` | `/v1/sessions/:id/file-preview?path=<relative>&line=<optional>` | Preview a text file in this session's project directory. `path` is relative to that directory; optional `line` selects a line. Files outside the project directory cannot be read |

### Public API contract v1

- The full v1 request, response, and SSE fields are documented in the [OpenAPI specification](openapi/v1.json); clients can import the corresponding types from `pi-agent-server/contract`. Plugin routes and their fields are defined separately by each plugin; see the [plugin integration guide](docs/plugin-integration.md). Existing v1 behavior and fields remain compatible; additions may be optional, while breaking changes require a new version.
- `GET /v1/access` returns only `{ canRead, canWrite }`: `canRead` means the user can use read-only features, and `canWrite` means they can submit or control work. `GET /v1/capabilities/<plugin-id>/access` reports which features of that plugin the current user can use. See [IP access control](docs/ip-rbac-design.md) for permission settings.
- Use a unique `requestId` for each intended message submission so retries are not processed twice. While the service process is running, reusing an ID with different content returns `409`; this changed-content check is process-local and is not guaranteed across restarts. Message images support PNG, JPEG, and WebP; the service does not compress them.
- `file-preview` takes a path relative to the session's trusted project directory and cannot read outside it. Older sessions without a saved directory snapshot cannot use previews; create a new session to use this feature.

## Access control

Startup requires an explicit CIDR allowlist:

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8
```

The identity is the client IP: by default the direct socket peer IP; when the TCP peer is loopback (`127.0.0.0/8` or `::1`, i.e. a reverse proxy on the same machine, such as nginx forwarding to `127.0.0.1:8080`), the rightmost entry of `X-Forwarded-For` is used instead (nginx appends, so the rightmost entry is the address the proxy actually saw). Missing or unparsable `X-Forwarded-For` falls back to the socket peer IP, and non-loopback peers always ignore it. If the real users arrive through a proxy on the same machine, the allowed CIDRs must cover the user subnets, not just `127.0.0.0/8`. See [docs/ip-rbac-design.md](docs/ip-rbac-design.md) and [ADR 0003](docs/decisions/0003-loopback-proxy-client-ip.md).

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
| `PI_PLUGINS` | unset | Comma-separated ESM specifiers for explicitly loaded trusted in-process plugins; package names or absolute paths to a built entry file (bare-metal deployments use the latter, since `pnpm link` does not survive a `node_modules` rebuild); no directory or `.pi` discovery |
| `PI_EXTENSION_PATHS` | unset | Primary comma-separated list of explicitly loaded Pi SDK extension paths (absolute or `~/…`); no discovery; invalid paths or load failures reject startup. `PI_PROVIDER_EXTENSION_PATHS` is a deprecated compatibility alias: warns before path validation when only it yields a non-empty list; startup rejects when both yield non-empty lists (after trimming and removing empty entries) |
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

For day-to-day operations, use just these two runbooks:

- [Operations](docs/operations.md): production updates, services, administrator IPs, and troubleshooting.
- [Backup and restore](docs/backup-restore.md): keys, scheduled backups, failure checks, recovery drills, and retention.

Development references:

- [Architecture](docs/architecture.md) and [database design](docs/database-design.md)
- [IP access control](docs/ip-rbac-design.md)
- [Plugin integration](docs/plugin-integration.md)
- [ADR index and maintenance rules](docs/decisions/README.md)

[Archived material](docs/archive/) contains historical installation procedures, completed plans, evidence, and optional monitoring/IAM proposals. It is not the current production runbook. The separate documentation index has been removed; this section is the entry point.
