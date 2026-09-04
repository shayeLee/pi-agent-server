# WP4C 离线 DB-only reconcile analyzer（方案 A 收敛）：设计与运维 runbook

> **状态：WP4C（方案 A 收敛）✅ 已验收。** 当前交付物是**安全 DB-only reconcile analyzer**（`pnpm reconcile-jsonl` / bin `pi-agent-server-reconcile-jsonl`）：只读 DB 引用（session id / project id / pi_session_file）+ 纯字符串/lexical 规范布局绑定，输出 counts、固定 issue codes 与 opaque 引用（sha256），**绝不扫描文件系统、不读取任何 JSONL**。因此本工具**不能探测 orphan、lost 或 JSONL 损坏**（报告以固定 `filesystemNotScanned` / `cannotDetect` 字段明确声明），也**不执行任何处置**：`--apply` 立即 fail-closed，无任何确认词可绕过；不存在物理 delete/move/quarantine、DB 写入、outbox enqueue 或 v2 migration。真实 filesystem reconcile（探测 orphan/lost/JSONL 有效性并处置）留给未来受审计的 native helper（单独、尚未启动的事项）。**验收证据**：用户提供的完整真实 PG16+age `verify:release` 成功证据包含真实 PostgreSQL reconcile gate 及 compiled/npm smoke，WP4C 据此验收。本文不记录或推导测试数量。WP4B 物理 executor 仍未实施（WP4B 与 WP4C 均为低集成度离线工具：不接入服务启动、不安装 worker、不触碰正式数据），两个工具连同正式 worker 均为离线开发期工具，整体尚非生产就绪。

## 1. 职责与边界

WP4C（方案 A 收敛）对 `sessions` 索引中的 JSONL 引用做**只读 DB reference 分析**：

- **受控只读 DB 引用** `src/application/ports/reconcile-reference-port.ts`：只取 session id / project id / pi_session_file 三个标识字段（纯 SELECT，`KyselyReconcileReferenceRepository` 方言中立；SQLite/PG 注册同一运行时契约，见 `tests/storage/reconcile-reference-contract.ts`）；**绝不选取 owner_key/title/system_prompt/cwd 等内容字段**，报告不可能泄漏 prompt 内容；
- **绝不触碰文件系统**：无 `DATA_DIR/sessions`、`DATA_DIR/projects` 递归遍历，无 lstat/open/readFile，不解析任何 JSONL。`DATA_DIR` 仅作为**纯字符串**（显式、绝对、非文件系统 root、路径段无 traversal）参与规范布局绑定——**不要求存在、不做 realpath/canonical 化、绝不扫描**；
- **null 引用 = normal unmaterialized**：`pi_session_file IS NULL` 表示懒会话尚未创建，计数进 `unmaterialized` 但**不是 issue**；
- **非 null 引用的纯字符串/lexical 验证**：绝对路径 → 位于指定 `DATA_DIR` 下的规范布局，**固定 literal 段逐字校验**——default project → `DATA_DIR/sessions/<sessionId>/<file>`（3 段），other project → `DATA_DIR/projects/<projectId>/sessions/<sessionId>/<file>`（5 段）；同段数伪目录（`sessions2/`、`Projects/`、`project/`、`foo/` 等非 literal 段）一律拒绝；同时拒绝 NUL、UNC（`//` 或 `\\` 开头）、traversal（`..`/`.`/空段）、空字符串、parsed root/volume 与 DATA_DIR 不一致（跨卷/伪 root）、错误 DATA_DIR 前缀（default 项目引用 `projects/` 布局、other 项目引用 `sessions/` 布局、不在任何布局根下）、id mismatch（路径中的 session id/project id 与 DB 行不一致）、非法 file name（须为单个非空 stem 的 `*.jsonl`）；
- **重复检测（owner 优先，与输入/ID 顺序无关）**：按 canonical reference（规范相对引用）分组；组内**完全匹配 layout 身份**（路径中的 session/project id 与 DB 行一致）的成员是 owner → `valid`（每 canonical 至多一个）；存在 owner 时组内其余成员一律 `duplicate_reference`；无任何 owner（该 canonical 的所属会话不在 DB 引用中）→ 组内成员一律 `invalid_reference`（id mismatch），不产生 duplicate。分类结果只依赖组内成员集合，不依赖输入顺序或 session id 的排序；
- **报告**：仅 counts、固定 issue codes 与 opaque 引用（sha256 十六进制），**绝不包含 relative/absolute 路径、DATA_DIR、URL、session id 或 prompt 内容**；`executable` 恒为 `false`；`filesystemNotScanned: true` 与 `cannotDetect: { orphanFile: false, lostFile: false, jsonlValidity: false }` **明确声明不能探测 orphan/lost/JSONL 损坏**；
- 不接入 `startServer`、不安装 timer/scheduler；真实 filesystem reconcile 与处置需受审计的外部运维工具或未来 native helper（单独事项）。

