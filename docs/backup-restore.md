# 备份与恢复 Runbook

本文是 SQLite/PostgreSQL 备份、恢复和 migration pre-backup 的权威操作文档；备份新鲜度部署见 [backup-freshness-exporter.md](backup-freshness-exporter.md)。

## 1. 固定边界

- 备份写入本机绝对路径 `BACKUP_ROOT`。当前 CLI 拒绝文件系统根、symlink 路径、group/world 可写目录，以及与源数据路径重叠的目录；发布目录只保存密文包，plaintext staging 使用独立的私有 0700 目录。**正式部署使用的具体绝对路径、属主和介质访问控制尚待运维确认**，确认前不得隐含默认值。
- 不做异地/独立故障域副本，因此不覆盖主机、磁盘与备份目录同时丢失；任何异地或独立介质复制都必须作为另行审核的部署能力，不能从本机备份语义推导出该保证。
- 使用 age recipient 公钥加密。age identity 私钥由运维托管，只在恢复时通过受控路径提供，不进入仓库、应用服务、备份包、argv 或日志。recipient 文件只含公钥 recipient；当前 CLI 要求绝对路径、非 symlink/hardlink 的 regular file，且拒绝 group/world 可写。CLI 当前不强制 owner-only；正式权限策略仍待运维确认。
- age identity/recipient 的生成、保管、访问控制和轮换由运维负责，不由仓库或服务隐式完成。**具体 recipient 值、轮换流程及撤销策略尚待运维确认**；正式部署前必须形成可恢复 retention 期内所有备份的书面策略，并完成恢复验证。
- 凭证和 auth 文件不进入备份；PostgreSQL 凭证使用私有临时 `PGPASSFILE`。
- 仓库不安装 scheduler、retention worker，也不自动回滚 migration。
- 每个 logical DB/schema + `DATA_DIR` 只允许一个服务实例；migration 和 restore 前必须停服务并确认无 writer。单实例/多实例约束的架构依据见 [architecture.md](architecture.md)。

## 2. 已落地语义（missing-as-empty / opaque JSONL / invalid-as-empty）

| 场景 | 行为 |
| --- | --- |
| DB 源 ledger 缺失、旧多行、字段/顺序错误或 checksum 不匹配 | backup（包括 `--dry-run`）在任何 age 加密、`COMPLETE`、发布或成功报告之前 fail-closed；不能推进 freshness |
| DB 引用的 JSONL 缺失 | 一律按 `missing-as-empty` 记录进加密 manifest 并允许发布；`--require-complete-session-references` 已退役，owner-transfer pre-backup 同样不再 fail |
| backup 读取已有 JSONL | 仅作 opaque bytes 稳定复制，不检查内容合法性（不逐行 `JSON.parse`） |
| restore 遇到 manifest 中的 missing | 对应 `sessions.conversation_ref` 写为 `NULL` |
| restore 遇到内容无效 JSONL | 丢弃该历史、对应引用写为 `NULL`，报告 `invalidSessionHistories` 数量（degradation）；其他会话照常恢复 |
| 包/密文/hash 损坏 | 仍整体失败；不得降级为空历史 |

机器报告（`backup-json-report`）只在通过唯一 canonical baseline 源 ledger 检查且成功发布的非 dry-run backup 上恰好一行；失败或 dry-run 均无成功报告，因此不能推进 freshness。`missingSessionReferences` 可以大于零，缺失历史不阻止发布。无效检测是 restore 对已装配 payload 的本地结构解析（仅 restore 做，backup 从不做；不使用 SDK `SessionManager.open`）。

## 3. 备份包契约

- **源 DB 接受面与发布前置条件**：SQLite 与 PostgreSQL 在产生 snapshot/dump 后（SQLite 以 `VACUUM INTO` snapshot 为最终权威）都必须有**恰为唯一 canonical baseline**的 `schema_migrations` ledger：单行 version 0 / `initial-schema` / golden checksum。缺 ledger、旧多行、错误字段/顺序或 checksum 一律 fail-closed；检查失败时不得调用 age、写 `COMPLETE`、发布包或发出 freshness 成功报告，`--dry-run` 同样失败。
- manifest 与每个 payload 均由 age 加密；记录 plaintext/ciphertext hash 与 size。
- `COMPLETE` 最后写入并绑定 encrypted manifest hash；只有同文件系统原子 rename 完成后的目录才算发布。
- plaintext staging 必须是私有 0700 目录，不能位于 backup root 或其父目录；失败路径清理 staging。backup root 内 staging 只含密文。
- restore 验证 `COMPLETE`、manifest、payload hash、migration ledger、schema 以及 package allowlist。任何密文、hash、manifest 或解密错误都 fail-closed。
- **restore 只接受恰为唯一 canonical baseline 的 ledger**：manifest 的 `migrationLedger` 必须是 present + 单行（version 0 / `initial-schema` / golden checksum）。非唯一 canonical baseline 或无 ledger 的包在 payload 解密/staging 之前 fail-fast，**不可恢复**；JSONL 历史只接受当前 Pi SDK v3 结构（header `version:3`，entry id/parentId 树），更旧版本按 invalid-as-empty 丢弃。
- 唯一 canonical baseline 包恢复时校验 `file_operations` 行，但绝不执行其中的删除任务。

## 4. 人工备份

