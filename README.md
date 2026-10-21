**English** · [简体中文](README.zh-CN.md)

# pi-agent-server

A long-running, session-based HTTP/SSE service built on the Pi Agent Runtime, with multi-user access as a core capability. Projects and sessions organize work and conversations; the service provides streaming task control, persistence, concurrency limits, route RBAC, and configurable tool permissions. The React/Vite app in `web/` is an optional standalone client; Fastify does not host it.

> **Status: Release Candidate (RC), not yet production-ready.**

## Highlights

- Multi-user access: admission by client IP, roles `viewer` / `user` / `operator` / `admin`, deny by default; Bearer tokens can be bound to exact IPs.
- Project and session management; native Pi sessions are discovered automatically and shared by default.
- HTTP/JSON API and Server-Sent Events; while a task runs you can queue a `follow-up`, promote it to `steer`, or abort.
- Pi's text resources: `AGENTS.md` / `CLAUDE.md`, prompt templates and skills (including `~/.agents/skills`) are discovered from the session project and the service agentDir. The composer supports `@` file references and the `/compact`, `/reload`, template and `skill:` commands, plus commands registered by the explicitly loaded Pi extensions (such as `/antigravity.usage`); their output is kept in the session as a SYS entry and is not sent to the model. When such a command asks a question (select, confirm, text input), every page with the session open shows it above the composer and the first answer wins; terminal-only UI (`ctx.ui.custom`) is not available on the Web.
- Shared MCP servers come from Pi's global `mcp.json` (`~/.pi/agent/mcp.json`, written by `pi mcp add` or TUI's `/mcp`; stdio and HTTP), re-read when it changes, no restart; admins can also add, edit and remove them in the Web UI (`/v1/mcp/shared`, written back to the same file): project owners enable and tighten these servers per project (`/v1/projects/:id/mcp`, migration v4; a setting stops applying when the server behind the name changes, migration v6); tools are reached through codemode by default, with scripts queued and time-limited. The Web UI opens the current project's MCP settings panel from the Settings menu at the bottom of the sidebar, and codemode cards list the tool calls made inside the script. An HTTP server with `oauth` uses each user's own authorization instead (dynamic client registration, migration v5; needs `PI_PUBLIC_URL` and `PI_MCP_TOKEN_KEY_FILE`): users connect from the MCP panel, and only their own private sessions use that identity. See the [MCP integration design](docs/mcp-integration.md).
- Model sign-in like Pi TUI's `/login` and `/logout`: admins sign in with a provider account (OAuth) or enter an API key from "Model sign-in" in the Settings menu, and remove stored credentials (`/v1/provider-auth`). Credentials go to Pi's `auth.json`, shared with the `pi` CLI, and apply to new messages without a restart. OAuth callbacks land on the server's own localhost; when the Web UI is opened from another machine, paste the final redirect URL into the panel.
- Agent settings like Pi TUI's `/settings`: auto-compaction, auto-retry (with the most retries) and a default thinking level per model, read from Pi's global `settings.json` in the agentDir and shared with the `pi` CLI. Everyone can see them under "Agent settings" in the Settings menu; admins change them there (`/v1/settings`), and only these fields are written, with other fields in the file kept. Sessions also follow the compaction thresholds in that file (`compaction.reserveTokens`, `keepRecentTokens` and per-model `modelOverrides`), as the CLI does; these are not editable on the Web. Running sessions pick a change up within a few seconds. A new session, or switching a session to another model, uses that model's own thinking level unless one is chosen. Before this, sessions ignored `settings.json`; values set there with the `pi` CLI now apply to Web sessions as well.
- SQLite by default, PostgreSQL by explicit choice; conversations are saved as Pi JSONL, and a repeated request returns the recorded result.
- Optional "Ledger"-style Web UI: ledger conversation, run state, stats bar and trace Inspector, plus a lively line-drawn cat companion that greets you on a blank session (with a line written by the default model; `PI_COMPANION_GREETING=off` uses local lines only) and reacts to runs and typing; its name, voice and docked state are kept per user on the server (migration v3).

## Current boundaries

- **Intranet, single instance**: public deployment and multiple instances come in later versions.
- **All Pi tools are allowed by default**, including `bash`, `edit` and `write`. For read-only use set `TOOLS=read,ls,find,grep` and add filesystem / process isolation separately. See [configuration](docs/configuration.md).
- **MCP credentials are shared identities unless a server uses per-user OAuth**: a shared server whose credentials are in `mcp.json` (or the environment variables it references) acts as one identity for every project that enables it. Per-user OAuth credentials belong to the client IP (there are no accounts), so everyone behind the same IP shares them. They are encrypted in the database, but `bash` (below) can read `mcp.json` and the token key file like any file the service user can read. Adding a stdio server in the Web UI runs that command on the server, so only admins can edit shared MCP. Most authorization servers accept only https or loopback callbacks, so a LAN deployment reached by IP needs HTTPS to connect.
- **`bash` runs with the service's identity**: it inherits the service process's full environment (provider API keys included) and can read any file the service user can read. Granting `bash` means trusting every user with those credentials; true isolation requires not granting `bash`, or running it as a separate user / in a sandbox. With an explicit `TOOLS` allowlist, MCP tools are only authorized by `mcp__*` entries, also for calls made from inside codemode.
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