**native helper 说明**：方案 A 收敛后的物理对账（探测并处置 orphan/lost/JSONL 损坏文件）需要审计过的外部运维工具或未来实现的 native helper（单独工作项，未开始），本 analyzer 不 pretend 能探测或执行。

## 2. CLI 用法

```bash
# 只读 DB reference 分析（零写入；默认模式）
DATA_DIR=/absolute/application/data \
DB_PATH=/absolute/application/data/pi-agent-server.db \
pnpm reconcile-jsonl -- run

# 显式 --dry-run（与默认一致）
DATA_DIR=/absolute/application/data \
DB_PATH=/absolute/application/data/pi-agent-server.db \
pnpm reconcile-jsonl -- run --dry-run

# PostgreSQL（显式方言 + URL；DB_PATH 不需要）
PI_STORAGE_DIALECT=postgres \
PI_DATABASE_URL=postgresql://... \
DATA_DIR=/absolute/application/data \
pnpm reconcile-jsonl -- run
```

- 参数规则：只接受 `run` 与可选 `--dry-run`（重复出现拒绝）；`--apply`、执行器/确认词参数（`--confirm-*`、`--maintenance-window`、`--limit`、`--quarantine-*` 等）与未知参数一律拒绝（退出码 2）；**未知参数不回显原始 argv**，错误输出只含稳定类别；
- `DATA_DIR` 纯字符串契约：显式、绝对、非文件系统 root、路径段无 traversal（尾随分隔符按同一目录处理）；**不要求存在、不做 realpath**——本分析是纯 DB reference 分析，绝不扫描文件系统；
- 连接规则：SQLite 需要显式绝对 `DB_PATH`，以 `readOnly: true` 打开——文件不存在时直接失败（**绝不创建 DB/WAL/SHM**），已存在的库保持字节指纹不变；**SQLite 只读打开是本 CLI 唯一必要的文件系统访问**——CLI 主入口识别只用纯 path/fileURL 判断（无 realpath/stat，installed bin 按已知 bin 名兜底），源代码零 `node:fs` 导入，绝不扫描 DATA_DIR/JSONL；
- PG 连接规则：需要显式 `PI_STORAGE_DIALECT=postgres` + `PI_DATABASE_URL`；连接串**严格校验**（协议必须是 `postgres://`/`postgresql://`、host 与 database 显式存在、禁止 fragment）；`options` 参数**严格解析，只允许 `search_path`**（`-c search_path=<schema 列表>`，至多一次，值为未引用标识符的逗号分隔列表），其余任何选项（`statement_timeout`、`ssl` 等 GUC、`--` 注入形态）一律拒绝并 fail-closed——绝不透传、绝不降级为可写连接；CLI 自动合并 `-c default_transaction_read_only=on` 与 `-c lock_timeout=10000`，并以有界超时建池（connect 10s / query 15s / statement 15s，lock 10s）；
- 库头校验：CLI 先以只读 `verify` 模式校验 migration ledger 与 schema head（不 apply、不写 ledger）；库不在 head 时拒绝；
- 报告（stdout JSON）只含计数、固定 issue codes 与 opaque 引用；每次成功运行在 stderr 输出人类可读的“只读 DB reference 分析、不扫描文件系统、不执行”说明：

