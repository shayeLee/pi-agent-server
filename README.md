**English** · [简体中文](README.zh-CN.md)

# pi-agent-server

An Agent Server that turns the Pi Agent runtime into a long-running, session-oriented HTTP/SSE service. It handles request authentication and caller identity resolution, project and session lifecycle, persistence, streaming task control, concurrency, and tool permissions.

Users and integrators can interact with the service through its HTTP/SSE API and build their own UI, workflows, or business systems on top of it. A separate Web UI (built with React and Vite, in `web/`) is included as a standalone client; it is not the only or required UI, and it is not part of the server itself.

> **Status:** Release Candidate (RC)

> **Important limits**
>
> - **PostgreSQL** storage is implemented **and validated by `PI_TEST_PG_URL`-gated real-PostgreSQL integration tests** — the full gated suite (all 45 cases, including the shared repository contract, real unique-constraint mapping, and strict schema preflight added in the final test audit) passed via `pnpm verify:release` on a real PostgreSQL instance. It is only used when enabled explicitly (`PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL`). It is **not production-ready**: there is still no formal data migration, backup, or rollback (RC stage).
> - The web UI is a **separate Web UI, built with React and Vite** (`web/`). The Fastify server does **not** serve `web/dist`; you run the UI yourself (`pnpm web` / `pnpm web:mock`) and open it in a browser.

## Highlights

- **HTTP + SSE API** — streaming answers over Server-Sent Events, with `steer`, `follow-up` and `abort` controls.
- **Sessions & workspaces** — multiple projects (each with its own working directory) and per-user sessions, isolated by identity.
- **Web UI** — manage projects and sessions, pick the model and thinking level, and inspect the live event stream in an inspector pane.
- **Persistence** — full conversation history in Pi JSONL session files; project/session metadata and request idempotency in SQLite (default) or PostgreSQL (explicit opt-in).
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

Then start the service:

```bash
# Terminal 1: API server on http://127.0.0.1:8080
pnpm dev

# Terminal 2: web UI on http://127.0.0.1:5173 (proxies /v1 and /health to 8080)
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

## Data & Storage

- **SQLite (default)** — project/session metadata and request idempotency live in a SQLite file at `DB_PATH` (WAL mode, foreign keys on).
- **Conversation history** — the Pi SDK writes full history as JSONL session files: `<DATA_DIR>/sessions/<sessionId>/` for the default project and `<DATA_DIR>/projects/<projectId>/sessions/<sessionId>` for extra projects. The DB records the JSONL path so sessions are restored after a restart.
- **Server agent directory** — `<DATA_DIR>/.pi-agent` holds server-side agent config (`models.json` etc.) and does not inherit your personal `~/.pi/agent`.
- **Credentials** — default `~/.pi/agent/auth.json`, overridable with `PI_AUTH_PATH`.
- **Schema** — tables/columns/indexes are generated from a single runtime Schema Manifest (`src/storage/schema-manifest.ts`); details in [docs/database-design.md](docs/database-design.md).
- **PostgreSQL** — verified by **`PI_TEST_PG_URL`-gated real-PostgreSQL integration tests** (shared dialect-neutral repository contract, real unique-constraint mapping, old-schema fail-fast); the full gated suite passed via `pnpm verify:release` on a real PostgreSQL instance. Enable it explicitly with `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL`; a blank dialect stays on SQLite and an unknown non-empty dialect fails fast. To re-run the gated suite locally, use the Podman setup in [docs/postgres-podman-test.md](docs/postgres-podman-test.md). Not production-ready: no formal migration/backup/rollback yet.

## Security & Limitations

- Binds to **127.0.0.1** by default; open it up only through a controlled network/firewall.
- Intranet IPs are trusted by **source IP** (no token). The public network requires a Bearer token from the static `TOKENS` mapping; there is **no token-issuance endpoint**.
- **Current authentication scope:** The server relies on a static `TOKENS` environment-variable mapping for public-network Bearer token authentication. There is no user login system, no token-issuance API, and no per-user identity management.
- **Planned improvements (not yet implemented):** Full user login and Identity & Access Management (IAM), encompassing three layers — Authentication (user login), Identity (caller identity resolution beyond source IP), and Authorization (permission checks). Planned capabilities include OAuth/OIDC integration, Access Tokens (the decided auth mechanism; session-based auth is excluded), API Key lifecycle management (generation, rotation, revocation, expiration), fine-grained permission scopes, and audit logging. No timeline or implementation details are committed at this stage. The detailed roadmap (terminology, target architecture, data-model direction, phased work packages, and open decisions) is documented in [docs/identity-access-plan.md](docs/identity-access-plan.md).
- The default tool allowlist is **read-only** (`read`, `ls`, `find`, `grep`); `bash`, `edit` and `write` are disabled unless explicitly listed in `TOOLS`.
- `POST /v1/projects` accepts a client-supplied `cwd` — do **not** expose it on public production deployments, because an authenticated client could create workspaces on arbitrary local paths.
- The web UI keeps tokens **in browser memory only** (no `localStorage`).
- Behind a reverse proxy, set `TRUST_PROXY` to the proxy's concrete IPs (full-trust and CIDR entries are rejected) and `CORS_ORIGINS` for browser clients; otherwise forwarded client IPs stay untrusted and cross-origin SSE is blocked.
- **PG status** — validated by `PI_TEST_PG_URL`-gated real-PG integration tests; the current extended gate (all 45 cases) passed via `pnpm verify:release` on a real PostgreSQL instance. Still **not production-ready**: no formal migration, backup, or rollback — treat as RC-only.

## Development & Testing

```bash
pnpm test               # server tests (vitest)
pnpm typecheck          # TypeScript check (no emit)
pnpm verify             # daily gate: typecheck + test
pnpm test:postgres      # real-PG integration tests only; FAILS (exit 1) when PI_TEST_PG_URL is missing/blank
pnpm verify:release     # full release gate: typecheck + test + test:postgres + build (requires PI_TEST_PG_URL)
pnpm build              # build the server (dist/)

