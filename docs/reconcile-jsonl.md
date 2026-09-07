# WP4C 离线 DB-only reconcile analyzer（方案 A 收敛）：设计与运维 runbook

> **状态：WP4C（方案 A 收敛）当前交付物是安全 DB-only reconcile analyzer**（`pnpm reconcile-jsonl` / bin `pi-agent-server-reconcile-jsonl`）：只读 DB 引用（session id / project id / agent kind / conversation format / conversation_ref）+ 由 Pi storage 提供的纯字符串/lexical 规范布局绑定，输出 counts、固定 issue codes 与 opaque 引用（sha256），**绝不扫描文件系统、不读取任何 JSONL**。因此本工具**不能探测 orphan、lost 或 JSONL 损坏**（报告以固定 `filesystemNotScanned` / `cannotDetect` 字段明确声明），也**不执行任何处置**：`--apply` 立即 fail-closed，无任何确认词可绕过；不存在物理 delete/move/quarantine、DB 写入、outbox enqueue 或 v2 migration。真实 filesystem reconcile（探测 orphan/lost/JSONL 有效性并处置）留给未来受审计的 native helper（单独、尚未启动的事项）。WP4B 物理 executor 仍未实施（WP4B 与 WP4C 均为低集成度离线工具：不接入服务启动、不安装 worker、不触碰正式数据），两个工具连同正式 worker 均为离线开发期工具，整体尚非生产就绪。

## 1. 职责与边界

WP4C（方案 A 收敛）对 `sessions` 索引中的 JSONL 引用做**只读 DB reference 分析**：

