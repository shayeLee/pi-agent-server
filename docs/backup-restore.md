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

### 原生共享内容归档（v2 migration）

`DATA_DIR=~/.pi/agent` 可以与 Pi CLI 共用 `sessions/--cwdencoded--/*.jsonl`，不转换成 managed/server-id 布局。SQLite/PostgreSQL backup（含 migration pre-backup）保存冻结 DB 中完整 `native_session_sources` 索引及墓碑。活动 claim 必须通过安全同 FD 的 `readNativeSourceSnapshot` 获取实际完整 v3 JSONL bytes，逐条归档到 `payload/native/<encoded-cwd>/<filename>.age`，manifest 标为 `archived` 并绑定相对路径、payload、plaintext/ciphertext hash 与 size；墓碑标为 `tombstone`，不读取已删除原件。原件缺失、allowroot 外路径、替换 inode、cwd/header/id 不符、symlink/hardlink 或不完整历史均拒绝发布，不降级成 external-required 或 missing-as-empty。

备份是独立的 **admin 离线数据备份 scope**，不是共享会话读权限：从固定 `PI_SESSION_SOURCE_DIR`（默认 `PI_CODING_AGENT_DIR/sessions` 或 `~/.pi/agent/sessions`）只读取冻结索引中注册的路径，始终验证原授权 binding 的 cwd/dev/ino/sourceId/sourceDev/sourceIno。它不应用 `PI_SESSION_SHARE_EXCLUDE_CWDS`，所以排除共享读取后仍可备份/迁移；不修改运行时 policy，不开放网络访问，不扫描/迁移整个原生库。判别依据是冻结 source claim，而不只看 format：新 Web 私有会话仍为 `pi-jsonl-v3`，但 `binding.private=true` 且 `visibility=private/origin=managed`，同样走 safe-FD 归档、恢复 encoded-cwd 布局并保留 private marker，绝不变成 scanner 可导入的 shared claim。无 claim 的历史 managed 布局走旧兼容路径；无历史的 managed NULL ref 保持 NULL。活动 private reservation 若 ref 为 NULL 或 inode 尚未落实，拒绝完整备份，要求先停 writer 并处理未完成 reservation，不伪造历史。

当前 owner-transfer CLI 未接线 `nativeSourceRoot`，有活动 source claim 时其 pre-backup 失败，不能执行转移；仅设置环境变量不能补齐该接线。库 API 调用须在 backup paths 注入 `nativeSourceRoot`；工厂/服务授权仍由运行时自行构造，不能复用备份 scope。未注册原生文件不是本 DB bundle 的接受面。

原生会话恢复到 `PI_RESTORE_NATIVE_SOURCE_ROOT`；未设置时默认为本次恢复目标内的 `<target-root>/native-sessions`，与恢复出的数据库同在隔离目标中，不写入正在使用的会话目录。需要直接恢复回某个会话目录（例如新机器上空的 `~/.pi/agent/sessions`）时再显式设置。原生会话总是恢复到原项目路径：不改写原始 header.cwd/bytes，也不支持换路径恢复，因此每个活动 binding.cwd 必须在本机以同一 canonical 路径存在。header.cwd 可以保留 `/project/.` 等备份已接受的写法，但恢复时仍须 realpath 到原项目目录且 dev/ino 相符；原项目不存在即拒绝。已移除的 `PI_RESTORE_NATIVE_CWD_MAP` 若仍被设置，restore CLI 直接报错提示取消。目标仅由当前配置的 source root、validated cwd 的 encoded directory 和安全文件名生成，包内绝对 source_path/binding 仅用于冻结 DB 对照，不是写入能力。完整验证后以私有 staging 文件的当前 inode 构造新 binding 和原生引用；墓碑保留且旧 inode authority 失效。已有目标（即使内容相同）拒绝覆盖；symlink/traversal/未认领 payload 拒绝。旧 `external-required` metadata 可识别，但缺归档内容的包拒绝完整恢复，不冒充历史恢复成功。

