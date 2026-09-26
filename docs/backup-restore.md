# 备份与恢复 Runbook

本文是 SQLite/PostgreSQL 备份、恢复和 migration pre-backup 的权威操作文档，也是正式备份运维的唯一入口。备份新鲜度监控与合成演练是未安装的设计文档，见 [archive/backup-freshness-exporter.md](archive/backup-freshness-exporter.md) 与 [archive/backup-freshness-drill-sop.md](archive/backup-freshness-drill-sop.md)（非现生产告警）。

## 1. 固定边界

- 备份写入本机绝对路径 `BACKUP_ROOT`。当前 CLI 拒绝文件系统根、symlink 路径、group/world 可写目录，以及与源数据路径重叠的目录；发布目录只保存密文包，plaintext staging 使用独立的私有 0700 目录。**正式部署使用的具体绝对路径、属主和介质访问控制尚待运维确认**，确认前不得隐含默认值。
- 不做异地/独立故障域副本，因此不覆盖主机、磁盘与备份目录同时丢失；任何异地或独立介质复制都必须作为另行审核的部署能力，不能从本机备份语义推导出该保证。
- 使用 age recipient 公钥加密。age identity 私钥由运维托管，只在恢复时通过受控路径提供，不进入仓库、应用服务、备份包、argv 或日志。recipient 文件只含公钥 recipient；当前 CLI 要求绝对路径、非 symlink/hardlink 的 regular file，且拒绝 group/world 可写。CLI 当前不强制 owner-only；正式权限策略仍待运维确认。
- age identity/recipient 的生成、保管、访问控制和轮换由运维负责，不由仓库或服务隐式完成。**具体 recipient 值、轮换流程及撤销策略尚待运维确认**；正式部署前必须形成可恢复 retention 期内所有备份的书面策略，并完成恢复验证。
- 凭证和 auth 文件不进入备份；PostgreSQL 凭证使用私有临时 `PGPASSFILE`。
- 仓库不安装 retention worker，也不自动回滚 migration；正式备份调度由部署方审核的 helper/timer 调用固定编译产物，宿主不会自动安装或启用定时器。插件或扩展数据的独立备份由其各自文档负责。
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

`pnpm backup` 只用于人工开发/演练。自动备份由部署方审核的 helper/timer 调用固定编译产物；源码更新后必须重新构建该产物，不得用旧产物继续调度。

### 4.1 宿主 SQLite 正式定时备份（systemd oneshot + timer，参数化）

本节给出**通用**的宿主 SQLite 在线定时备份运维流程：与 [operations.md](operations.md) 使用同一个 `agent-server` 服务账号、同一份 `DATA_DIR`/`DB_PATH` 与源码目录（root 拥有、服务账号只读），不绑定任何具体插件、主机、网段或仓库内一次性脚本，也不要求停服。插件或扩展数据可能有各自的备份链路，不属于本流程。以下路径/账号沿用 operations.md 的示例值，**正式值须先按 §1 由运维确认**，确认前不得当作默认值。

前置条件：

- 已完成 operations.md 的首次部署：`agent-server` 账号、`DATA_DIR`/`DB_PATH`、源码目录 `/srv/pi-agent-server`（root 拥有、服务账号只读）就绪。
- 固定 Node 绝对路径对 `agent-server` 可穿越且可执行，并与 operations §7 服务 unit 的 `ExecStart` 使用同一个 Node 二进制。
- 已安装并固定版本 `age`/`age-keygen`；PostgreSQL 场景另需 `pg_dump`/`pg_restore` major 与 server 完全一致（本节以 SQLite 为例）。
- age **公钥 recipient** 已由运维投放到服务器固定路径 `/etc/pi-agent-server/age-recipient.txt`（非 symlink/hardlink regular file、非 group/world 可写，例如 `root:agent-server 0640`、服务账号可读）；age **私钥离机保管**，只在恢复时通过受控路径提供，绝不进入本流程的 unit、argv、日志或备份包。

步骤 1 — 构建 backup 产物并跑 smoke：

```bash
cd /srv/pi-agent-server
umask 022
pnpm install
pnpm build:backup   # dist-backup/scripts/backup.js + restore.js；末尾跑编译产物与安装包 smoke
```

`pnpm build:backup` 产出 `dist-backup/scripts/backup.js`（`bin.pi-agent-server-backup`）与 `dist-backup/scripts/restore.js`。其末尾 smoke 会 `npm pack`/`npm install` 本地 tarball（临时空 npm cache，需能访问 registry 或已配置镜像），并要求 PATH 中有 `age`/`age-keygen`。构建以 root 执行、产物归 root、服务账号只读；源码更新后必须重新构建，不得用旧产物继续调度。