```bash
AGENT_CWD=/absolute/application/cwd \
DATA_DIR=/absolute/application/data \
DB_PATH=/absolute/application/data/pi-agent-server.db \
PI_STORAGE_DIALECT=sqlite \
pnpm backup -- create \
  --backup-root /absolute/backup-root \
  --age-recipient-file /absolute/secure/age-recipients
```

PostgreSQL 改为显式设置：

```bash
PI_STORAGE_DIALECT=postgres
PI_DATABASE_URL=postgresql://...
```

要求：

- `AGENT_CWD`、`DATA_DIR`、`DB_PATH`、backup root、recipient file 均使用绝对路径；
- recipient file 只包含公钥 recipient；当前 CLI 要求非 symlink/hardlink regular file，并拒绝 group/world 可写（owner-only 权限属于尚待确认的正式部署策略，不是当前 CLI 门禁）；
- `age`/`age-keygen` 版本固定；PostgreSQL server、`pg_dump`、`pg_restore` major 完全一致；
- `--dry-run` 不发布任何包，且仍执行唯一 canonical baseline source-ledger 检查；缺 ledger、旧多行或 checksum 不匹配必须非零失败，不得报告可成功。
- 运行时只接受当前 Pi JSONL v3：持久会话在 `SessionManager.open` 前先验证 header `version:3`，v1/v2 或畸形历史 fail-fast 且不改写文件；只读 export 同样拒绝旧版本，绝不调用 SDK `migrateSessionEntries`。

`pnpm backup` 只用于人工开发/演练。自动备份由部署方审核的 helper/timer 调用固定编译产物。

## 5. Migration 建立与前置备份

Migration CLI 有两条互斥路径：

### 5.1 完全空目标建立唯一 canonical baseline

完全空 SQLite DB 或完全空 non-public/non-system PostgreSQL schema，必须离线执行唯一 canonical baseline bootstrap：

```bash
pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED
```

`--bootstrap-baseline` 不可混用 `--backup-root`、`--age-recipient-file`、`--maintenance-window` 等 backup/maintenance 参数，也不会创建 pre-backup。它只建立唯一 canonical baseline；完成后先执行 `--verify`，服务启动仍只接受 verify。

### 5.2 已有唯一 canonical baseline 的 apply

`--apply` 只对已经有唯一 canonical baseline 的数据库执行。正式顺序固定为已验证的 **pre-backup → apply → verify**：

1. 在窗口前用最近可用备份完成隔离恢复演练；
2. 停服务并独立确认无 writer；
3. `pnpm migrate -- --dry-run` 审核目标与计划；
4. 无停顿执行 `--apply`，由 CLI 创建并验证 pre-migration 加密备份后才迁移；
5. 执行 `pnpm migrate -- --verify`；
6. 仅在 verify 成功后启动服务并检查 `/readyz`。

```bash
pnpm migrate -- --apply \
  --backup-root "$BACKUP_ROOT" \
  --age-recipient-file "$AGE_RECIPIENT_FILE" \
  --maintenance-window CONFIRMED
pnpm migrate -- --verify
```

`CONFIRMED` 不是进程锁。CLI 不自动 startServer、down、restore 或 retry。迁移失败时保留 pre-migration 包，由运维评估恢复。

## 6. 隔离恢复

```bash
pnpm restore -- restore \
  --input-backup /absolute/backup-root/backup-<id> \
  --target-root /absolute/isolated/restore-target \
  --age-identity-file /absolute/ops-managed/age-identity
```

- 先在明确隔离的新目标上执行，禁止覆盖源数据库、正式 schema 或正式 `DATA_DIR`。
- SQLite restore 写入新的绝对 target root；PostgreSQL restore 需要明确的 disposable empty database/schema，拒绝 `public` 和系统 schema。
- restore 不自动迁移；恢复的包必须携带恰为唯一 canonical baseline（version 0 / `initial-schema` / golden checksum）的 migration ledger，否则在 payload 解密/staging 之前 fail-fast。完全空目标可以作为隔离 restore 的写入目标，但 `--bootstrap-baseline` 只建立唯一 canonical baseline、不会创建 pre-backup，也不会生成可恢复的 backup package。
- age identity 由运维在执行时提供。一次成功解密和恢复演练是“私钥可用”的必要证据。
- 目标 missing/invalid-as-empty 语义见 §2，恢复行为以该表为准。

## 7. 失败处理

- 备份、源 ledger、age、manifest、hash、target、schema 或版本校验失败：不执行后续 migration，不更新 freshness。
- migration 失败：保留已发布 pre-migration 包，不自动 down 或恢复。
- restore 失败：不发布部分 target；保存脱敏错误和证据，由运维处理。
- 日志和证据不得包含数据库 URL、密码、token、age identity、原始 argv、会话路径或正文。

## 8. RPO、RTO、保留期与恢复演练

- **RPO 目标：24 小时**。部署计划以固定不超过 12 小时的完整备份节奏留出执行和告警预算。
- **RTO 目标：4 小时；signoff 延期**。项目投入使用且有代表性数据规模后，再授权隔离环境完成 `restore → migration verify → start → health/readyz → 合成业务检查 → serviceable` 全流程计时并签署；此前只记录功能性恢复证据，不宣称 RTO 已验收。
- **备份保留：30 天**。自动删除未实现；由运维人工审核并清理过期备份。备份保留不延伸为会话、日志或审计数据的保留承诺。
- **恢复演练：每季度及重大 migration 前**。当前 RTO signoff 延期不取消功能性恢复演练要求；演练必须使用隔离 target-like 环境和合成数据。