原生恢复阶段顺序：完整验证并私有装配 → 写本次 `NATIVE-RESTORE-CLEANUP.json`（目标、相对 staging 路径、source/session IDs、dev/ino，仅供人工核验）→ exclusive hardlink 到配置目录 → SQLite rename 发布包含已 remap DB 的演练目录 / PG rename 后完成 remap COMMIT → 删除演练目录内 staging hardlink → 删除记录。**DB 发布前始终保留两个 hardlink（nlink=2），native scanner 拒收；不得提前删除 staging link。** 最终 nlink=1。staging 与 native target 必须同文件系统，否则失败。普通发布前异常 finally 仅补偿本次创建且 inode 相符的 native 文件并清理本次临时目录，不覆盖原件或冲突文件；DB 发布后 finalize 失败保留已发布目录和核验记录，不声称恢复已完整成功。

**不做自动 resume、journal/outbox 或自动残留认领；不承诺 SIGKILL/断电无残留或跨路径原子性。** 备份中途崩溃与恢复中途崩溃不同：备份未完成包不是可恢复的包，确认本次 staging/未完成包后丢弃重做即可；恢复可能已创建原生目标及演练 DB，须按下面核验。本次选择人工清理后重做，不是待实现自动恢复的承诺。必须停止所有 writer（包括 CLI），目标由单个 restore 独占，禁止并发恢复。PG 导入后失败的隔离临时 DB 不由工具自动 drop；重做须由操作员提供另一全新空 DB。仅 PG mock 验证，不代表实库验收。

强杀后的人工处理（禁止按通配符清理共享目录）：
1. 确认所有相关 restore/writer 已退出；保留日志，确定**本次** `.pi-agent-restore-staging-<随机名>` 与 `restore-<UUID>`。记录在 rename 前位于该 staging 的 `assembled/`，rename 后位于该演练目录。无记录或归属无法确认时停止，不猜测、不删除共享源。
2. 记录是本机生成的人工核验线索，不是可信删除脚本输入。逐条核对目标位于本次显式配置的 native root、相对路径/IDs 与包中 claim 一致；以 lstat 确认无 symlink，目标 dev/ino 与记录一致，仍存在的 staging link 必须是同 inode。任何不符即保留文件并调查，绝不删除已有原件。
3. 检查 SQLite 演练目录/DB 是否已发布；PG 须人工查提交后的 native bindings，不能仅凭 rename/记录推断 COMMIT。如选择推倒重来，先逐条删除**本次核验匹配的 native 目标**，再清理**本次确认的**演练目录和 staging；反过来先删 staging 会把未发布 DB 的目标变成 nlink=1，严禁这样操作。不得删除原备份、原 DB、原生原件或其他运行的目录。无需清理共享 native 空目录。
4. 再运行完整恢复；已有目标仍报冲突，不自动认领。若 DB 已发布且选择保留结果，应核验 DB/source bindings 后仅完成本次 staging-link 清理，而不是再次恢复。SIGKILL 在 finalize 中间可能留下部分 nlink=1 文件，但此时 DB 已发布；仍需人工处理未清理部分。断电耐久性未验收。


旧 managed 历史包继续按已认证的历史布局恢复，不迁移或搬动真实用户文件。冻结 v1 pre-migration 包按 v1 schema 验证，不要求 v2 source 字段、不修改旧迁移 hash。逻辑删除不删除原件；不要为备份删除会话。

### 本轮验证记录（run61）

- Node 经 `volta run` 执行；`tsc --noEmit` 通过。SQLite backup/restore/native payload 定向套件：73 passed、2 skipped。
- native/private 定向检查（SQLite 与 PG 假进程）：10 passed。断言真实源 bytes 与归档解密 bytes 完全相等，删除原件后恢复文件仍相等、nlink=1；同 bundle 覆盖 native、新 private native-layout、legacy managed、NULL history 与 tombstone，private marker 保持。
- 广泛 backup/CLI/PG fake 检查曾为 207 passed、12 skipped、1 failed；剩余 `backup-staging.test.ts` 的历史 PG mock 不接受完整 sessions 查询，不能宣称全套通过。历史 fake catalog 固定 v1 ledger；新增 native/private fixture 明确使用当前 head。
- 未连接真实 PG、未运行服务/模型或真实用户迁移；PG fake 成功不是实库恢复验收。强杀后的自动恢复不在范围内；人工清理后重做与断电未验收边界见上文。

### review64 定向验证（人工清理后重做边界）