步骤 2 — 准备目录与独立 staging（不与源/备份重叠）：

```bash
# 备份根：只存密文包
install -d -o agent-server -g agent-server -m 0700 /var/lib/pi-agent-backups
# 独立明文临时目录：绝对路径、权限 0700、所属用户为服务账号，位于 backup root 及其父目录之外，且不与 DATA_DIR/DB_PATH 重叠
install -d -o agent-server -g agent-server -m 0700 /srv/pi-agent-backup-staging
```

- backup root 不得与源数据路径、staging、凭证路径重叠，不得是文件系统根，不得 group/world 可写。
- staging 根及其完整祖先链必须无 symlink、非 sticky、非 group/world 可写，且所属用户为服务账号或 root；staging 必须位于 backup root 及其父目录之外。
- 只精确设置这些目录，**不要** `chmod -R`。

步骤 3 — 备份环境文件：

下面的命令仅用于首次创建文件；文件已存在时直接编辑，不要重新执行，否则会清空原配置。

```bash
install -o root -g agent-server -m 0640 /dev/null /etc/pi-agent-server/backup.env
```

内容（只含路径，绝不含模型 key、age 私钥或数据库密码）：

```ini
# /etc/pi-agent-server/backup.env — root:agent-server 0640
AGENT_CWD=/var/lib/pi-agent-server/workspace
DATA_DIR=/var/lib/pi-agent-server
DB_PATH=/var/lib/pi-agent-server/pi-agent-server.db
PI_STORAGE_DIALECT=sqlite
PI_AGENT_DIR=/var/lib/pi-agent-server/agent
PI_AUTH_PATH=/var/lib/pi-agent-server/agent/auth.json
PI_BACKUP_STAGING_ROOT=/srv/pi-agent-backup-staging
```

- `PI_AUTH_PATH` 必须与 operations.md 一致，使 backup CLI 的凭证重叠校验作用于真实凭证位置；backup 绝不包含凭证内容（见 §1）。
- 不要在此文件放 `PI_MODEL_API_KEY` 等模型凭据，unit 也不要引用含 secret 的 drop-in。

步骤 4 — systemd oneshot service：

`/etc/systemd/system/pi-agent-server-backup.service`：

```ini
[Unit]
Description=pi-agent-server encrypted SQLite backup (oneshot)

[Service]
Type=oneshot
User=agent-server
Group=agent-server
UMask=0077
Environment=HOME=/var/lib/pi-agent-server
EnvironmentFile=/etc/pi-agent-server/backup.env
TimeoutStartSec=65min
TimeoutStopSec=120s
Restart=no
# 固定 Node 绝对路径 + 编译产物 + 精确绝对源配置；无包装/网络脚本
ExecStart=<NODE_BIN_ABSOLUTE> /srv/pi-agent-server/dist-backup/scripts/backup.js create \
  --backup-root /var/lib/pi-agent-backups \
  --age-recipient-file /etc/pi-agent-server/age-recipient.txt
```

- `ExecStart` 必须直接调用固定 Node 绝对路径与 `dist-backup/scripts/backup.js create`，并显式传入绝对 `--backup-root` 与 `--age-recipient-file`；不经过任何包装、下载或网络脚本。
- `Type=oneshot`、`Restart=no`：失败不自动重试，由人工处理（见步骤 7）。
- SQLite 备份使用在线 `VACUUM INTO` 快照，**无需停服**；但一次运行只保证单个 logical DB/schema + `DATA_DIR` 的自身一致性，**不承诺**与插件或扩展数据之间的跨组件原子一致点。
- 若需要防重入，可让 `ExecStart` 经 `flock` 指向服务账号可写路径的锁文件（例如 `/run/pi-agent-server/backup.lock`）；这不是正确性前提，timer 与 oneshot 本身已避免并发启动同一 unit。

步骤 5 — timer（每 12 小时，localtime）：

`/etc/systemd/system/pi-agent-server-backup.timer`：

```ini
[Unit]
Description=Run pi-agent-server backup twice daily

[Timer]
OnCalendar=*-*-* 00,12:00:00
Persistent=true
Unit=pi-agent-server-backup.service

[Install]
WantedBy=timers.target
```

- `OnCalendar` 使用本机 localtime；`Persistent=true` 使错过的一次在下次启动补跑，但**首次启用不保证立即执行**。
- 节奏不超过 12 小时，以满足 §8 的 RPO 24 小时目标（含执行与告警预算）。