pnpm --filter web test  # web unit tests
pnpm --filter web build # build the web app (tsc -b && vite build)
pnpm e2e                # Playwright end-to-end (starts its own mock backend + Vite server)
```

- **Release gate (P0):** a release must not claim full acceptance while `typecheck` was not run or the PG tests were skipped. `pnpm verify:release` runs `typecheck` + `test` + `test:postgres` + `build`; `release:rc` calls `verify:release` before publishing. `pnpm verify` covers the daily loop (typecheck + test) without requiring a database.
- **PG integration tests vs. plain test skip (keep them distinct):**
  - `pnpm test` (no `PI_TEST_PG_URL`): the `tests/postgres/` group is **skipped** (existing gate; never reported as passing / never connects).
  - `pnpm test:postgres` (no `PI_TEST_PG_URL`): **exits non-zero with a clear reason** (release gate — skipping is not acceptance). Uses a cross-platform Node runner (`scripts/test-postgres.ts`), never prints the connection string.
  - With `PI_TEST_PG_URL` set, both `pnpm test` and `pnpm test:postgres` run the real-PG cases (`tests/postgres/`); use `pnpm verify:release` for the complete acceptance loop.
- **e2e** — not shipped as "green" in this RC; run `pnpm e2e` locally to verify (first run: `pnpm --filter web exec playwright install` to fetch browsers).
- Architecture & core data flow: [docs/architecture.md](docs/architecture.md). Storage design: [docs/database-design.md](docs/database-design.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — architecture and core data flow
- [docs/database-design.md](docs/database-design.md) — SQLite / PostgreSQL schema design
- [docs/pi-sdk-api.md](docs/pi-sdk-api.md) — Pi SDK usage index (the HTTP surface is defined in `src/server/app.ts`)
- [docs/postgres-podman-test.md](docs/postgres-podman-test.md) — local PostgreSQL testing with Podman

Internal phase plans and archived documents (`docs/phase-2-execution-plan.md`, `docs/archive/`) are not user-facing entry points.