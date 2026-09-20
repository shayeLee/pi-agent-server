**English** · [简体中文](README.zh-CN.md)

# pi-agent-server

A long-running, session-oriented HTTP/SSE server around the Pi Agent runtime, designed for multi-user access. Project and session management provide supporting organization for work and conversations, alongside streaming task control, persistence, concurrency limits, route RBAC, and configurable tool access. The React/Vite app in `web/` is an optional standalone client; Fastify does not serve it.

> **Status: Release Candidate (RC). Not production-ready.**

## Current boundaries

- **Intranet-focused today:** support for public deployment is planned for a future release.
- **Single instance today:** multi-instance deployment is planned for a future release.
- **Default Pi tools:** `read`, `ls`, `find`, and `grep`. Configure the complete tool list through the `TOOLS` environment variable.
- **External plugins are explicit and trusted:** set `PI_PLUGINS` to load named in-process ESM plugins. They are an engineering extension boundary, not a sandbox.
- **External provider extensions are explicit and trusted:** set `PI_PROVIDER_EXTENSION_PATHS` to load explicitly listed Pi extension paths that register model providers. Automatic discovery stays disabled (`noExtensions: true`); paths are absolute or `~/…`, comma-separated, and a configured path that fails to load rejects startup. Extension code runs in-process with host permissions — it is an engineering extension boundary, not a sandbox. A trusted extension's process-wide side effects (for example wrapping `globalThis.fetch`) last for the lifetime of the process; the host cannot unload them, and a failed startup exit does not guarantee that arbitrary global side effects are rolled back.
- **Reference images are validated, not compressed, by the host:** `POST /v1/sessions/:id/messages` accepts optional `images: [{ mediaType, base64 }]`. The host only accepts static `image/png`, `image/jpeg`, and `image/webp`, re-checks real magic bytes and header dimensions, and enforces count/size/pixel budgets; it never compresses or transcodes and adds no image upload route or image database. Client-side compression belongs to the calling client.
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

`dev:real` loads the optional, gitignored `.env.local` through tsx's `--env-file-if-exists=.env.local`. Copy the tracked, non-secret template first:

```bash
cp .env.example .env.local
```

The local template contains the development values `DATA_DIR=/tmp/pi-agent-server`, `PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8`, `PI_DEFAULT_MODEL=openai-codex/gpt-5.6-luna`, and `PI_DEFAULT_THINKING_LEVEL=medium`; edit machine-specific paths before use. Existing environment variables take precedence over `.env.local`; file values take precedence over application defaults. `PI_ALLOWED_CLIENT_CIDRS` is mandatory and matched against the client IP for every route, including probes. The client IP is the direct socket peer IP by default, except that a loopback peer (same-host reverse proxy) uses the rightmost `X-Forwarded-For` entry instead. Do not commit `.env.local`, credentials, API keys, or tokens.

`dev:real` keeps its database under `/tmp/pi-agent-server`; the server verifies but never initializes it. Initialize once before the first run (or after clearing `/tmp`):

```bash
pnpm dev:real:init
```

This runs the offline bootstrap and verifies it back; re-running it is rejected once the database is non-empty. After that, just run `pnpm dev:real`.

The default credential source is `~/.pi/agent/auth.json`. For a deployment, point `PI_AUTH_PATH` at a dedicated service credential file. A runtime default API key may instead be injected with `PI_MODEL_PROVIDER` and `PI_MODEL_API_KEY`.

### External provider extensions

An installed Pi extension that only registers a model provider (via `pi.registerProvider`) can be wired into the service without copying its provider implementation:

```bash
# absolute path, or ~/...; several paths are comma-separated
export PI_PROVIDER_EXTENSION_PATHS=~/.pi/packages/pi-workbuddy-connect
```

Semantics:

- **Explicit only:** the host keeps `noExtensions: true` and loads exactly the configured paths through Pi's `additionalExtensionPaths`; it never scans `~/.pi/agent`, the project `.pi/`, or `settings.json`. With the variable unset, no external extension is loaded.
- **Provider registrations reach the host runtime before first use:** extension factories queue `registerProvider` calls, and the host flushes them into its single `ModelRuntime` right after load, so `PI_DEFAULT_MODEL`, plugin mode models, and `GET /v1/models` can resolve them.
- **One resource loader per active session:** each active session (new or restored) gets its own Pi `ResourceLoader` and extension runtime, and keeps it across that session's turns. Startup and per-project system-prompt probes use their own throwaway loaders, so a probe session's dispose can never invalidate a real session's extension runtime; a frozen system prompt is restored by literal override, without re-resolving or appending prompt fragments again. Trusted extension code is therefore loaded once per active session, while a session's provider and provider hooks stay available for its whole lifetime.
- **Extension loading cwd is fixed, so module-level side effects happen once per process:** every loader is created with the service cwd, while the project cwd is passed only to `createAgentSession({ cwd })`. Pi's extension module cache is keyed by the loader cwd, so mixing service and project cwds would re-evaluate extension modules on every switch and replay module-level side effects (for example wrapping `globalThis.fetch`) without bound. Keeping the loader cwd stable evaluates each extension module once per process, still reruns the factory once per active session/probe, and leaves per-project prompt resolution untouched (the prompt's `<cwd>` section comes from the session cwd).
- **Prompt append sources are explicit:** the host always passes an `appendSystemPrompt` to every loader (an empty list when there are no capability fragments), which turns off Pi's automatic discovery of `agentDir/APPEND_SYSTEM.md` and `<cwd>/.pi/APPEND_SYSTEM.md`. A frozen-literal session therefore stays byte-identical after restore, even if those files change on disk in between.
- **Provider streams read tools from the transcript, not a top-level field:** since Pi 0.86.0 the context handed to a provider `streamSimple` is a normalized `TranscriptContext` that carries only `messages`; the system prompt and tool declarations are folded into the leading system message. Reading `context.tools` there yields `undefined`, which would silently make the DeepSeek V4 textual-protocol adapter fail open (authorized tool names would be converted into executable native calls). The adapter therefore resolves the tool set with `getCurrentTools(context.messages)` and pins its parameter type to `TranscriptContext`, with a regression test that fails if the old read returns.
- **Hosted model-failback:** a real session binds extensions once after its session-local bridge is installed. A compatible `model-failback` extension synchronously obtains that EventBus transport, queues continuation through the public SDK `session.steer()` API, and never awaits `ExtensionAPI.sendUserMessage()` (which is void). Abort clears the SDK queue before and after cancellation; while the bridge reports a failback attempt, `POST /abort` returns `409` with exact error code `MODEL_FAILBACK_IN_PROGRESS`, which clients must distinguish from an ordinary inactive-task conflict. If the extension cannot persist its continuation marker, it keeps Pi's model-change projection but fails closed: it reports `failed` and does not queue an unidentifiable continuation.
- **Fail-fast:** a configured path that does not exist, cannot be imported, does not export a factory, or yields **no extension entry point at all** (an empty directory, a manifest whose `pi.extensions` entries are missing, an empty `extensions/` subdirectory) rejects startup, as does a registration that the Pi runtime rejects. Errors report the host-configured path and the provider name only; they never echo the extension's or the Pi runtime's original error text, and they add no `cause`.
- **Absolute paths only:** relative entries are rejected before any resource is created; `~/…` is expanded against the service account home.
- **Trusted boundary:** extension code runs in-process with host permissions and can subscribe to provider hooks such as `before_provider_request`. It is not a sandbox and must be reviewed like a plugin.

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
| `GET` | `/v1/access` | Minimal access-capability projection `{canRead, canWrite}` derived from the central RBAC matrix |
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
| `POST` | `/v1/sessions/:id/abort` | Abort a task. The body may be omitted for legacy behavior; when supplied, it must be exactly `{ "requestId": "..." }` and aborts only that current request. A non-matching requestId returns `409` without cancelling the task. |
| `GET` | `/v1/sessions/:id/export` | Read-only message snapshot; never creates a runtime |
| `GET` | `/v1/sessions/:id/file-preview?path=<relative>&line=<optional>` | Owner-scoped, bounded UTF-8 project-text preview under the session's frozen canonical root; caller never supplies a root |

