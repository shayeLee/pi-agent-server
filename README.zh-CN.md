[English](README.md) · **简体中文**

# pi-agent-server

基于 Pi Agent Runtime 的长期运行、会话式 HTTP/SSE 服务，核心支持多用户访问。项目与会话用于组织工作和对话，并提供流式任务控制、持久化、并发限制、路由 RBAC 与可配置工具权限。`web/` 中的 React/Vite 应用是可选的独立客户端，Fastify 不托管它。

> **状态：Release Candidate（RC），尚非生产就绪。**

## 特性

- 多用户访问：按客户端 IP 准入，角色 `viewer` / `user` / `operator` / `admin`，默认拒绝；可为精确 IP 绑定 Bearer token。
- 项目与会话管理；Pi 原生会话自动发现并默认共享。
- HTTP/JSON API 与 Server-Sent Events；运行中可追加 `follow-up`、提升为 `steer` 或中止。
- Pi 文本资源：`AGENTS.md` / `CLAUDE.md`、提示词模板与 skills（含 `~/.agents/skills`）按会话项目与服务 agentDir 自动发现。输入框支持 `@` 引用文件，以及 `/compact`、`/reload`、模板与 `skill:` 命令。
- 默认 SQLite，可显式选择 PostgreSQL；对话保存为 Pi JSONL，同一请求重复提交返回已记录的结果。
- 可选的「稿纸」风格 Web UI：账本式对话流、运行状态、统计栏与轨迹 Inspector。

## 当前边界

- **面向内网、单实例运行**：公网部署与多实例在后续版本完善。
- **Pi 工具默认全部授权**：包括 `bash`、`edit`、`write`。只读请设置 `TOOLS=read,ls,find,grep`，并另行落实文件系统 / 进程隔离。见[配置](docs/configuration.md)。
- **扩展与插件需显式启用**：Pi 扩展用 `PI_EXTENSION_PATHS`，agent-server 插件用 `PI_PLUGINS`；不设置则不加载。上下文文件、提示词模板与 skills 自动加载，服务中登记的项目对这些资源一律视为受信任。
- **JSONL 暂不自动清理**：删除项目或会话后，对应的 JSONL 文件仍保留。
- **备份为本机加密备份**：异地容灾仍在规划中。见[备份与恢复](docs/backup-restore.md)。
- **数据库需先初始化**：服务启动只校验、不迁移。首次部署或版本要求升级时，先按[运维文档](docs/operations.md)处理数据库。

Pi SDK 与 pi-ai 固定为 **1.1.0**。

## 快速开始

需要 Node.js >= 22.19.0 与 pnpm。

**Mock 服务**（内存数据库与假 Agent，不需要模型凭证）：

```bash
pnpm mock        # 终端 1
pnpm web:mock    # 终端 2，打开 http://127.0.0.1:5173
```

**从源码启动真实服务**：

```bash
cp .env.example .env.local   # 按本机修改
pnpm dev:real:init           # 首次运行前初始化数据库
pnpm dev:real
pnpm web                     # 可选：Web UI
```

环境变量、凭证与数据目录见[本地开发](docs/development.md)与[配置](docs/configuration.md)；内网部署见[运维文档](docs/operations.md)。

## 文档

除本 README 外，`docs/` 下的文档以中文为主。

| 主题 | 文档 |
| --- | --- |
| 使用 | [Web UI](docs/web-ui.md) · [Pi 原生会话](docs/native-sessions.md) · [子代理会话](docs/subagent-conversations.md) · [设计规范](DESIGN.md) |
| 接口 | [API 概览](docs/api.md) · [OpenAPI 规范](openapi/v1.json) · [控制队列](docs/control-queues.md) · [会话步骤与 Inspector](docs/session-steps.md) · [统计契约](docs/usage-measurement.md) · [插件接入](docs/plugin-integration.md) |
| 部署与运维 | [运维](docs/operations.md) · [配置与访问控制](docs/configuration.md) · [IP 访问控制](docs/ip-rbac-design.md) · [备份与恢复](docs/backup-restore.md) |
| 开发 | [本地开发](docs/development.md) · [测试命令清单](docs/testing.md) · [架构](docs/architecture.md) · [数据库设计](docs/database-design.md) · [SDK 边界](docs/pi-sdk-api.md) · [ADR 索引](docs/decisions/README.md) |

[归档资料](docs/archive/)收录历史安装步骤、已完成计划与验收记录，不作为当前操作手册。