- Volta Node 24.19.0：`tsc --noEmit -p tsconfig.backup.json` 通过；native payload、SQLite backup/restore、PG mock、restore/migrate CLI 共 6 文件 **150 passed / 12 skipped**。未连接真实 PG、用户源库、服务或模型。
- temp 子进程在 `prepared / linked / renamed / finalizing / finalized` 五个阶段真实 SIGKILL：linked 时无发布 DB 且 native nlink=2，source helper 拒收；renamed 时 SQLite DB 已发布但仍 nlink=2；finalizing/finalized 时 nlink=1 且 DB binding dev/ino 匹配。残留不自动认领，重跑对已有目标报冲突，核验并只清理本次 temp 产物后重做成功；原始源 bytes 不变。
- 普通异常在 linked 后注入：本次目标和临时目录清理；已有冲突文件不变。PG mock 在 rename 前后及 COMMIT 后断言 native nlink=2，仅提交后 finalize 为 nlink=1。SQLite/PG `/cwd/.` header 字节保持，任意 cwd 映射拒绝；覆盖 native/private、legacy、NULL 历史及 pre-migration 包。

## 2. 已落地语义（missing-as-empty / opaque JSONL / invalid-as-empty）

| 场景 | 行为 |
| --- | --- |
| DB 源 ledger 缺失、旧多行、字段/顺序错误或 checksum 不匹配 | backup（包括 `--dry-run`）在任何 age 加密、`COMPLETE`、发布或成功报告之前 fail-closed；不能推进 freshness |
| DB 引用的 managed JSONL 缺失 | 按 `missing-as-empty` 记录进加密 manifest 并允许发布；`--require-complete-session-references` 已退役，owner-transfer pre-backup 同样不再 fail |
| backup 读取已有 managed JSONL | 仅作 opaque bytes 稳定复制，不检查内容合法性（不逐行 `JSON.parse`） |
| restore 遇到 manifest 中的 missing | 对应 `sessions.conversation_ref` 写为 `NULL` |
| restore 遇到内容无效 managed JSONL | 丢弃该历史、对应引用写为 `NULL`，报告 `invalidSessionHistories` 数量（degradation）；其他会话照常恢复 |
| 包/密文/hash 损坏 | 仍整体失败；不得降级为空历史 |

机器报告（`backup-json-report`）只在通过已认证的 canonical 迁移前缀检查且成功发布的非 dry-run backup 上恰好一行；失败或 dry-run 均无成功报告，因此不能推进 freshness。`missingSessionReferences` 可以大于零，缺失历史不阻止发布。managed 无效检测是 restore 对已装配 payload 的本地结构解析（managed backup 不做；不使用 SDK `SessionManager.open`）。原生内容在 backup 时还必须验证已注册 source/header 的真实性，恢复原生无效内容整体失败，不能降级为空。

## 3. 备份包契约

- **源 DB 接受面与发布前置条件**：SQLite 与 PostgreSQL 的冻结 snapshot/dump 须持有已认证的 canonical 迁移前缀。若包含 `uploaded_files` 行（包括未关联上传），须显式提供 `PI_UPLOAD_STORAGE_ROOT`；每行所指原件均须稳定存在、大小与 SHA-256 匹配，否则 fail-closed。v2 加密包逐条绑定 DB 行与 `payload/attachments/<storageKey>.age`；无附件仍产出兼容的 v1 包。失败不发布 `COMPLETE`、不发 freshness 成功报告；`--dry-run` 也失败。
- manifest 与每个 payload 均由 age 加密；记录 plaintext/ciphertext hash 与 size。
- `COMPLETE` 最后写入并绑定 encrypted manifest hash；只有同文件系统原子 rename 完成后的目录才算发布。
- plaintext staging 必须是私有 0700 目录，不能位于 backup root 或其父目录；失败路径清理 staging。backup root 内 staging 只含密文。
- restore 验证 `COMPLETE`、manifest、payload hash、migration ledger、schema 以及 package allowlist。任何密文、hash、manifest 或解密错误都 fail-closed。
- **restore 只接受已认证的迁移前缀**：manifest ledger 逐行校验 checksum；无 ledger、未知版本或不匹配在载荷解密/staging 前 fail-fast。v1 包只能恢复无附件的 DB；若其中出现上传记录，拒绝恢复。v2 必须验证 DB 中**每一条**上传行与 manifest、密文原件一一对应，不允许附件 missing-as-empty；还须提供 `PI_RESTORE_UPLOAD_AGENT_ROOT` 并在隔离环境验证目标挂载后才使用。JSONL 历史仍按原 v3 规则处理。
- 恢复时校验 `file_operations` 行，但绝不执行其中的删除任务。v1 中合法的未确认 requestId 预约会保留为「状态未知」去重屏障，不能误认为执行完成或删去后重跑；损坏的预约拒绝恢复。

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
- `--dry-run` 不发布任何包，仍执行 canonical 迁移前缀检查；缺 ledger、未知/错序版本或 checksum 不匹配必须非零失败，不得报告可成功。
- 运行时只接受当前 Pi JSONL v3：持久会话在 `SessionManager.open` 前先验证 header `version:3`，v1/v2 或畸形历史 fail-fast 且不改写文件；只读 export 同样拒绝旧版本，绝不调用 SDK `migrateSessionEntries`。