### Public API contract v1

The host publishes the v1 contract artifacts; it does not claim to be the single source of truth for consumers. Consumers should import request/response/SSE types from `pi-agent-server/contract`. The fixed OpenAPI document is available at `pi-agent-server/openapi/v1.json`; its checked-in source is `openapi/v1.json` and `npm run generate:openapi` deterministically regenerates it. Dynamic trusted-plugin routes are intentionally outside this host contract.

Consumers pin the published version they depend on and compare it in their own local tests. Cross-repository comparison of the artifacts is a manual/release-process step; this host cannot verify it.

Request validation semantics: Fastify validates bodies and params with its AJV baseline, not the strict `additionalProperties: false` reading of the schemas. Declared types are coerced (`coerceTypes: 'array'`, so a numeric or single-element-array `title` is accepted and becomes a string) and undeclared fields are silently stripped (`removeAdditional: true`) instead of returning `400`. A `400` therefore reports a missing required field or an uncoercible/out-of-range value, never a wrong scalar type or an unknown field. `POST /v1/sessions/:id/abort` is the one exception: it has no AJV schema and its hand-written parser rejects unknown fields and non-string values with `400`. The document level and every AJV-validated operation with a request body carry `x-pi-request-validation: { coerceTypes: true, removeAdditional: "silent-strip" }` stating this.

Within v1, existing operations, fields, status meanings, and SSE event data remain compatible; additive optional fields or operations may be introduced. A breaking change requires a new versioned contract/path rather than changing v1. The running API in `src/server/app.ts` remains the implementation authority during RC.

### Trusted-plugin session titles

The plugin `PluginSessionApi.getMessages(sessionId)` reads only the authenticated owner's exported `messages`, returning `null` for a missing/non-owned session; it never creates a runtime/provider and exposes neither timeline nor thinking. `setTitle({ sessionId, title, onlyIfEmpty?: boolean })` updates only that owner's host-session metadata and returns the resulting/current session, or `null`. With `onlyIfEmpty: true`, the store performs an atomic empty-title CAS, so an automatic title cannot overwrite a concurrent user rename. They are plugin contracts, not public v1 HTTP operations. Titles are trimmed non-empty plain text without illegal control characters, up to 80 UTF-16 code units; UIs must render them as text, never HTML.

Title policy belongs to the plugin that understands the mode and its data: after it has accepted the first valid user message, it may persist a derived title in its own mode-session record and call `setTitle` with `onlyIfEmpty: true`, including when the later model turn errors or is stopped. It must not name an unsubmitted/rejected message, overwrite a user-custom title, use model output, or infer message presence from `conversation_ref`. A plugin must unwrap its own `ONEV_CONTEXT` envelope from the real first user message before deriving the first-question text; the host deliberately does not parse plugin business envelopes. Image-only first messages use the plugin's explicit image-session default title.

`GET /v1/sessions` intentionally has no `hasMessages` or `messageCount`: it is metadata-only and `conversation_ref` is not evidence of a submitted user message. A UI that must hide historical empty sessions must hydrate `GET /v1/sessions/:id/export` and determine this from the real exported messages (with the corresponding per-session read cost), or consume a plugin list summary whose `hasMessages`/`messageCount` is backed by the plugin's persisted accepted-message state. It must not substitute a failed/empty export or any reference field as evidence.

### Access capability projection

`GET /v1/access` returns the minimal fixed body `{ canRead, canWrite }`, derived from the central route-permission matrix (`ROUTE_PERMISSIONS` + `evaluateRouteAuthorization`) rather than being hardcoded. It never returns the caller's `role`, IP, or token.

- `canRead` is `true` when every read permission (session list/export/events and `capability:read`) is allowed for the role: `viewer`, `user`, and `admin`.
- `canWrite` is `true` when every write/control permission (`sessions:send-message`, `sessions:control`, `capability:write`) is allowed: `user` and `admin`.
- `operator` is denied on the whole `/v1` surface, so it receives the fixed `403` and no projection.

