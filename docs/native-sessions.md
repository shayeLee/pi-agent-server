# Pi 原生会话（默认共享）

列出项目或会话时发现原生 **v3** JSONL 并索引原件，依据已验证的 header 自动登记符合条件的 canonical 工作区（绝不反解目录名作为 cwd 授权）；默认 cwd 复用默认项目。不会直接暴露其他 owner 的私有会话或项目。原生会话默认对**所有通过网络准入的用户**共享，仍受现有路由 RBAC 约束；Web 新建会话继续按 owner 私有隔离。有写权限的用户可共同继续、控制或中止共享会话。API 新增可选 `visibility`（`shared`/`private`）与 `origin`（`native`/`managed`），旧客户端仍能 list/open。请求 ID 在共享会话内全局唯一并绑定操作者；其他用户复用会返回 `409`，不会收到对方的请求结果。

发现不复制、迁移或删除源文件。同一原件只对应一个 server session/runtime；逻辑删除保留持久墓碑。显示优先级为 Web 改名、最新原生名称、首条 prompt。新建项目若 canonical cwd 重复（含符号链接别名和默认 cwd）返回 `409`；既有重复项目保留。

`PI_SESSION_SHARE_EXCLUDE_CWDS` 按逗号分隔、trim 并去除空项；未设置/为空不排除任何目录。填写最多 64 个存在的绝对目录，按 **canonical cwd 精确匹配**，不是前缀。无效配置拒绝启动；目录替换或别名重定向使共享访问 fail closed，包括活动事件流。修改后重启；私有会话访问与原件保留。

`PI_SESSION_SOURCE_DIR` 是 CLI/Web 新建私有 JSONL 的统一根：默认 `PI_CODING_AGENT_DIR/sessions`，否则为 `~/.pi/agent/sessions`，独立于服务端 `PI_AGENT_DIR` 和 `DATA_DIR`。隔离存储须显式设置。Web 新建会话使用原生 encoded-cwd 布局，但保持 private/managed，包括分享排除 cwd；旧 server-ID 引用继续可读，不移动文件。source claim 与墓碑防止私有文件被重新发现为共享。**不要同时使用 CLI 和服务操作同一原件：** 尚无跨进程锁。FD 校验与追加边界见[架构](architecture.md)。

备份包含已登记原生/私有来源的真实 bytes 与墓碑，不只是索引；活动原件缺失或无效即 fail closed。恢复须显式设置原生目标根和 identity cwd mapping，绝不覆盖文件。中断恢复需核验清理后重做，见[备份与恢复](backup-restore.md)。重启前离线 apply 新增数据库 v2 migration；启动仍只 verify。

自动发现将已验证、符合条件的工作区登记为系统管理项目。`GET /v1/projects` 仅列出当前操作者可见会话的项目，默认项目也过滤；不删除已存项目或文件。有写权限的操作者可在共享项目中新建自己的私有会话（`canCreateSession`），不会取得项目修改或其他操作者附件的访问权。exclude 撤销共享入口，但保留通过自己私有会话的访问。项目改名/删除仍仅限 owner。显式创建返回空草稿，Web 保留它以发送首条消息；空列表仍可向默认项目首次发送。归属与存储规则见[数据库设计](database-design.md)。