步骤 6 — 首次执行、启用 timer 并核对真实结果：

```bash
systemctl daemon-reload
BACKUP_CHECK_SINCE=$(date --iso-8601=seconds)
systemctl start pi-agent-server-backup.service   # 首次手动跑一次；失败时停止后续步骤，先排查
```

核对**真实产物与日志**，不要只看 `systemctl is-active`（oneshot 执行完即为 `inactive`，不能作为成功依据）：

```bash
# 在同一终端执行，限定为刚才这次运行；未保存开始时间时不能退回查看旧成功记录。
: "${BACKUP_CHECK_SINCE:?请先记录开始时间并执行本次备份}"
systemctl show pi-agent-server-backup.service \
  -p Result -p ExecMainStatus -p ExecMainStartTimestamp -p ExecMainExitTimestamp
journalctl -u pi-agent-server-backup.service --since "$BACKUP_CHECK_SINCE" --no-pager
# 确认本次 Result=success、ExecMainStatus=0，并找到本次唯一的成功机器报告。
# 复制该报告的 finalPath 完整绝对路径，替换下面的占位值；不要再拼接 backup- 前缀。
BACKUP_PATH='/absolute/path/from/current-report-finalPath'
test -s "$BACKUP_PATH/COMPLETE"
```

以上检查全部通过后，才启用定时任务：

```bash
systemctl enable --now pi-agent-server-backup.timer
systemctl list-timers pi-agent-server-backup.timer --no-pager
```

- 成功依据是：本次运行的 journal 中出现 `backup created:` 与**恰好一条**可解析的 `backup-json-report:`（`status=published`、`dryRun=false`），且对应包目录存在非空 `COMPLETE`；`missingSessionReferences` 可以大于零，不阻止成功（见 §2）。
- 不要用 `systemctl is-active ... == active` 判断成功；失败时用 `systemctl show pi-agent-server-backup.service -p Result` 与 journal 定位，且不得回显 secret。

步骤 7 — 失败处理与保留：

- 失败**不自动重试**（`Restart=no`），保留可能的半成品包与日志，由人工按本文 §7 检查；确认原因后人工重跑 `systemctl start`，不盲目重试。
- 无自动告警；如需监控，按归档的 freshness 设计另行审核部署（见 [archive/backup-freshness-exporter.md](archive/backup-freshness-exporter.md)）。
- 保留期 30 天，**由人工审核并清理**过期包；仓库不安装 retention worker（见 §1、§8）。

步骤 8 — 抽取新包做隔离恢复演练：

- 从 backup root 选取**本次实际产生的最新完整包**（含 `COMPLETE` 的目录），不要用通配符猜测包名，也不要固定历史批次名。
- 在**隔离主机/隔离目录**上执行 §9 的官方 restore SOP；如从远端下载，只做只读拉取，绝不回写或覆盖源。私钥只在隔离恢复时由运维提供。
- 演练完成后在 §9 记录中登记本次所选包标识、时间、结果与证据引用。

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
- **跨主机源元数据（仅 SQLite）**：manifest 的 `sourceRoots` 是备份主机记录的元数据，只用于与 target 的重叠校验，恢复时从不写入。因此这三个已认证源引用允许包含 symlink 分量（例如 Linux `/home/<user>/...` 在 macOS 上经由 `/home` 系统 symlink 别名解析），并在词法（lexical）与物理（physical，realpath）两种形态下与 target 双向比对，任一重叠即 fail-fast。源引用仍拒绝非绝对路径、NUL 字节和 `.`/`..` 分量；最近存在的祖先只允许 ENOENT 继续上溯，dangling symlink、symlink loop、权限失败或 ENOTDIR 一律 fail-closed。input/target/identity 仍执行严格的无 symlink 祖先策略。该放宽仅限 SQLite；PostgreSQL restore 保持原有严格策略。
- restore 不自动迁移；恢复的包必须携带恰为唯一 canonical baseline（version 0 / `initial-schema` / golden checksum）的 migration ledger，否则在 payload 解密/staging 之前 fail-fast。完全空目标可以作为隔离 restore 的写入目标，但 `--bootstrap-baseline` 只建立唯一 canonical baseline、不会创建 pre-backup，也不会生成可恢复的 backup package。
- age identity 由运维在执行时提供。一次成功解密和恢复演练是“私钥可用”的必要证据。
- 目标 missing/invalid-as-empty 语义见 §2，恢复行为以该表为准。

## 7. 失败处理