The endpoint uses the same read RBAC as the other read-only `GET` routes and is subject to the same token and CORS rules. If the matrix ever diverges, the boolean is derived conservatively (never over-reports write access), so an access-control UI can safely hide write actions.

### Message input and image attachments

- `POST /v1/sessions/:id/messages` requires a non-empty `requestId`. `prompt` is normally non-empty, but may be empty when at least one image passes authoritative validation (image-only messages). Both fields are bounded in length (128 and 32,768 UTF-16 code units) and rejected if they contain illegal control characters.
- Optional `images: [{ mediaType, base64 }]` carries reference images. Supported `mediaType` values are `image/png`, `image/jpeg`, and `image/webp`. The host validates canonical base64, real magic bytes, header dimensions, MIME consistency, and count/size/pixel budgets before the request reaches the session runtime. Invalid images return `400` with a fixed message that never echoes the payload.
- The host does not compress or transcode images; clients should compress before submitting. PNG/JPEG/WebP are passed through byte-for-byte to the Pi SDK image content.
- Reusing the same `requestId` with different content returns `409` instead of silently returning the earlier result (`requestId` is an idempotency key). This in-process check cannot detect a payload change across a process restart yet, because the persisted idempotency record stores only the terminal result.
- `GET /v1/sessions/:id/export` projects supported user-message images as an optional `images: [{ mediaType, base64 }]` field, subject to the same validation and a bounded budget; malformed or over-budget image blocks are omitted rather than failing the export. Live-session and read-only JSONL exports share the same projection and are byte-for-byte identical.
- `GET /v1/sessions/:id/file-preview?path=<relative>&line=<optional>` is read-only for viewer/user/admin and owner-scoped. Its root is the canonical path and device/inode identity frozen in that owned session's JSONL at creation; it never falls back to mutable project/default cwd. Legacy sessions without this snapshot return the ordinary fixed unavailable/not-found response: create a new session to use preview. It rejects absolute/traversal, static root/ancestor/leaf symlinks or identity changes, sensitive credential names (`.env*`, `auth.json`, `.npmrc`, `key`, credential/secret names including matching Unicode names), non-regular/binary/non-UTF-8 files, and files over 262,144 bytes. It opens only `O_NOFOLLOW|O_NONBLOCK` regular descriptors and reads at most 262,145 bytes, returning `{ path, content, lineCount, requestedLine? }`; `line` is a positive in-range 1-based client scroll target. All preview failures use fixed codes and never disclose filesystem paths.
- This is a compatibility hardening measure for **trusted, service-maintained local project directories** on macOS and Linux. Node has no portable descriptor-relative `openat` walk, so it is not strict TOCTOU/ABA isolation against a malicious concurrent process, and it makes no Linux `/proc` security-strength claim. It does not turn a trusted local directory into permission to read arbitrary user files or bypass filesystem ownership/permissions.


## Access control

Startup requires an explicit CIDR allowlist:

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8
```

The identity is the client IP: by default the direct socket peer IP; when the TCP peer is loopback (`127.0.0.0/8` or `::1`, i.e. a same-host reverse proxy such as nginx forwarding to `127.0.0.1:8080`), the rightmost entry of `X-Forwarded-For` is used instead (nginx appends, so the rightmost entry is the address the proxy actually saw). Missing or unparsable `X-Forwarded-For` falls back to the socket peer IP, and non-loopback peers always ignore it. If the real users arrive through a same-host proxy, the allowed CIDRs must cover the user subnets, not just `127.0.0.0/8`. See [docs/ip-rbac-design.md](docs/ip-rbac-design.md) and [ADR 0003](docs/decisions/0003-loopback-proxy-client-ip.md).

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
| `PI_PROVIDER_EXTENSION_PATHS` | unset | Comma-separated absolute (or `~/…`) paths to explicitly loaded trusted Pi extensions that register model providers; no automatic discovery, and a configured path that fails to load rejects startup |
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
- [ONEV bare-metal deployment](docs/onev-bare-metal-deployment.md)
- [Future public IAM plan](docs/identity-access-plan.md)
