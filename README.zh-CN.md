[English](README.md) · **简体中文**

# pi-agent-server

基于 Fastify 与 Pi SDK 构建的长期运行、可扩展的 Pi Agent 服务。它通过安全的 HTTP/SSE 接口提供持久化对话、流式回答、任务控制和可扩展的 Agent 能力。

> **状态：**Release Candidate（RC）

## 特性

- 使用 JSONL 持久化 Pi 会话历史，并用 SQLite 数据库存储索引和元数据；后续计划支持 PostgreSQL 和 MySQL
- 通过 Server-Sent Events（SSE）流式输出，支持 `steer`、`follow-up` 和 `abort` 控制
- 支持 Token 和内网 IP 身份识别、按用户隔离会话以及可配置的并发限制
- 通过显式配置管理可用工具、提示词、后台任务和数据源
- 提供默认的 React Web 界面，用于管理项目、会话、模型设置和事件查看；用户也可使用自定义 GUI 对接 pi-agent-server

## 开发

```bash
pnpm install
pnpm dev             # 启动服务端
pnpm web             # 启动 Web 界面
pnpm test            # 运行服务端测试
pnpm e2e             # 运行端到端测试
```