- 备份、源 ledger、age、manifest、hash、target、schema 或版本校验失败：不执行后续 migration，不更新 freshness。
- migration 失败：保留已发布 pre-migration 包，不自动 down 或恢复。
- restore 失败：不发布部分 target；保存脱敏错误和证据，由运维处理。
- 日志和证据不得包含数据库 URL、密码、token、age identity、原始 argv、会话路径或正文。

## 8. RPO、RTO 与保留期

- **RPO 目标：24 小时**。部署计划以固定不超过 12 小时的完整备份节奏留出执行和告警预算（宿主 SQLite 定时备份模板见 §4.1）。
- **RTO 目标：4 小时；signoff 延期**。项目投入使用且有代表性数据规模后，再授权隔离环境完成 `restore → migration verify → start → health/readyz → 合成业务检查 → serviceable` 全流程计时并签署；此前只记录功能性恢复证据，不宣称 RTO 已验收。
- **备份保留：30 天**。自动删除未实现；由运维人工审核并清理过期备份。备份保留不延伸为会话、日志或审计数据的保留承诺。
- **恢复演练：每季度及重大 migration 前**。当前 RTO signoff 延期不取消功能性恢复演练要求；演练必须使用隔离 target-like 环境和合成数据，通用步骤见 §9。

## 9. 恢复演练 SOP（参数化）

本节给出通用的隔离恢复演练流程，适用于任何符合本契约的备份包，不绑定具体主机、路径、账号或插件，也不需要任何仓库内的一次性脚本。演练全部使用官方恢复 CLI。

备份包根路径与 age identity 由运维环境以绝对路径配置，值由部署方保管，不得写入仓库、日志或证据：

```bash
export BACKUP_ROOT=/absolute/ops/backup-root          # 备份包所在根目录
export AGE_IDENTITY_FILE=/absolute/ops/age-identity   # age 私钥（仅恢复时提供）
export RESTORE_RUN_ROOT=/absolute/ops/restore-runs    # 演练私有 run 根目录
```

演练步骤：

1. 取得待验证的完整包目录，并确认其来自同一次成功执行；包目录名不要用通配符猜测。
2. 在 `RESTORE_RUN_ROOT` 下用 `mktemp -d` 新建 attempt 目录（精确 0700、当前用户属主、非 symlink），目标必须是**全新且隔离**的路径，禁止覆盖源数据库、正式 schema 或正式 `DATA_DIR`。
3. 先跑官方 `--dry-run`：SQLite 会真实解密并校验 payload，但不发布恢复目标；PostgreSQL 的 dry-run 在 payload 解密前返回，不能据此判断 payload 完整性。两种模式都需要私钥。
4. dry-run 通过后执行真实隔离恢复。

```bash
umask 077
mkdir -p "$RESTORE_RUN_ROOT"
DRILL=$(mktemp -d "$RESTORE_RUN_ROOT/attempt-XXXXXXXX")
chmod 700 "$DRILL"
# 将占位符替换为本次选定包的完整目录名。
PACKAGE='backup-<本次包完整标识>'

pnpm restore -- restore \
  --input-backup "$BACKUP_ROOT/$PACKAGE" \
  --target-root "$DRILL/target" \
  --age-identity-file "$AGE_IDENTITY_FILE" \
  --dry-run

pnpm restore -- restore \
  --input-backup "$BACKUP_ROOT/$PACKAGE" \
  --target-root "$DRILL/target" \
  --age-identity-file "$AGE_IDENTITY_FILE"
```

PostgreSQL 恢复另需 `--target-pg-url` 指向明确用于演练的空 database/schema，并且必须执行实际隔离恢复，不能仅凭 dry-run 判定备份可恢复。

验收依据官方 CLI 结果字段白名单：`status=success`、`dialect` 与源一致、`dryRun` 与本次调用一致、`counts` 全为非负整数、`migration.version/pending` 为整数。missing/invalid 语义按 §2 判定。私钥只由官方恢复核心读取；任何包装脚本都不得打开或打印其内容。

边界：

- 演练不在生产环境执行、不启动服务、不做 RTO 计时。
- 恢复结果与日志只留在私有 attempt 目录，**不上传任何明文**；清理由人工执行，本 SOP 不自动删除 attempt 目录。
- 一次成功解密和恢复演练是“私钥可用”的必要证据，但**不是 RTO 验收或签署**（见 §8）。
- 每次演练后登记所选包标识、执行时间、CLI 结果与证据引用；记录只含 opaque 引用与计数，不含明文、密钥、URL 或正文。
- 插件或扩展数据可能有独立的备份链路和未加密包，由其各自文档负责，不属于本 SOP 范围。
