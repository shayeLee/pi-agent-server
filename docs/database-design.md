# 数据库设计（RC / SQLite + PostgreSQL）

源码为准：`src/storage/schema-manifest.ts` 声明 schema，`schema-types.ts` 推导 `DatabaseSchema`；SQLite/PG bootstrap 共用 `schema-builder.ts`，Repository 使用中立的 Kysely 查询。当前为单实例 RC，不支持 SQLite→PostgreSQL 数据迁移。

## 1. Schema 与 migration

当前 head 是 **v5**，不是单独的 v0 baseline、v1、v2、v3 或 v4：

| 版本 | 不可变快照 | 增量内容 |
| --- | --- | --- |
| v0 `initial-schema` | `initialSchemaManifest` | projects、sessions、idempotency、file_operations |
| v1 `uploaded-files-and-idempotency-fingerprint` | `uploadedFilesSchemaManifest` | uploaded_files；idempotency.fingerprint |
| v2 `native-shared-sessions` | `nativeSessionsSchemaManifest` | sessions.visibility/origin；native_session_sources |
| v3 `companion-personas` | `companionPersonasSchemaManifest` | companion_personas |
| v4 `project-mcp-servers` | `projectMcpServersSchemaManifest` | project_mcp_servers |
| v5 `user-mcp-oauth` | `schemaManifest` | mcp_oauth_clients、user_mcp_credentials |

`src/storage/migration-manifest.ts` 固化每个版本的 schema、两方言 canonical operations、物理类型映射与 dataTransform，checksum 对这些 descriptor 内容作稳定序列化后取 SHA-256，不只是 DDL 文本 hash。v0–v4 不随当前 head 改写；`binding.private` 是可选 JSON 标记，不新增 migration 或改变 v2 checksum。