- **受控只读 DB 引用** `src/application/ports/reconcile-reference-port.ts`：只取 session id / project id / agent kind / conversation format / conversation_ref 五个标识字段（纯 SELECT，`KyselyReconcileReferenceRepository` 方言中立；SQLite/PG 注册同一运行时契约，见 `tests/storage/reconcile-reference-contract.ts`）；**绝不选取 owner_key/title/system_prompt/cwd 等内容字段**，报告不可能泄漏 prompt 内容；
- **绝不触碰文件系统**：无 `DATA_DIR/sessions`、`DATA_DIR/projects` 递归遍历，无 lstat/open/readFile，不解析任何 JSONL。`DATA_DIR` 仅作为**纯字符串**（显式、绝对、非文件系统 root、路径段无 traversal）参与规范布局绑定——**不要求存在、不做 realpath/canonical 化、绝不扫描**；
- **null 引用 = normal unmaterialized**：`conversation_ref IS NULL` 表示懒会话尚未创建，计数进 `unmaterialized` 但**不是 issue**；
- **非 null 引用的纯字符串/lexical 验证**：绝对路径 → 位于指定 `DATA_DIR` 下的规范布局，**固定 literal 段逐字校验**——default project → `DATA_DIR/sessions/<sessionId>/<file>`（3 段），other project → `DATA_DIR/projects/<projectId>/sessions/<sessionId>/<file>`（5 段）；同段数伪目录（`sessions2/`、`Projects/`、`project/`、`foo/` 等非 literal 段）一律拒绝；同时拒绝 NUL、UNC（`//` 或 `\\` 开头）、traversal（`..`/`.`/空段）、空字符串、parsed root/volume 与 DATA_DIR 不一致（跨卷/伪 root）、错误 DATA_DIR 前缀（default 项目引用 `projects/` 布局、other 项目引用 `sessions/` 布局、不在任何布局根下）、id mismatch（路径中的 session id/project id 与 DB 行不一致）、非法 file name（须为单个非空 stem 的 `*.jsonl`）；
- **重复检测（owner 优先，与输入/ID 顺序无关）**：按 canonical reference（规范相对引用）分组；组内**完全匹配 layout 身份**（路径中的 session/project id 与 DB 行一致）的成员是 owner → `valid`（每 canonical 至多一个）；存在 owner 时组内其余成员一律 `duplicate_reference`；无任何 owner（该 canonical 的所属会话不在 DB 引用中）→ 组内成员一律 `invalid_reference`（id mismatch），不产生 duplicate。分类结果只依赖组内成员集合，不依赖输入顺序或 session id 的排序。由于 RC baseline 对 `sessions` 的 `(agent_kind, conversation_format, conversation_ref)` 建立了**非空唯一约束**（允许多个 NULL，见 `database-design.md`），规范数据库不可能再出现两个会话共享同一非空引用——`duplicate_reference` 只作为对异常/遗留库的**防御性分类**保留；从 canonical 库读取时 `duplicateReferences` 恒为 `0`。
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
  "invalidReferences": 1, "duplicateReferences": 0,
  "issues": [
    { "code": "invalid_reference", "count": 1, "references": ["<sha256>"] }
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
| `unmaterialized` | `conversation_ref` 为 null 的会话数（懒会话未创建：**normal，不是 issue**） |
| `valid` | 词法合法且为 canonical 组 owner（layout 身份完全匹配）的引用数 |
| `invalidReferences` | 词法非法引用数（空/NUL/UNC/非绝对/root/traversal/跨卷与伪 root/错误前缀/错误布局与同段数伪目录/id mismatch/非法 file name；含无 owner canonical 组的全部成员） |
| `duplicateReferences` | 重复引用数（同一 canonical reference 中 owner 之外的成员；owner 优先、与输入/ID 顺序无关）。规范库因非空唯一约束恒为 `0`；仅异常/遗留库可能出现非 0（防御性分类） |
| `issues[]` | 按固定 code 分组：`count` + `references`（sha256 opaque 引用；均为 session id 的 hash，绝不含路径原文） |

Issue codes（固定、有限）：

| code | 含义 |
| --- | --- |
| `invalid_reference` | 空/NUL/UNC/非绝对/root/越界 DATA_DIR/traversal/跨卷与伪 root/错误布局与同段数伪目录/id mismatch/非法 file name |
| `duplicate_reference` | 同一 canonical reference 被多个会话引用（owner 之外的成员）。规范库因非空唯一约束不可发生；仅异常/遗留库的防御性分类 |

错误输出只暴露稳定类别（`用法：…`、`reconcile-jsonl error: RECONCILE_FAILED`），绝不回显环境路径、URL、凭证或 DB 内容。

## 3. 为什么没有执行器、为什么不做 filesystem（方案 A 收敛决策）

- **不扫描文件系统**：方案 A 收敛后的 WP4C 只做安全 DB reference 分析——探测 orphan（磁盘有文件无引用）、lost（有引用缺文件）或 JSONL 损坏需要读取本地文件，属于未来 native helper 的职责；本工具绝不 pretend 能判定这些状态（`filesystemNotScanned` / `cannotDetect` 固定字段）；
- WP4C 物理处置（orphan 删除 / lost 恢复 / quarantine）、启动/定时 reconcile 与 outbox 写入**未实施**；`--apply` 立即 fail-closed（退出码 2），不存在任何确认词/维护窗口词可以绕过；
- 分析只读、不生成操作，因此不会带来误删/越界风险；执行路径需要另行评审（native helper 为单独事项）。

## 4. 验证入口

- `pnpm test`：DB-only 分类、只读、脱敏、fail-closed 和缺失 DB 零创建测试；
- `pnpm test:reconcile-jsonl-pg`：真实 PostgreSQL 只读门禁，缺少 `PI_TEST_PG_URL` 时非零退出；
- `pnpm build:reconcile-jsonl`：最小编译闭包、compiled/npm smoke 与禁止文件系统副作用模块检查；
- `pnpm verify:release` 汇总上述发布门禁。具体用例以测试源码和 `package.json` 为准，不在本文复制。

## 5. 相关文档

- [file-operations.md](file-operations.md)（安全只读 planner；physical executor 仍未实施）
- [备份与恢复](backup-restore.md)（WP4A backup contract；无 quarantine 载荷）
- [运维 runbook](operations.md)（离线工具入口）
- 数据库设计 [database-design.md](database-design.md)（sessions/projects 索引与 outbox 契约）
