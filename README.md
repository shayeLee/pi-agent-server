**English** · [简体中文](README.zh-CN.md)

# pi-agent-server

A long-running, session-oriented HTTP/SSE server around the Pi Agent runtime, designed for multi-user access. Project and session management provide supporting organization for work and conversations, alongside streaming task control, persistence, concurrency limits, route RBAC, and configurable tool access. The React/Vite app in `web/` is an optional standalone client; Fastify does not serve it.

> **Status: Release Candidate (RC). Not production-ready.**

## Current boundaries

- **Intranet-focused today:** support for public deployment is planned for a future release.
- **Single instance today:** multi-instance deployment is planned for a future release.
- **Default Pi tool authorization:** when `TOOLS` is unset or empty/blank, all available built-in and explicitly loaded extension/plugin tools are allowed; Pi retains its tool activation and session restore behavior. Plain-name `TOOLS` is the complete whitelist across all tool sources; modifier-only lists resolve to a whitelist (see Configuration). **Risk:** the default permits command execution and file writes (including `bash`, `edit`, and `write`); use `TOOLS=read,ls,find,grep` for a read-only tool selection and enforce filesystem/process isolation separately. HTTP RBAC and file authorization are unchanged.
- **Pi extensions:** specify extensions to load with `PI_EXTENSION_PATHS`. If unset, no extensions are loaded. See [Pi extensions](#pi-extensions) below for the supported scope.
- **Add business features as needed:** developers can package extra tools, endpoints, and other features as agent-server plugins and enable them through `PI_PLUGINS`. No configuration is needed otherwise.
- **Pi Session JSONL files are not cleaned up automatically yet:** deleting a project or session leaves the corresponding JSONL files in place.
- **Local encrypted backups are available:** backup and restore tooling is included; off-site disaster recovery is still planned. Interrupted runs are not automatically resumed: stop writers, verify and remove only that run's artifacts, then restart; native restore never overwrites existing files. See [Backup and restore](docs/backup-restore.md).
- **Initialize the database on first deployment:** follow [Operations](docs/operations.md) before starting the service. If the release notes require a database schema update, follow [Operations](docs/operations.md) to upgrade the database before starting the new service version.

Pi SDK and pi-ai are pinned to **1.1.0**; this SDK upgrade needs no database migration (the existing native-session v2 requirement below is unchanged). Optional `durationMs` on SSE `tool_end` and export `tool_result` is SDK-measured tool execution time, not child-agent runtime or model throughput; old missing values remain unknown. Loop/turn counters keep their actual-execution meaning. See [SDK boundaries](docs/pi-sdk-api.md) and [measurement contracts](docs/usage-measurement.md).

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

The template explicitly sets the development `DATA_DIR=/tmp/pi-agent-server` (along with `PI_ALLOWED_CLIENT_CIDRS`, `PI_DEFAULT_MODEL`, and `PI_DEFAULT_THINKING_LEVEL`); adjust machine-specific values. If `DATA_DIR` is unset or blank, the server defaults to `~/.pi/agent`. `PI_ALLOWED_CLIENT_CIDRS` is required and applies to all routes.

`dev:real` uses the resolved `DATA_DIR` and `DB_PATH`; the server verifies but never initializes the database. Initialize an empty target before the first run:

```bash
pnpm dev:real:init
```

`dev:real:init` loads the same optional `.env.local` as `dev:real` (existing process environment wins) and shares its storage resolver: unset/blank `DATA_DIR` defaults to `~/.pi/agent`, and `DB_PATH` overrides the default `<DATA_DIR>/pi-agent-server.db`. The `/tmp` path in the template is an explicit development example, not a hardcoded default. For SQLite, an existing database is first checked with the official read-only schema/ledger verify engine on a temporary DB/WAL/SHM snapshot, cleaned on success or failure. A valid head reports “already initialized” and exits successfully without writes; only absent/completely empty targets are bootstrapped and verified. Non-empty targets without a valid ledger are refused without adoption, deletion or repair; valid older versions require an explicit offline migration, never automatic apply. PostgreSQL requires the explicit offline migration CLI. After initialization, just run `pnpm dev:real`.

The default credential source is `~/.pi/agent/auth.json`. For a deployment, point `PI_AUTH_PATH` at a dedicated service credential file. A runtime default API key may instead be injected with `PI_MODEL_PROVIDER` and `PI_MODEL_API_KEY`.

### Pi extensions

Configure the Pi extensions to load with `PI_EXTENSION_PATHS`:

```bash
PI_EXTENSION_PATHS=/absolute/path/to/pi-extension
```

### Native Pi sessions (shared by default)

Listing projects or sessions discovers native **v3** JSONL and indexes the original files, automatically registering eligible canonical workspaces from verified headers (never decoding directory names into cwd authorization); the default cwd reuses the default project. Other owners' private sessions/projects are not directly exposed. These sessions are shared with **all network-admitted users**, subject to unchanged route RBAC; existing Web-created sessions remain owner-private. Writable users can jointly continue/control/abort a shared session. The API adds optional `visibility` (`shared`/`private`) and `origin` (`native`/`managed`); older clients can still list/open sessions. Request IDs are shared-session-wide and actor-bound: another user's reuse returns `409`, not their result.

Discovery does not copy, migrate or delete source files. One source has one server session/runtime; logical deletion leaves a durable tombstone. Display priority is Web rename, latest native name, then first prompt. New project registrations reject canonical cwd duplicates (including symlink aliases and the default cwd) with `409`; existing duplicates remain.

`PI_SESSION_SHARE_EXCLUDE_CWDS` is comma-separated, trimmed and stripped of empty entries; unset/empty excludes nothing. Use at most 64 existing absolute directories; matching is **exact canonical cwd**, not a prefix. Invalid configuration rejects startup; directory replacement or alias retargeting fails closed for shared access, including active streams. Restart after changes; private-session access and originals are preserved.

`PI_SESSION_SOURCE_DIR` is the unified CLI/new Web-private JSONL root: by default `PI_CODING_AGENT_DIR/sessions`, otherwise `~/.pi/agent/sessions`, independent of server `PI_AGENT_DIR` and `DATA_DIR`. Set it explicitly for isolated storage. New Web sessions use the native encoded-cwd layout but remain private/managed, including in share-excluded cwds; old server-ID references remain readable without moving files. Source claims and tombstones prevent private files from being rediscovered as shared. **Do not use the CLI and server concurrently on a source file:** there is no cross-process lock. See [Architecture](docs/architecture.md) for FD validation and append boundaries.

Backup includes registered native/private source bytes and tombstones, not just the index; missing or invalid active sources fail closed. Restore requires an explicit native target root and identity cwd mapping and never overwrites files. Interrupted restore requires verified cleanup before retry; see [Backup and restore](docs/backup-restore.md). Apply the additive database v2 migration offline before restart; startup remains verify-only.

Automatic discovery registers verified, eligible workspaces as system-administered projects. `GET /v1/projects` lists only projects with an actor-visible session, including filtering the default; stored projects/files are not deleted. Writable actors may create their own private sessions in a shared project (`canCreateSession`), without gaining project mutation or other actors' attachment access. Exclusions revoke shared access but preserve access through one's own private sessions. Project rename/delete remain owner-only. Explicit creation returns an empty draft retained by Web for its first send; an empty list still permits first send to the default project. See [Database design](docs/database-design.md) for attribution and storage rules.

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
| `POST` | `/v1/sessions/:id/steer` | Steer a running task; correlated requests return empty `202`, consumption is confirmed by SSE, not HTTP admission. See [Steering confirmation](docs/steering-confirmation.md) |
| `POST` | `/v1/sessions/:id/follow-ups` | Queue a follow-up |
| `POST` | `/v1/sessions/:id/abort` | Abort the task currently running in this session. The request body can be empty; if provided, it must be `{ "requestId": "..." }`, and the task is aborted only when its request ID matches. A mismatch returns `409` and the task keeps running. |
| `GET` | `/v1/sessions/:id/export` | Read-only message snapshot; never creates a runtime |
| `GET` | `/v1/sessions/:id/file-preview?path=<relative>&line=<optional>` | Preview a text file in this session's project directory. `path` is relative to that directory; optional `line` selects a line. Files outside the project directory cannot be read |

### Public API contract v1

- The full v1 request, response, and SSE fields are documented in the [OpenAPI specification](openapi/v1.json); clients can import the corresponding types from `pi-agent-server/contract`. Plugin routes and their fields are defined separately by each plugin; see the [plugin integration guide](docs/plugin-integration.md). Existing v1 behavior and fields remain compatible; additions may be optional, while breaking changes require a new version.
- `GET /v1/access` returns only `{ canRead, canWrite }`: `canRead` means the user can use read-only features, and `canWrite` means they can submit or control work. `GET /v1/capabilities/<plugin-id>/access` reports which features of that plugin the current user can use. See [IP access control](docs/ip-rbac-design.md) for permission settings.
- Use a unique `requestId` for each intended message submission. Persisted fingerprints reject changed content with `409` across restarts; older records without fingerprints cannot guarantee this check. Shared-session IDs are also actor-bound. Message images support PNG, JPEG, and WebP; the service does not compress them. Non-image uploads require explicit storage and quota configuration; see [Attachment uploads](docs/attachment-uploads.md).
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
| `DATA_DIR` | `~/.pi/agent` | Service data, legacy JSONL and default SQLite location; does not override the unified session source root |
| `PI_SESSION_SOURCE_DIR` | CLI agent directory + `/sessions` | Unified CLI/new Web-private JSONL root; independent of `DATA_DIR`/server `PI_AGENT_DIR`; explicitly override for isolated storage |
| `PI_SESSION_SHARE_EXCLUDE_CWDS` | unset (share all eligible projects) | Comma split/trim/remove-empty; exact canonical cwd exclusions; invalid directories fail closed; restart after changes |
| `DB_PATH` | `<DATA_DIR>/pi-agent-server.db` | SQLite file |
| `PI_STORAGE_DIALECT` | `sqlite` | `sqlite` or explicit `postgres` |
| `PI_DATABASE_URL` | unset | Required with PostgreSQL |
| `PI_ALLOWED_CLIENT_CIDRS` | **none; required** | Source IP ranges allowed to access the service, for example `127.0.0.0/8` |
| `PI_IP_ACCESS_POLICY_FILE` | unset | Absolute path to an optional policy file that sets roles, disabled status, and token requirements for specific IPs |
| `PI_AUTH_PATH` | `~/.pi/agent/auth.json` | Use a dedicated service file outside development |
| `PI_MODEL_PROVIDER` / `PI_MODEL_API_KEY` | unset | Runtime default-provider credential injection |
| `PI_DEFAULT_MODEL` | unset | `provider/modelId` |
| `PI_DEFAULT_THINKING_LEVEL` | Pi default | `off` through `max` |
| `PI_SYSTEM_PROMPT` | Pi default prompt | Optional whole system prompt override; existing semantics unchanged |
| `PI_APPEND_SYSTEM` | unset | Literal additional system prompt text, **not a path**; blank adds nothing. Applied before file text and capability fragments. Restart and create a new session after changes; see [SDK prompt boundaries](docs/pi-sdk-api.md#35-资源加载与系统提示词安全边界). |
| `PI_APPEND_SYSTEM_FILE` | unset | Explicit UTF-8 file read once at startup; relative paths use service-start cwd, no `~` expansion. Invalid files reject startup. Restart and create a new session after changes; frozen prompts stay unchanged. No automatic `APPEND_SYSTEM.md` discovery. |
| `TOOLS` | All tools allowed | Trusted service configuration, not session input. Plain names form a complete whitelist, including extension/plugin tools. Modifier-only `+name,-name` modifies Pi's default selection (`read,bash,edit,write`) in order, then freezes it as the host whitelist; e.g. `-bash,+custom_tool` retains read/edit/write and permits the registered custom tool. Mixed plain/modifier lists or modifier wildcards fail startup. Unset/blank/only commas allows all; programmatic `StartConfig.tools=[]` disables all. |
| `PI_PLUGINS` | unset | Comma-separated ESM specifiers for explicitly loaded trusted in-process plugins; package names or absolute paths to a built entry file (bare-metal deployments use the latter, since `pnpm link` does not survive a `node_modules` rebuild); no directory or `.pi` discovery |
| `PI_EXTENSION_PATHS` | unset | Primary comma-separated list of explicitly loaded Pi SDK extension paths (absolute or `~/…`); no discovery; invalid paths or load failures reject startup. `PI_PROVIDER_EXTENSION_PATHS` is a deprecated compatibility alias: warns before path validation when only it yields a non-empty list; startup rejects when both yield non-empty lists (after trimming and removing empty entries) |
| `CORS_ORIGINS` | empty | Web page addresses allowed to call this service from a browser; separate multiple addresses with commas, for example `http://127.0.0.1:5173` |
| `PI_BACKUP_STAGING_ROOT` | per-user private application directory | Temporary working directory for backups or database upgrades; usually does not need to be set |

## Persistence and operations

- Metadata lives in SQLite or PostgreSQL; full conversation history lives in Pi-managed JSONL files.
- Managed-session DELETE writes a durable cleanup intent to `file_operations`, but the repository supplies only a read-only planner. Physical execution is outside the current scope. Native-session DELETE only tombstones the server index and never schedules source-file deletion.
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