```json
{ "status": "analyzed", "dialect": "SQLite", "mode": "dry-run", "executable": false,
  "filesystemNotScanned": true,
  "cannotDetect": { "orphanFile": false, "lostFile": false, "jsonlValidity": false },
  "references": 4, "unmaterialized": 1, "valid": 2,
  "invalidReferences": 1, "duplicateReferences": 1,
  "issues": [
    { "code": "invalid_reference", "count": 1, "references": ["<sha256>"] },
    { "code": "duplicate_reference", "count": 1, "references": ["<sha256>"] }
  ] }
```

字段语义：

| 字段 | 含义 |
| --- | --- |
| `status` | 恒为 `analyzed`（纯 DB reference 分析；不存在扫描级失败状态） |
| `executable` | 恒为 `false`：本工具永不执行处置（执行需受审计外部运维工具或未来 native helper） |
| `filesystemNotScanned` | 恒为 `true`：明确声明本分析不扫描文件系统、不读取任何 JSONL |
| `cannotDetect` | 固定 false 字段：`orphanFile` / `lostFile` / `jsonlValidity`——不扫描文件系统就不能判定这些状态，绝不 pretend 能探测 |
| `references` | DB 引用行数（受控只读引用列表行数） |
| `unmaterialized` | `pi_session_file` 为 null 的会话数（懒会话未创建：**normal，不是 issue**） |
| `valid` | 词法合法且为 canonical 组 owner（layout 身份完全匹配）的引用数 |
| `invalidReferences` | 词法非法引用数（空/NUL/UNC/非绝对/root/traversal/跨卷与伪 root/错误前缀/错误布局与同段数伪目录/id mismatch/非法 file name；含无 owner canonical 组的全部成员） |
| `duplicateReferences` | 重复引用数（同一 canonical reference 中 owner 之外的成员；owner 优先、与输入/ID 顺序无关） |
| `issues[]` | 按固定 code 分组：`count` + `references`（sha256 opaque 引用；均为 session id 的 hash，绝不含路径原文） |

Issue codes（固定、有限）：

| code | 含义 |
| --- | --- |
| `invalid_reference` | 空/NUL/UNC/非绝对/root/越界 DATA_DIR/traversal/跨卷与伪 root/错误布局与同段数伪目录/id mismatch/非法 file name |
| `duplicate_reference` | 同一 canonical reference 被多个会话引用（owner 之外的成员） |

错误输出只暴露稳定类别（`用法：…`、`reconcile-jsonl error: RECONCILE_FAILED`），绝不回显环境路径、URL、凭证或 DB 内容。

## 3. 为什么没有执行器、为什么不做 filesystem（方案 A 收敛决策）

- **不扫描文件系统**：方案 A 收敛后的 WP4C 只做安全 DB reference 分析——探测 orphan（磁盘有文件无引用）、lost（有引用缺文件）或 JSONL 损坏需要读取本地文件，属于未来 native helper 的职责；本工具绝不 pretend 能判定这些状态（`filesystemNotScanned` / `cannotDetect` 固定字段）；
- WP4C 物理处置（orphan 删除 / lost 恢复 / quarantine）、启动/定时 reconcile 与 outbox 写入**未实施**；`--apply` 立即 fail-closed（退出码 2），不存在任何确认词/维护窗口词可以绕过；
- 分析只读、不生成操作，因此不会带来误删/越界风险；执行路径需要另行评审（native helper 为单独事项）。

## 4. 门禁与测试