完全空库以 `--bootstrap-baseline --bootstrap-confirm CONFIRMED` 建立完整 v0→v1→v2→v3→v4→v5 head；已有已认证前缀以 pre-backup → `--apply` → `--verify` 升级。无 ledger、未知版本或 checksum 不匹配均拒绝采用；服务启动只 verify，不自动迁移。restore 校验包所携历史前缀，不自动升级到 head。命令见 [Operations](operations.md) 与 [Backup and restore](backup-restore.md#5-migration-建立与前置备份)。

Manifest 对 PK/FK/索引列引用作编译期检查，运行期复查唯一性、类型、声明顺序等并深冻结。逻辑类型映射：

| 逻辑类型 | SQLite | PostgreSQL |
| --- | --- | --- |
| uuid | TEXT | UUID |
| text / json | TEXT | TEXT（非 JSONB） |
| integer / bigint | INTEGER | BIGINT |

应用生成 UUID 和毫秒时间戳。PG BIGINT 由 `pg-int8.ts` 的 per-pool parser 读为安全 JS number，超出安全范围拒绝，不修改进程级解析器。

## 2. 表与约束

字段完整声明见 `schema-manifest.ts`，这里仅列存储职责和约束，不复制 DDL。

| 表 | 职责 | 关键约束 |
| --- | --- | --- |
| projects | name、canonical 工作区归属、owner、创建时间 | id 主键；owner 索引 |
| sessions | 项目/owner、标题、时间、Agent descriptor、冻结配置、visibility/origin | id 主键；project_id FK → projects ON DELETE CASCADE；非空 `(agent_kind, conversation_format, conversation_ref)` 唯一 |
| idempotency | 请求预约/终态、fingerprint、时间 | `(session_id, request_id)` 复合主键；created_at 索引；无 FK |
| file_operations | 旧 managed JSONL 的删除意图与 lease 状态 | id 主键；operation_key 唯一；state/available_at 索引；无 FK |
| uploaded_files | owner/project、上传键、文件名/类型/大小/SHA-256、存储键/Agent 路径、状态、可选 session 绑定 | id 主键；`(owner_key, project_id, upload_key)` 唯一；无父级 FK，删除不会擦除上传记录 |
| native_session_sources | source_path/source_id、session/project、binding JSON、deleted 墓碑 | source_path 主键；source_id 与 session_id 各自唯一；无 FK，删除保留墓碑 |
| companion_personas | 空白会话数字人的名字、说话风格、是否收起与更新时间，每个调用者一行 | owner_key 主键；无 FK；读到未知风格视为未设置 |
| project_mcp_servers | 项目对 MCP 目录 server 的启用状态、exposure 覆盖、隐藏的工具（JSON 数组）与最后修改者 | `(project_id, server_name)` 主键；project_id → projects CASCADE，随项目删除；owner 转移不改 project_id，设置随项目走；读到未知 exposure 视为未设置 |
| mcp_oauth_clients | 向 MCP 授权服务器动态注册的客户端，属于部署：注册时的 server 地址、回调地址、客户端信息（密文）、注册时间 | server_name 主键；无 FK；server 地址或回调地址变化后不再使用，下次授权重新注册 |
| user_mcp_credentials | 用户对 MCP server 的 OAuth 授权：server 地址、client_id、显示用账号名、token（密文 JSON）、过期时间、scope、发现结果缓存（JSON）、连接与更新时间 | `(owner_key, server_name)` 主键；无 FK；server 地址变化后不再使用；密文附加数据绑定主键，挪到别的行解不开 |

sessions 的模型、thinking、system_prompt、capability_versions 与 conversation_ref 可空；visibility/origin 非空且默认 private/managed。owner/updated_at 与 owner/project 索引支持列表，排序为 updated_at DESC、id DESC。

DB 不存完整消息正文；conversation_ref 由对应 Agent storage 解释。一个 source 只能绑定一个服务会话/runtime；“共享会话”不是多个会话记录共用同一个引用。

## 3. 项目归属与访问

- 默认项目固定为 `DEFAULT_PROJECT_ID`，owner 为空；`ensureDefaultProject` 保留既有行，禁止把该 ID 创建成私有项目或删除。当前 `AGENT_CWD` 决定原生发现的默认归属，不以保留的旧 DB cwd 授权。
- 发现依据已验证 v3 header 登记符合策略的 canonical 工作区，不反解目录名授权。自动项目由系统管理，不属于首个查看者。新建项目拒绝 canonical cwd 重复，既有重复保留。
- private/managed 会话按 owner 隔离；shared/native 会话在网络准入和路由 RBAC 后仍需当前来源策略校验。排除、私有已认领、仅剩墓碑或无效来源不会生成自动项目。
- `GET /v1/projects` 仅返回至少有一个当前 actor 可见会话的项目，包括默认项目；这是列表过滤，不删除存量项目。显式创建仍返回空项目，Web 暂存草稿用于首次发送。
- 默认项目、项目 owner，或有当前可见共享/自己私有会话的操作者可取得创建/上传入口；仍需路由写权限。新会话与附件属于该操作者，不因此取得其他人的私有数据或项目修改权限。`canCreateSession` 表示此能力；项目改名/删除保持 owner-only。
- `AGENT_CWD` 从 A 改为 B 时，共享 native A 会话按索引元数据原子重归属到独立 A 项目，ID 和原件不变；B 使用默认项目。既有私有 A 会话不重归属，继续时仍校验 cwd 身份。

## 4. JSONL 与删除的跨存储边界

DB 与 JSONL 不是单一原子事务。

新 Web 私有会话与 CLI 使用统一 `PI_SESSION_SOURCE_DIR` 的 encoded-cwd 布局，独立于 `DATA_DIR`/服务端 `PI_AGENT_DIR`；旧 server-ID 路径继续兼容读取，不搬动文件。文件创建前先预约 source_path 和原始 Pi ID，排他创建后绑定 inode；未完成 reservation 的 inode 为 -1，不能恢复。失败或删除保留 source 墓碑，防止 scanner 将私有文件提升为共享。共享及私有 source claim 均不调度物理删除。

无 source claim 的历史 managed 引用沿用 conversation reservation 与 `file_operations` outbox：删除事务登记稳定 `delete-artifact:<agentKind>:<conversationFormat>:<path-digest>` 键，已存在的任何状态均阻止同 artifact 重绑。outbox 仅接受 DATA_DIR 下既有两种 server-ID 布局。当前 `file-ops` 只有只读 planner，无 unlink/retry/quarantine executor；`reconcile-jsonl` 只分析 DB 引用，不扫描文件系统或修复历史。

FD 校验、追加与 SSE 撤权见 [Architecture](architecture.md#统一-pi-jsonl-落点与访问策略)；附件配额/保留见 [Attachment uploads](attachment-uploads.md)；归档与恢复清理见 [Backup and restore](backup-restore.md)。

## 5. 请求幂等与 TTL

幂等键为 `(session_id, request_id)`。内存 in-flight/done 去重与持久化 reservation 共同阻止重复执行；共享 native 的 fingerprint 还绑定 actor，其他操作者复用 ID 返回冲突。

Repository 的 `reserve` 用 INSERT ON CONFLICT DO NOTHING 选唯一执行者；`result` 可保存 `PI-IDEMPOTENCY-RESERVATION-V1:<token>`，终态仅由该 token 的持有者 CAS 替换。重启后的未确认预约是状态未知屏障，不是完成，也不能当缓存 miss 重跑。持久化 fingerprint 检查变化的载荷；无 fingerprint 的旧记录不保证该检查。

默认 TTL 为 24h，Registry 启动及定期 prune 终态记录；**未确认预约与 `file-` fingerprint 记录不按 TTL 删除**。普通终态过期后不保证去重。这是请求幂等，不是文本去重或永久 exactly-once。

## 6. PostgreSQL 与验证

仅 `PI_STORAGE_DIALECT=postgres` 显式启用 PG，需非空 `PI_DATABASE_URL`，有效业务 schema 必须非 public/非系统 schema。未知非空方言拒绝；空白方言为 SQLite。SQLite 文件库启用 WAL、foreign keys 和 5000ms busy timeout；PG 不因此获得多实例协调能力。

Repository 共享 CRUD/事务/映射，PG 约束错误仅在存储边界转换：自身单列 id 主键的 23505 → DuplicateIdError，project FK 的 23503 → ProjectForeignKeyError；其他错误保留。关闭统一使用 Kysely.destroy（PG pool.end）。

`tests/postgres/` 用随机 schema 隔离，`PI_TEST_PG_URL` 未配置时 skip；发布门禁 `pnpm test:postgres` 在缺 URL 时非零退出，skip 不是验收。日常/发布检查见 [Operations](operations.md#验证)，本地 PG 示例见 [postgres-podman-test.md](postgres-podman-test.md)。
