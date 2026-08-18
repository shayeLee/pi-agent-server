**English** · [简体中文](README.zh-CN.md)

# pi-agent-server

A long-running, extensible Pi Agent service built with Fastify and the Pi SDK. It provides a secure HTTP/SSE interface for persistent conversations, streaming responses, task control, and extensible Agent capabilities.

> **Status:** Release Candidate (RC)

## Highlights

- Pi session history persisted in JSONL, with SQLite database storage for indexes and metadata; PostgreSQL and MySQL support is planned
- Streaming responses over Server-Sent Events (SSE), with `steer`, `follow-up`, and `abort` controls
- Token and intranet-IP identity handling, per-user session isolation, and configurable concurrency limits
- Explicit configuration for available tools, prompts, background workers, and data sources
- A default React web interface for projects, sessions, model settings, and event inspection; custom GUIs can also use pi-agent-server

## Development

```bash
pnpm install
pnpm dev             # Start the server
pnpm web             # Start the web UI
pnpm test            # Run server tests
pnpm e2e             # Run end-to-end tests
```
