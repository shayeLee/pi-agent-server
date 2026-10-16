**English** · [简体中文](README.zh-CN.md)

# pi-agent-server

A long-running, session-based HTTP/SSE service built on the Pi Agent Runtime, with multi-user access as a core capability. Projects and sessions organize work and conversations; the service provides streaming task control, persistence, concurrency limits, route RBAC, and configurable tool permissions. The React/Vite app in `web/` is an optional standalone client; Fastify does not host it.

> **Status: Release Candidate (RC), not yet production-ready.**

## Highlights

- Multi-user access: admission by client IP, roles `viewer` / `user` / `operator` / `admin`, deny by default; Bearer tokens can be bound to exact IPs.
- Project and session management; native Pi sessions are discovered automatically and shared by default.
- HTTP/JSON API and Server-Sent Events; while a task runs you can queue a `follow-up`, promote it to `steer`, or abort.
- Pi's text resources: `AGENTS.md` / `CLAUDE.md`, prompt templates and skills (including `~/.agents/skills`) are discovered from the session project and the service agentDir. The composer supports `@` file references and the `/compact`, `/reload`, template and `skill:` commands.
- SQLite by default, PostgreSQL by explicit choice; conversations are saved as Pi JSONL, and a repeated request returns the recorded result.
- Optional "Ledger"-style Web UI: ledger conversation, run state, stats bar and trace Inspector.

## Current boundaries

- **Intranet, single instance**: public deployment and multiple instances come in later versions.
- **All Pi tools are allowed by default**, including `bash`, `edit` and `write`. For read-only use set `TOOLS=read,ls,find,grep` and add filesystem / process isolation separately. See [configuration](docs/configuration.md).
- **Extensions and plugins must be enabled explicitly**: Pi extensions via `PI_EXTENSION_PATHS`, agent-server plugins via `PI_PLUGINS`; nothing loads when unset. Context files, prompt templates and skills are loaded automatically, and every project registered with the service is trusted for them.
- **JSONL files are not cleaned up yet**: deleting a project or session keeps its JSONL files.
- **Backups are local and encrypted**: off-site disaster recovery is still planned. See [backup and restore](docs/backup-restore.md).
- **Initialize the database first**: startup only verifies, never migrates. For a first deployment or a release that requires an upgrade, handle the database per the [operations guide](docs/operations.md) first.

Pi SDK and pi-ai are pinned to **1.1.0**.

## Quick start

Requires Node.js >= 22.19.0 and pnpm.

**Mock server** (in-memory database and a fake agent, no model credentials needed):

```bash
pnpm mock        # terminal 1
pnpm web:mock    # terminal 2, then open http://127.0.0.1:5173
```

**Real server from source**:

```bash
cp .env.example .env.local   # adjust for this machine
pnpm dev:real:init           # initialize the database before the first run
pnpm dev:real
pnpm web                     # optional: Web UI
```

Environment variables, credentials and data directories are covered in [local development](docs/development.md) and [configuration](docs/configuration.md); for intranet deployment see the [operations guide](docs/operations.md).

## Documentation

Apart from this README, the documents under `docs/` are mostly in Chinese.

| Topic | Documents |
| --- | --- |
| Using | [Web UI](docs/web-ui.md) · [Native Pi sessions](docs/native-sessions.md) · [Subagent conversations](docs/subagent-conversations.md) · [Design spec](DESIGN.md) |
| Interfaces | [API overview](docs/api.md) · [OpenAPI spec](openapi/v1.json) · [Control queues](docs/control-queues.md) · [Session steps and Inspector](docs/session-steps.md) · [Usage measurement](docs/usage-measurement.md) · [Plugin integration](docs/plugin-integration.md) |
| Deployment and operations | [Operations](docs/operations.md) · [Configuration and access control](docs/configuration.md) · [IP access control](docs/ip-rbac-design.md) · [Backup and restore](docs/backup-restore.md) |
| Development | [Local development](docs/development.md) · [Testing commands](docs/testing.md) · [Architecture](docs/architecture.md) · [Database design](docs/database-design.md) · [SDK boundaries](docs/pi-sdk-api.md) · [ADR index](docs/decisions/README.md) |

The [archive](docs/archive/) keeps historical install steps, completed plans and acceptance records; it is not the current operations manual.