`pnpm backup` 只用于人工开发/演练。自动备份由部署方审核的 helper/timer 调用固定编译产物；源码更新后必须重新构建该产物，不得用旧产物继续调度。

### 4.1 宿主 SQLite 正式定时备份（systemd oneshot + timer，参数化）

本节给出**通用**的宿主 SQLite 定时备份模板：与 [operations.md](operations.md) 使用同一个 `agent-server` 服务账号、同一份 `DATA_DIR`/`DB_PATH` 与源码目录（root 拥有、服务账号只读）；活动 source claim 的稳定性要求见步骤 4。插件或扩展数据可能有各自的备份链路，不属于本流程。以下路径/账号沿用 operations.md 的示例值，**正式值须先按 §1 由运维确认**，确认前不得当作默认值。

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
# 与服务配置使用同一来源根（独立于 DATA_DIR/PI_AGENT_DIR）：
PI_SESSION_SOURCE_DIR=/var/lib/pi-agent-server/sessions
PI_BACKUP_STAGING_ROOT=/srv/pi-agent-backup-staging
# 有非图片上传时另由部署者填入与服务同一、经核验的绝对原件目录：
# PI_UPLOAD_STORAGE_ROOT=/absolute/private/upload-root
```

- `PI_AUTH_PATH` 必须与 operations.md 一致，使 backup CLI 的凭证重叠校验作用于真实凭证位置；backup 绝不包含凭证内容（见 §1）。
- 数据库有上传行时，备份环境必须配置与服务一致的 `PI_UPLOAD_STORAGE_ROOT`；原件目录与备份根、凭证不得重叠。未确认目录或原件完整性时不得发布备份。
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
- SQLite 备份使用在线 `VACUUM INTO` 快照，managed 旧布局无需停服。存在活动 source claim 时，源文件变化会使安全 FD 校验失败；需要稳定完整备份时停止所有相关 writer（包括 CLI）。不承诺 DB 与 JSONL 或插件/扩展数据的跨存储原子一致点。
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

### 5.1 完全空目标建立 canonical 迁移 head

完全空 SQLite DB 或完全空 non-public/non-system PostgreSQL schema，须离线建立完整的 v0→v1→v2→v3→v4→v5→v6→v7 head：

```bash
pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED
```

`--bootstrap-baseline` 不可混用 `--backup-root`、`--age-recipient-file`、`--maintenance-window` 等 backup/maintenance 参数，也不会创建 pre-backup。它建立已认证的完整迁移 head；完成后先执行 `--verify`，服务启动仍只接受 verify。

### 5.2 已有 canonical 前缀的增量 apply

`--apply` 将已有已认证 v0、v0→v1、v0→v1→v2、v0→v1→v2→v3、v0→v1→v2→v3→v4、v0→v1→v2→v3→v4→v5 或 v0→v1→v2→v3→v4→v5→v6 前缀增量迁移到当前 v7 head（v3 只新增 `companion_personas` 表，v4 只新增 `project_mcp_servers` 表，v5 只新增 `mcp_oauth_clients` 与 `user_mcp_credentials` 表，v6 只给 `project_mcp_servers` 加一个可空列 `server_identity`，v7 只新增 `accounts`、`login_methods`、`auth_sessions` 与 `api_tokens` 表）。正式顺序为 **pre-backup → apply → verify**：

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
- restore 不自动迁移；包须携带已认证 v0、v0→v1、v0→v1→v2、v0→v1→v2→v3、v0→v1→v2→v3→v4、v0→v1→v2→v3→v4→v5、v0→v1→v2→v3→v4→v5→v6 或 v0→v1→v2→v3→v4→v5→v6→v7 前缀，未知、错序或不匹配的 ledger 在解密/staging 前 fail-fast。含上传文件元数据却缺原件的 v1 包不可恢复；v2 包逐项校验加密原件，源库文件缺失或不稳定时拒绝发布。完全空目标可用于隔离 restore；`--bootstrap-baseline` 不创建 pre-backup，也不生成可恢复的 backup package。
- 用户的 MCP OAuth 凭证（v5）在库里只有 AES-GCM 密文，备份包不含 `PI_MCP_TOKEN_KEY_FILE`。恢复后用同一份密钥文件，这些凭证才能继续用；密钥丢失时凭证读不出来，用户在面板重新授权即可，不影响恢复本身。
- 恢复出来的数据库**没有人处于登录状态**（v7 及以后的备份）：发布恢复结果之前，删除全部 `auth_sessions`（所有人重新登录），并给所有还没吊销的 `api_tokens` 写上 `revoked_at`（之后用 `pnpm accounts -- issue-token` 重新签发，bridge 换新 token）。因为恢复出来的库不知道备份之后有哪些登录已登出、token 已吊销。SQLite 在 staging 库的重映射事务里做，PostgreSQL 在重映射事务 COMMIT 之前做，失败则整个恢复失败。报告的 `counts.authSessionsCleared` 和 `counts.apiTokensRevoked` 是清掉的条数。SQLite 的 dry-run 在临时副本上算出同样的条数，不改目标；PostgreSQL 的 dry-run 不执行 `pg_restore`，这两项报 0。v7 之前的备份没有这两张表，两项都是 0。
- age identity 由运维在执行时提供。一次成功解密和恢复演练是“私钥可用”的必要证据。
- 目标 missing/invalid-as-empty 语义见 §2，恢复行为以该表为准。

## 7. 失败处理

- 备份、源 ledger、age、manifest、hash、target、schema 或版本校验失败：不执行后续 migration，不更新 freshness。
- migration 失败：保留已发布 pre-migration 包，不自动 down 或恢复。
- restore 普通发布前失败：补偿本次产物，不覆盖已有目标；强杀/断电可能留下 staging、native hardlink 或已发布演练目录，DB 发布后 finalize 也可能失败，不能承诺绝不部分残留。保存脱敏错误和证据，按上文逐条核验清理后重做，不自动认领。
- 日志和证据不得包含数据库 URL、密码、token、age identity、原始 argv、会话路径或正文。

## 8. RPO、RTO 与保留期

- **RPO 目标：24 小时**，仅在加密备份成功并已完成含附件原件的隔离恢复演练后适用。部署计划以固定不超过 12 小时的完整备份节奏留出执行和告警预算（宿主 SQLite 定时备份模板见 §4.1）；附件缺失或不稳定时备份 fail-closed，不得报告 freshness 成功或宣称达到 RPO。
- **RTO 目标：4 小时；signoff 延期**。项目投入使用且有代表性数据规模后，再授权隔离环境完成 `restore → migration verify → start → health/readyz → 合成业务检查 → serviceable` 全流程计时并签署；此前只记录功能性恢复证据，不宣称 RTO 已验收。
- **备份保留：30 天**。自动删除未实现；由运维人工审核并清理过期备份。备份保留不延伸为会话、日志或审计数据的保留承诺。
- **恢复演练：每季度及重大 migration 前**。当前 RTO signoff 延期不取消功能性恢复演练要求；演练必须使用隔离 target-like 环境和合成数据，通用步骤见 §9。

## 9. 恢复演练 SOP（参数化）

本节给出通用的隔离恢复演练流程，适用于任何符合本契约的备份包，不绑定具体主机、路径、账号或插件，也不需要任何仓库内的一次性脚本。演练全部使用官方恢复 CLI。

备份包根路径与 age identity 由运维环境以绝对路径配置，值由部署方保管，不得写入仓库、日志或证据：

```bash
export BACKUP_ROOT=/absolute/ops/backup-root          # 备份包所在根目录
# v2 附件包恢复前须显式配置目标根在 Pi 中的映射，并在部署中核验挂载：
# export PI_RESTORE_UPLOAD_AGENT_ROOT=/absolute/pi-visible/target-root
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