- `pnpm test`（无 PG URL）：核心/CLI 集成用例全跑——DB-only 分类矩阵（default/nondefault 固定段布局、同段数伪目录拒绝、null unmaterialized、id mismatch、错误前缀、跨卷/伪 root、NUL/UNC 拒绝、traversal 拒绝、非法 file name、canonical 重复检测的 **owner 优先且与输入/ID 顺序无关**、DATA_DIR 纯字符串契约且不要求存在）、报告 redaction（无路径/URL/session id/prompt 内容、`filesystemNotScanned`/`cannotDetect` 固定字段、executable:false）、缺失 DB 零创建（无 DB/WAL/SHM）、已有 DB 字节指纹不变、`--apply` 零写 fail-closed、未知/重复参数退出码 2 且不回显原值、只读引用运行时契约（SQLite 始终注册；PG 按既有门控）、CLI 主入口源码级零 fs（无 `node:fs`/realpath；SQLite 只读打开为唯一必要 FS）、PG URL 严格校验与 options 严格解析（仅 `search_path` 被接受并合并只读/lock；其余拒绝且错误脱敏）；`tests/postgres/reconcile-jsonl.test.ts` 与 PG 引用契约按既有门控 skip；
- `pnpm test:reconcile-jsonl-pg`：**强制真实 PostgreSQL reconcile 门禁**（无 `PI_TEST_PG_URL` 非零失败），在随机专属 schema 上跑只读分析用例：fixture 用 `runPostgresMigrations` apply（**含 ledger**）、种子数据一律 **$1 参数绑定（绝不用 ident() 拼值）**、**不创建/写入任何文件**（DATA_DIR 只是词法绑定字符串）；门禁环境 URL 先经严格校验（协议/host/database/fragment）；只读连接由生产代码（`enforceReadOnlyPostgresUrl`）构造——严格解析仅 `search_path` options 并合并 `default_transaction_read_only=on` 与 `lock_timeout`（`SHOW` 三断言：schema 可见 + 服务端只读 + 有界 lock），迁移 verify 只读可用、写操作被服务端拒绝、零 DB 变化、finally 语义可靠 DROP SCHEMA CASCADE；**绝不创建任何 LOGIN role / 不使用 CREATEROLE**——真实 CLI（`scripts/reconcile-jsonl.ts` 经 tsx）直接使用随机 schema URL（`search_path` options），并验证随机 schema 隔离、只读、零 DB 变化、stdout/stderr 无 URL/path/credential 泄漏、URL options 含非 search_path 内容时 CLI fail-closed；
- `pnpm build:reconcile-jsonl`：**先清空 `dist-reconcile` 再编译**，编译只包含**最小依赖闭包**（tsconfig.reconcile-jsonl.json 只收录入口与 `src/{application,file-operations,storage}` 的必要模块），compiled-CLI smoke 与 npm install bin smoke 均执行禁止文件/符号链接卫生检查 + **闭包断言**（dist-reconcile 不含 `server/start` runtime、backup/cutover、outbox writer / WP4B planner 域模块等文件系统副作用模块），并验证 dry-run 零写与指纹、缺失 DB 零创建、DATA_DIR 纯字符串契约且不要求存在、`--apply` exit 2、未知参数 exit 2、报告无绝对/相对路径、包内无残留产物；
- `pnpm verify`（日常）、`pnpm verify:release`（发布）均接入 `build:reconcile-jsonl`；发布链额外接入 `test:reconcile-jsonl-pg`。**WP4C 已验收**：用户提供的完整真实 PG16+age `verify:release` 成功证据包含真实 PostgreSQL reconcile gate 及 compiled/npm smoke；本文不记录或推导测试数量。

## 5. 相关文档

- [数据保留计划](phase-3-data-retention-plan.md)（WP4C 状态与工作包）
- [file-operations.md](file-operations.md)（WP4B 安全只读 planner；physical executor 仍未实施）
- [备份与恢复](backup-restore.md)（WP4A backup contract；无 quarantine 载荷）
- [运维 runbook](operations.md)（离线工具入口）
- 数据库设计 [database-design.md](database-design.md)（sessions/projects 索引与 outbox 契约）