[English](README.md) · **简体中文**

# pi-agent-server

基于 Pi Agent Runtime 的长期运行、会话式 HTTP/SSE 服务，核心支持多用户访问。项目与会话用于组织工作和对话，并提供流式任务控制、持久化、并发限制、路由 RBAC 与可配置工具权限。`web/` 中的 React/Vite 应用是可选的独立客户端，Fastify 不托管它。

> **状态：Release Candidate（RC），尚非生产就绪。**

## 特性

- 多用户访问：按客户端 IP 准入，角色 `viewer` / `user` / `operator` / `admin`，默认拒绝。默认一个客户端 IP 就是一个用户，可为精确 IP 绑定 Bearer token；设置 `PI_AUTH_MODE=accounts` 后改为账号登录（浏览器登录，脚本和 Claude Desktop 桥接用个人 API token），同一个人的电脑、手机和桥接看到同一批会话。`pnpm accounts -- claim` 把已有的按 IP 归属的数据转给账号。见[登录设计](docs/login-design.md)。
- 项目与会话管理；Pi 原生会话自动发现并默认共享。
- HTTP/JSON API 与 Server-Sent Events；运行中可追加 `follow-up`、提升为 `steer` 或中止。
- Pi 文本资源：`AGENTS.md` / `CLAUDE.md`、提示词模板与 skills（含 `~/.agents/skills`）按会话项目与服务 agentDir 自动发现。输入框支持 `@` 引用文件，以及 `/compact`、`/reload`、模板与 `skill:` 命令，还有显式加载的 Pi 扩展注册的命令（例如 `/antigravity.usage`）；扩展命令的输出作为 SYS 记录留在会话里，不会发给模型。命令弹出选择、确认或输入框时，打开着这个会话的页面都会在输入框上方显示这个问题，先回答的生效；只能在终端里画的界面（`ctx.ui.custom`）Web 上用不了。
- 共享 MCP 来自 Pi 的全局 `mcp.json`（`~/.pi/agent/mcp.json`，用 `pi mcp add` 或 TUI 的 `/mcp` 维护，支持 stdio 与 HTTP），文件改动后自动重新读取，不用重启；admin 也可以在 Web 上增删改（`/v1/mcp/shared`，写回同一个文件）。项目 owner 按项目启用并收紧这些 server（`/v1/projects/:id/mcp`，迁移 v4；同名 server 换了地址或命令后，项目设置停用，要重新确认，迁移 v6）；工具默认经 codemode 调用，脚本排队执行并限时。Web 端从侧栏底部的“设置”菜单打开当前项目的 MCP 设置面板，codemode 卡片列出脚本内部的工具调用。带 `oauth` 的 HTTP server 改用每个用户自己的授权（动态客户端注册，迁移 v5；需要 `PI_PUBLIC_URL` 与 `PI_MCP_TOKEN_KEY_FILE`）：用户在 MCP 面板里连接，只有他自己的私有会话使用这个身份。见 [MCP 接入方案](docs/mcp-integration.md)。
- 模型登录，对应 Pi TUI 的 `/login` 和 `/logout`：admin 在“设置”菜单的“模型登录”里用 provider 账号登录（OAuth）或填 API key，也可以删除已保存的凭证（`/v1/provider-auth`）。凭证写进 Pi 的 `auth.json`，和 `pi` 命令行共用，新的消息直接生效，不用重启。OAuth 回调落在服务所在机器的 localhost 上；从别的机器打开 Web 时，把浏览器最后跳到的地址粘回面板。
- Agent 设置，对应 Pi TUI 的 `/settings`：自动压缩、自动重试（含最多重试次数）和按模型的默认思考档位，读自 agentDir 下 Pi 的全局 `settings.json`，和 `pi` 命令行共用。所有人都能在“设置”菜单的“Agent 设置”里查看，admin 可以在那里修改（`/v1/settings`），只写这几个字段，文件里的其他字段原样保留。会话也按文件里的压缩阈值（`compaction.reserveTokens`、`keepRecentTokens` 与按模型的 `modelOverrides`）压缩，和 CLI 一致，这几项 Web 上不能改。运行中的会话几秒内生效。新会话、或会话里切换到另一个模型时，没手动选档位就用该模型自己的思考档位。在此之前会话不读 `settings.json`；之前用 `pi` 命令行写进去的这些值，现在对 Web 会话也会生效。
- 项目信任，和 `pi` 命令行共用 agentDir 下的 `trust.json`（在 Pi TUI 的信任提示里选择，或由 admin 在“设置”菜单的“项目信任”里修改，`/v1/projects/:id/trust`；没有记录时看 `defaultProjectTrust`，只有 `always` 算信任）。信任的项目才加载它的 `.pi/mcp.json`（并入这个项目的 MCP 列表）、`.pi/settings.json`（Agent 设置的同几项，叠加在全局之上）、`.pi/SYSTEM.md` 和 `.pi/APPEND_SYSTEM.md`（新建会话的系统提示词）。项目 `.pi/mcp.json` 不能替换共享 server、不能引用服务的环境变量，其中定义的 server 默认不启用，要项目 owner 在 MCP 面板里勾选，也可以用 `oauth` 让每个用户按项目各自授权；命令、参数、env 或地址改了要重新勾选。见[配置](docs/configuration.md)的“项目信任”。
- 默认 SQLite，可显式选择 PostgreSQL；对话保存为 Pi JSONL，同一请求重复提交返回已记录的结果。
- 可选的「稿纸」风格 Web UI：账本式对话流、运行状态、统计栏与轨迹 Inspector，由默认模型依据首条消息自动起的简短会话标题（设置 `PI_SESSION_AUTO_TITLE=off` 时继续显示首条消息），以及在空白会话迎接你（开场白由默认模型生成，设置 `PI_COMPANION_GREETING=off` 时只用本地句子）、随运行与输入变化表情的灵动线描小猫；它的名字、说话风格和是否收起由服务端按用户保存（迁移 v3）。它也跟随所有会话的运行：侧栏标出每个在跑的会话并在底部显示在跑数量，其他会话完成或失败时小派说一句（点击打开），页面在后台时可以发可选的浏览器通知（`GET /v1/activity/events`）。

## 当前边界

- **面向内网、单实例运行**：公网部署与多实例在后续版本完善。
- **Pi 工具默认全部授权**：包括 `bash`、`edit`、`write`。只读请设置 `TOOLS=read,ls,find,grep`，并另行落实文件系统 / 进程隔离。见[配置](docs/configuration.md)。
- **除非 server 使用按用户 OAuth，MCP 凭证都是共享身份**：凭证写在 `mcp.json`（或它引用的环境变量）里的共享 server，对启用它的每个项目都表现为同一个身份。按用户的 OAuth 凭证归属于用户：默认的 `ip` 模式下就是客户端 IP，同一 IP 后面的人共用它们；`accounts` 模式下归登录的账号；凭证在数据库里加密，但 `bash`（见下条）能像读其他文件一样读取 `mcp.json` 和 token 加密密钥文件。在 Web 上添加 stdio server 等于在服务器上执行这条命令，所以共享 MCP 只有 admin 能改。多数授权服务器只接受 https 或本机回调地址，通过 IP 访问的局域网部署要配 HTTPS 才能连接。
- **`bash` 以服务身份运行**：继承服务进程的完整环境变量（包括 provider API key），并能读取服务用户可读的任何文件。授予 `bash` 即等于把这些凭证交给所有用户；真正隔离需要不授予 `bash`，或让它以独立用户 / 在沙箱中运行。设置显式 `TOOLS` 白名单时，MCP 工具只由 `mcp__*` 条目授权，codemode 内发起的调用同样受限。
- **扩展与插件需显式启用**：Pi 扩展用 `PI_EXTENSION_PATHS`，agent-server 插件用 `PI_PLUGINS`；不设置则不加载。上下文文件、提示词模板与 skills 对所有项目自动加载；项目的 `.pi/mcp.json`、`.pi/settings.json`、`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md` 只在项目受信任时加载；项目扩展始终不加载。
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
| 使用 | [Web UI](docs/web-ui.md) · [Pi 原生会话](docs/native-sessions.md) · [子代理会话](docs/subagent-conversations.md) · [Claude Desktop 桥接](docs/claude-desktop-bridge.md) · [设计规范](DESIGN.md) |
| 接口 | [API 概览](docs/api.md) · [OpenAPI 规范](openapi/v1.json) · [控制队列](docs/control-queues.md) · [会话步骤与 Inspector](docs/session-steps.md) · [统计契约](docs/usage-measurement.md) · [插件接入](docs/plugin-integration.md) |
| 部署与运维 | [运维](docs/operations.md) · [配置与访问控制](docs/configuration.md) · [IP 访问控制](docs/ip-rbac-design.md) · [账号与登录](docs/login-design.md) · [备份与恢复](docs/backup-restore.md) |
| 开发 | [本地开发](docs/development.md) · [测试命令清单](docs/testing.md) · [架构](docs/architecture.md) · [数据库设计](docs/database-design.md) · [SDK 边界](docs/pi-sdk-api.md) · [ADR 索引](docs/decisions/README.md) |

[归档资料](docs/archive/)收录历史安装步骤、已完成计划与验收记录，不作为当前操作手册。
