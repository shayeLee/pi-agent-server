# WP5C 方案 B：backup freshness 实际部署演练 SOP

> **状态（不可曲解）**：本 SOP 已落地，作为部署方的实际部署演练与签署入口；实际演练按用户决定 **deferred（暂缓）**，本次不执行、不启动目标服务、不接触正式数据或正式服务。**Strict backup completeness foundation 已验收；WP5C 方案 B 未验收，WP5 整体未验收，服务仍非 production-ready。**任何未来执行前，用户必须再次明确授权目标环境、演练窗口和负责人；未获再次授权不得开始。
>
> 本文是执行 SOP，不是仓库实现。所有自动化均指部署方已经审核的 helper/timer；本仓库不交付、不安装、不展示通用 root helper、systemd unit、launchd plist、shell 运行脚本或可复制的跨 OS 原子发布实现。契约细节以 [backup-freshness-exporter.md](backup-freshness-exporter.md) 为准；该契约的部署验收仍以本文 SOP 的实际演练证据为前提。

## 1. 目的、范围与硬边界

### 1.1 目标链路

在**隔离、target-like 环境**证明以下责任链可工作且故障安全：

```text
部署方审核的 external reviewed helper/timer
  → 固定编译产物 backup CLI
  → strict backup（--require-complete-session-references）
  → 机器可读 published report
  → 仅该 target 的 atomic per-target textfile
  → node_exporter textfile collector
  → Prometheus 独立持久 inventory
  → Alertmanager
```

演练目标是部署边界，不是新增业务代码或服务集成。必须证明：strict backup 成功才允许 freshness 前进；失败不发布、不更新指标；监控控制面独立维护 expected inventory；Prometheus 能发现缺失、过期、未来时间、exporter 或 textfile 故障。

为避免标签集合歧义，沿用契约定义：`I = pi_agent_server_backup_expected_target_info{job,cluster,instance}=1`（独立 inventory），`F = pi_agent_server_backup_last_success_timestamp_seconds`，`U = up`，`T = node_textfile_scrape_error`，`A = U or F or T`（均按完整 `(job, cluster, instance)` 匹配）。`I unless A` 与 `A unless I` 仅用于 Q3 的 inventory/actual 漂移集合比较；它们不是 freshness missing 告警的表达式。freshness missing 必须精确使用 `I exists AND U == 1 AND F missing`（即 `(I and U==1) unless F`）。I 不能由被监控 target 自己产生。

### 1.2 禁止事项

- 本次任务不执行演练、不运行业务代码测试、不提交 git；未来演练也**禁止使用正式数据、正式数据库、正式服务、正式 backup root 或正式 Alertmanager receiver**。
- 执行前必须再次获得用户对**目标环境**的明确授权；“SOP 已落地”不等于“演练已授权”或“演练已完成”。
- WP5C 方案 B 仅为已形成、可评审的部署契约；实际演练完成并签署前，**WP5C 不验收，WP5 不验收**。Strict foundation 的接受不扩展为 helper/timer、exporter、Prometheus 或 Alertmanager 的接受。
- 任何 helper/timer 必须是部署方独立审核的实现。本仓库不提供通用 root helper、特权降权逻辑、systemd/launchd 配置、timer 示例或可复制脚本。
- secret 不得出现在 argv、unit/plist、日志、stdout、stderr、报告、Prometheus label 或 evidence；不打印 URL、密码、token、age identity/private key、session id、路径细节或原始子进程错误。

## 2. 前置关系与两阶段计划

### 2.1 阶段一：预发布隔离演练

目的：在不改变任何正式部署的前提下，端到端验证 helper/timer → backup → textfile → node_exporter → Prometheus → Alertmanager。

- 使用 disposable target-like 主机/容器/虚拟机、隔离的本地 backup root、隔离 textfile 目录、隔离 Prometheus 与 Alertmanager receiver。
- 使用合成 SQLite/PG fixture 和专用 age recipient；恢复或解密验证使用一次性、非正式 age identity。
- **无需常驻 Agent Server**：可停止或不启动 Agent Server，仅准备与实际部署等价的 `AGENT_CWD`、`DATA_DIR`、DB、JSONL、`.pi-agent/models.json` 和配置边界。
- 由部署方已审核的 helper/timer 做一次成功路径和全部失败注入；不把 `pnpm backup` 当作自动化入口。

### 2.2 阶段二：正式启用前配置复验

目的：正式启用前重新确认配置、权限、版本、标签和告警接线没有漂移。仍可使用合成数据，不能使用正式服务或正式数据。

- 复核固定 `dist-backup` 运行时传递闭包、祖先链、pinned Node、age/PG 工具、env 通道、ACL、backup root、staging 和 textfile 目录。
- 复核每个 target 的 `(job, cluster, instance)` 三元组、独立 inventory、Prometheus scrape 与 Alertmanager route。
- 至少重复 strict missing-reference、stale、future、exporter-down、textfile scrape error 和 secret/redaction 的关键探针；其余结果引用阶段一证据，但若配置、镜像、OS、版本或路径改变必须重新执行相关项。任何平台调度配置变更都必须重新执行至少一次 scheduler-originated 正常 run，并重新记录配置摘要、上次/下次 trigger 和实际 start；手动 run 不能替代该调度验收。
- 阶段二仍不构成生产启用授权；需另有用户/变更审批，并重新判断 go/no-go。

## 3. Fixture 与隔离布局

### 3.1 通用 fixture 要求

每个 target 使用唯一、可回收的 fixture 标识；数据、DB、JSONL、staging、encrypted backup、textfile、Prometheus TSDB 和 Alertmanager receiver 均在隔离资源中。fixture 必须包含：

- 至少一个有效 session reference 和对应 JSONL；一个项目布局（如适用）；`models.json`；应用 schema/ledger；
- 一份可成功发布的完整 strict backup；
- 一份可控的 missing-reference 变体，用于验证首个 ciphertext/`COMPLETE` 之前 fail-closed；
- 可记录的固定 target identity、backup start epoch、artifact closure digest 和配置版本。

fixture 的 session id、路径、URL、凭证和密钥值只存在于受限运行环境，不得进入报告或证据包。失败注入只改变隔离 fixture 或临时配置，完成后恢复或销毁隔离资源。

### 3.2 SQLite fixture

- 使用隔离的绝对 `DATA_DIR`、`DB_PATH`，数据库按实际形态包含 DB/WAL/SHM；若启用 WAL，三者作为测试对象，不直接复制活动数据库文件代替 `VACUUM INTO`。
- DB 中的 session reference 必须指向 canonical JSONL 白名单布局；有效 fixture 先确认可生成 strict published package。
- missing-reference 变体只在隔离 fixture 中删除或改名被引用 JSONL，或插入指向不存在文件的引用；预期 strict CLI 非零退出，发布目录没有新 package/`COMPLETE`，textfile 不变。
- 不启动 Agent Server；如需模拟并发写窗口，使用部署方审核的隔离 fixture 操作，不使用正式 DB。

### 3.3 PostgreSQL fixture

- 使用 disposable 专用 database/schema 和专用低权限账号；禁止 `public`/系统 schema 作为 authenticated source 或 restore target，禁止正式 URL。
- `pg_dump`、`pg_restore` 与 PostgreSQL server **major 必须一致**；执行前记录 server、dump client、restore client 三者 major，任何不一致都 no-go。客户端路径必须是已审核绝对路径或受控 root-owned safe PATH。
- 在与实际部署等价的权限下创建应用 schema、ledger、session reference 与 JSONL fixture；使用专用 staging 和备份根。
- 使用隔离的 age recipient 完成加密；restore drill 使用一次性专用 age identity，与正式私钥完全隔离。age/age-keygen 版本和 resolved path 必须记录但不得泄露 identity 内容。
- PG failure fixture 可通过受控的 schema/reference 变化、工具版本不匹配、工具失败或缺失配置注入；不得修改正式数据库。

### 3.4 固定 artifact closure 与权限

验收对象不是单个入口文件，而是整个固定 `dist-backup` runtime closure（全部 import/require 到达文件/目录、根外依赖及其祖先链）及 pinned Node。执行前确认：

- closure 和从 `/` 到其根的祖先链都是 root-owned、真实对象、无 symlink、无 group/world write；
- Node 是部署记录中的确切版本且 `>=22.19.0`，backup 用户实际可执行；helper 每次运行验证 resolved realpath、所有权、模式和版本；
- age、age-keygen、pg_dump、pg_restore 使用已审核绝对路径或受控 root-owned safe PATH，并验证 resolved binary、祖先链与版本；禁止不受控 PATH、命令名回退或 `pnpm backup` 自动化；
- backup root 由专用 backup 用户拥有并限制为 `0700`，父目录由 root 控制；明文 staging 为独立的 backup 用户 `0700` 目录，不在 backup root 或其父目录内；
- textfile 目录为 root-owned、node_exporter 组只读（例如 `0750`），node_exporter 不可写；完整祖先链真实、非 symlink、root-owned、无 group/world write；指标文件不允许 symlink。

## 4. Roles / RACI

| 工作 | Responsible（执行） | Accountable（最终负责） | Consulted | Informed |
| --- | --- | --- | --- | --- |
| 用户授权、目标与窗口 | 部署负责人 | 用户/变更审批人 | 安全负责人、DBA | 相关值班人 |
| fixture、隔离资源、清理 | 演练执行人 | 部署负责人 | DBA、安全负责人 | 用户 |
| helper/timer、artifact closure、ACL | 部署工程师 | 部署负责人 | 安全负责人 | 监控负责人 |
| SQLite/PG fixture 与工具版本 | DBA/备份负责人 | 部署负责人 | 安全负责人 | 演练执行人 |
| textfile/node_exporter | 监控工程师 | 监控负责人 | 部署工程师 | 用户 |
| Prometheus inventory、规则、Q1–Q3 | 监控工程师 | 监控负责人 | 安全负责人 | 用户 |
| Alertmanager receiver 与告警确认 | 监控值班人 | 监控负责人 | 用户/变更审批人 | 演练执行人 |
| evidence 脱敏、pass/fail、signoff | 演练记录人 | 用户/变更审批人 | 安全负责人、部署负责人 | 相关团队 |

任何角色缺席、责任冲突未解决或无法确认隔离范围时，直接 no-go，不以 root 预检或“稍后补证据”替代。

## 5. Preflight、Go/No-Go 与 Stop Conditions

### 5.1 Preflight

按以下顺序检查并留 secret-free 证据：

1. 用户再次明确授权：目标是 disposable target-like 环境，列出环境标识、窗口、RACI、允许的隔离资源；确认不触正式数据/服务。
2. 确认 Agent Server 不常驻、不监听、不接受业务流量；确认 fixture、backup root、staging、textfile、Prometheus TSDB、Alertmanager receiver 均非正式资源。
3. 记录固定 artifact closure digest、Node 精确版本、age/PG 工具 resolved path/version、server/client PG major；PG 三个 major 必须一致。
4. 验证绝对路径、root/backup 用户权限、ACL、祖先链、无 symlink、无 group/world write；验证 backup 用户能实际读取数据、执行固定 Node，但不能读取 `PI_AUTH_PATH` 内容。
5. 验证 secret 仅经受限 env 或等价安全通道注入；检查进程列表、调度定义、日志捕获和 stdout/stderr 采集策略不会暴露 secret。
6. 验证 inventory 已独立、持久且保留 expected target；验证 actual 的 `up`、freshness、`node_textfile_scrape_error` 使用完整 `(job, cluster, instance)`。
7. 验证 node_exporter 已启用 textfile collector，Prometheus 能抓取，Alertmanager 使用隔离 receiver；先执行 Q1–Q3，结果必须无返回。
8. 确认时钟同步、偏斜预算不超过 60s；确认未来时间戳阈值为 `time()+300s` critical，stale 阈值为超过 24h。

### 5.2 Go / No-Go

只有全部 preflight 通过且用户再次授权，才可标记 **GO**。任一以下条件成立即 **NO-GO**：

- 目标、数据、数据库、服务、backup root 或告警 receiver 无法证明为隔离；
- closure、Node、age、PG major、ACL、路径、env 通道或 atomic replace 审核证据缺失；
- secret 可能进入 argv/log/evidence，或 auth token 可被 backup 用户读取；
- inventory 不独立持久、三元组缺失/重复、A 与 I 漂移未解释，或 Q1–Q3 有返回；
- 无法证明 `.prom` 在目标 OS 上同文件系统原子替换，或 textfile 目录由 node_exporter 可写；
- 当前用户授权仍为 deferred，或有人要求“先演练再补授权”。

### 5.3 立即停止条件

演练中出现以下任一情况立即停止，保留隔离现场并升级，不重试、不自动恢复、不触正式资源：

- 发现正式路径、正式 URL、正式进程、正式 receiver 或非预期 writer；
- secret/token/private key/path/session id 泄露；
- strict 失败却出现 published package、`COMPLETE`、机器成功报告或 freshness 前进；
- 任一失败写入其他 target 的 `.prom`，发生半写、symlink 替换、权限放宽或指标倒退；
- inventory/actual 标签无法唯一匹配，或 exporter/textfile 错误未按预期告警；
- PG major、工具 resolved path、artifact closure 或时钟状态漂移；
- helper/timer 无法证明单飞、租约恢复或 crash 语义；
- 任一 stop/cleanup 操作可能删除正式 backup。停止后只允许人工处理隔离资源。

## 6. Happy Path（仅获授权后执行）

以下是执行顺序，不是现在要运行的命令，也不提供 helper 实现：

1. 由记录人登记授权、目标 identity、fixture identity、artifact closure digest、工具版本和演练开始时间。
2. 用 SQLite fixture 和 PG fixture 分别完成 preflight；确认 Agent Server 未常驻，DB/JSONL 内容为合成数据。
3. 至少一次正常 happy-path run 必须由已审核的 scheduler/timer **实际触发**（不是手动 helper 调用）；由 scheduler-originated run 获取同 target 单飞锁，并在调用 CLI 前记录 wall-clock **backup start** epoch。记录 scheduler identity、非敏感配置摘要、上次 trigger、下次 trigger、实际 start，以及相邻 trigger 间隔必须 `<=12h`。手动 run 只能验证备份/发布链路，不能验收调度或 cadence。
4. helper 以固定绝对 compiled backup CLI 调用 strict `--require-complete-session-references`；secret 不进 argv。不得以 `pnpm backup`、非 strict、dry-run 或手工默认行为替代。
5. helper 只接受 exit 0 且恰好一行机器报告 `backup-json-report:`；JSON 必须为 `status:"published"`、`strict:true`、`dryRun:false`、`missingSessionReferences:0`，`finalPath` 为 `BACKUP_ROOT` 下的绝对路径，包属主为 backup 用户。helper 不扫描、不解密、不自行解析 manifest。
6. 发布验证完成后，在同 target 锁内以读-比较-写执行 monotonic max；仅生成独占临时 `.prom`、fsync、同文件系统 atomic rename，失败不得触碰已发布文件。写入的 freshness 值是 backup start epoch，不是完成时间。
7. node_exporter 抓取该 target；确认 freshness、`up=1`、`node_textfile_scrape_error=0`，Prometheus 收到实际序列；独立 inventory expected 序列仍由监控控制面产生。
8. 检查完整三元组 `(job, cluster, instance)`、Q1–Q3、Alertmanager 路由和清除状态；记录每一步的 secret-free evidence reference。
9. 分别完成 SQLite、PG 和最小端到端链路后，执行 failure injection matrix；任一失败项不允许签署通过。
10. 清理只针对隔离 fixture、临时 DB/schema、隔离 TSDB/receiver、临时 textfile 和 staging；不得自动删除任何正式或未知 backup。

## 7. Failure Injection Matrix

每一项记录“注入前值、注入方式的摘要、预期、实际、evidence ref、pass/fail”。注入摘要不得带 secret、路径、URL、session id 或原始错误。

| ID | 注入 | 必须观察到的结果 | 验收判定 |
| --- | --- | --- | --- |
| F01 | strict missing references | strict CLI 非零；首个 ciphertext/`COMPLETE` 前失败；无 `backup-json-report:`、无新 package、无 staging 残留；freshness 不前进 | **Pass** 必须全部成立；否则 Stop |
| F02 | backup command failure | age/age-keygen、SQLite 输入、或 PG dump/restore 相关命令失败 | 非零、错误脱敏、无 publish、无 metric advance |
| F03 | age failure | 隔离 age 工具不可用/返回失败/版本不符 | fail-closed；无 secret/private identity 泄露；指标不变 |
| F04 | PG failure | `pg_dump` 或 PG fixture/连接失败 | fail-closed；PG major/连接诊断只含安全摘要；无 publish/指标更新 |
| F05 | absent metric | 保留独立 inventory `I`，确保目标 `up==1`，删除或阻止该 target 的 freshness 序列 `F` | 精确触发 `PiAgentServerBackupFreshnessMetricMissing`（`I exists AND up==1 AND F missing`）并在 `for` 后告警；`I unless A` 仅用于 Q3 漂移，不得用 target 自己伪造 I |
| F06 | stale >24h | 将隔离 target freshness 设为超过 24h 前的合法 epoch | `PiAgentServerBackupStale` critical 触发，且匹配 I 的完整三元组 |
| F07 | future >300s | 将隔离 target freshness 设为 `time()+600s` | `PiAgentServerBackupFreshnessFutureTimestamp` **critical** 触发；不能仅依赖 stale |
| F08 | exporter down | 停止隔离 node_exporter | `PiAgentServerNodeExporterDown` critical 按 inventory `unless up==1` 触发；freshness 窗口不被误判为健康 |
| F09 | textfile scrape error | 让隔离 textfile collector 读取失败 | `node_textfile_scrape_error=1`，`PiAgentServerBackupTextfileScrapeError` critical；指标不被半写覆盖 |
| F10 | inventory drift A unless I | 注入额外 actual 身份或缺失 expected，比较 actual 集合 A 与 inventory I | Q3 双向差集均应发现漂移；不能把 actual 当 expected，也不能静默接受 `A unless I` 返回 |
| F11 | duplicate target labels | 制造重复或跨 job/cluster 的同一 instance，或重复完整三元组 | Q1/Q2 返回并判 fail；Prometheus 不得将其当一条合法 target |
| F12 | overlapping runs / singleflight | 同一 target 并发触发两个 helper run | 单飞锁使其等待或跳过；不并发写同一 `.prom`；结果和日志不泄密 |
| F13 | late older run / monotonic max | 先发布较新 start，再让较早 start 的 run 迟到 | 读-比较-写拒绝倒退；旧 `.prom` 内容保持不变，helper fail-closed |
| F14 | crash before atomic commit | 在临时文件 fsync/rename 前终止隔离 helper | 旧 `.prom` 完整保留；不得出现半写；租约最终可恢复 |
| F15 | crash after atomic commit | 在 atomic rename 后终止隔离 helper | 新 `.prom` 是完整可抓取内容；不得出现半写；下一 run 可继续 |
| F16 | secret/redaction | 注入失败诊断、受限配置和 PG/age 失败路径，检查 argv、stdout/stderr、logs、report、evidence | secret、URL、密码、token、identity、路径细节、session id 均不出现；否则立即 Stop |
| F17 | cleanup | 完成成功/失败/中断后的 staging、锁、临时 `.prom`、fixture cleanup | 仅隔离资源被清理；无正式 backup 自动删除；残留锁需有记录并按租约处理 |
| F18 | config/ACL drift | 撤销祖先 traverse、放宽目录权限、替换 closure/Node/tool 为 symlink 或未审核版本 | helper 在真实 backup 用户上下文 fail-closed；指标不变；root preflight 不能替代实测 |
| F19 | report mismatch | 缺少/多出机器报告行、`strict:false`、`dryRun:true`、missing count 非零、finalPath 越界 | 即使 exit 0 也拒绝 freshness；无指标更新 |
| F20 | timer cadence/time | 注入超过 12h 的调度间隔或时钟未来值 | cadence no-go；future critical；不得以完成时间掩盖 RPO 失守 |

F01、F06–F11、F12–F16 至少必须在阶段一真实隔离链路中完成；阶段二配置或平台改变时，相关项必须重做。本文不记录、不推导任何测试数量。

## 8. 验收与 Pass/Fail 表

### 8.1 端到端验收

| 验收项 | Pass 条件 | Fail 条件 |
| --- | --- | --- |
| 严格备份 | exit 0 + 唯一合法 published report + `missingSessionReferences=0` | dry-run、非 strict、报告不唯一/不合法、路径或属主不符 |
| 发布安全 | package 在 `BACKUP_ROOT`，staging 清理，COMPLETE 语义正确 | 缺引用仍发布、半包、越界、staging 残留 |
| freshness | 仅目标序列以 backup start epoch 原子替换 | 失败更新、完成时间替代 start、跨 target 污染 |
| 单飞/单调 | 重叠运行串行/跳过，值 monotonic max | 并发写、旧 run 倒退、永久锁 |
| textfile/exporter | `.prom` 完整替换，node_exporter 可抓取，scrape error=0 | 半写、symlink、node_exporter 可写或 scrape error 未告警 |
| inventory | I 独立、持久、expected 不随 target down 消失 | target 自己产生 I、I 丢失、三元组重复 |
| Prometheus | Q1/Q2/Q3 无返回；missing 使用 `I exists AND up==1 AND F missing`，stale/future/down/error 规则匹配 I | 将 `I unless A` 当作 freshness missing、依赖全局 `absent()`、标签不全、漂移静默 |
| Alertmanager | 隔离 receiver 收到并可确认 critical 告警及恢复 | 路由错误、critical 降级、无恢复证据 |
| 安全 | secret/token/private key 不进 argv/log/evidence，报告脱敏 | 任何泄露或原始错误回显 |
| scheduler/cadence | 至少一次 scheduler-originated 正常 run 有配置摘要、上次/下次 trigger、实际 start，trigger 间隔 `<=12h`；平台配置变更后重演 | 仅有手动 run、缺少 trigger 证据、间隔超过 12h 或配置变更未重演 |

### 8.2 验收状态写法

演练完成后只允许使用以下三种状态：

- **PASS（可提交复核）**：所有强制项和 failure injection 通过，证据包脱敏且 signoff 完整；这仍需用户/变更审批人决定是否将 WP5C 改为验收。
- **FAIL**：任一强制项失败；WP5C/WP5 保持未验收，不得选择性报告成功。
- **DEFERRED**：未获再次授权、演练未开始或中途暂停；当前仓库交付状态使用此项，不得称为 PASS。

## 9. Restore drill 衔接、RPO 与 RTO

- **周期**：每季度一次；每次重大 migration 前一次。重大 migration 前的 drill 必须在 migration window 打开前完成并记录。
- **顺序**：先选最近成功的 daily backup，或提前创建的 dedicated drill backup，在隔离 target root/临时 PG schema 中 restore drill；**不能选择尚不存在的正式 migration prebackup**。drill 通过后，再进入正式 migration 流程。
- **不可暂停的 prebackup**：正式 migration 必须严格停服务、确认无 writer、审阅 dry-run，然后立即执行 pre-migration backup；该 prebackup 在正式 apply 内生成，是正式恢复锚点。restore drill 完成后不得人为暂停再执行 prebackup，以免扩大无保护窗口。
- **恢复检查**：校验 `COMPLETE`、manifest/hash/白名单、历史 ledger/schema、SQLite DB/WAL/SHM 或 PG schema/row contract、JSONL/DB 关系及功能抽查；不启动正式服务、不发模型请求。
- **默认 restore drill 的证据边界**：只执行 restore/完整性/数据关系校验并记录 restore-time；这只能证明恢复步骤耗时，**不能验收或签署 RTO=4h**。
- **完整 RTO signoff（单独授权后）**：必须在隔离的 target-like 环境、仅用合成且无敏感业务数据，计时 `restore → 以 PI_MIGRATION_GATE=verify 启动 → /health、/readyz 与合成无敏感业务检查 → 达到可服务状态`。计时结束后立即关闭隔离服务并清理隔离资源；不得让其正式服务、接收正式流量或接触正式数据。只有全流程耗时 `<=4h` 且每个阶段有脱敏时间证据，才可作为 RTO signoff；执行仍需用户/变更审批授权，本 SOP 当前不执行。
- **RPO = 24h**：固定不超过 12h 的 helper/timer 节奏、strict published freshness 和 Prometheus/Alertmanager stale 规则共同覆盖目标；future `>300s` 是 critical，不能视为正常新鲜度。

## 10. Evidence bundle

每次阶段性演练只提交脱敏 bundle，字段至少包括：

- `sopId`、SOP/contract revision、阶段（pre-release 或 pre-enable revalidation）、状态（PASS/FAIL/DEFERRED）；
- 用户授权记录引用、目标环境的**非敏感**标识、窗口、RACI、go/no-go/stop 记录；
- fixture 类型（SQLite/PG）、隔离资源引用、target identity 的 `(job, cluster, instance)`、inventory revision；
- artifact closure digest、Node/age/PG server-client major 的版本摘要、工具审核记录引用；
- ACL/ownership/祖先链/非 symlink/atomic replace 审核结果引用；只记录 pass/fail 和安全摘要；
- backup run identity、backup start epoch、CLI exit 分类、机器报告字段摘要、published package identity 摘要；不记录 final path、session id、reference、URL 或 secret；
- 至少一条 scheduler-originated 正常 run 的 scheduler identity、非敏感配置摘要、上次 trigger、下次 trigger、实际 start、trigger 间隔（`<=12h`）和 opaque evidence ref；手动 run 明确标记为 non-acceptance；平台调度配置变更后的重演证据；
- textfile、node_exporter、Prometheus scrape、Q1/Q2/Q3 与每项告警的 query/result 引用；
- failure matrix 每个 ID 的 pass/fail、注入分类、观察到的安全结果、日志/截图/查询引用；
- restore drill backup identity 摘要、restore-time、完整性校验结果；若执行完整 RTO signoff，另记录 restore、`PI_MIGRATION_GATE=verify` 启动、`/health`、`/readyz`、合成无敏感业务检查、可服务、关闭清理各阶段时间与总耗时；默认 restore-time 不得标为 RTO signoff；
- cleanup 结果、遗留锁/临时文件处置、未删除正式资源声明；
- operator、部署负责人、安全负责人、监控负责人和用户/变更审批人的签署记录。

### 10.1 脱敏规则

Evidence 只允许固定枚举、计数、版本 major、digest、时间戳、布尔值和不可逆 opaque reference。必须删除或哈希：secret、密码、token、连接 URL/host/database、age identity/recipient 内容、绝对路径、文件名中可识别的 target/session 信息、prompt/content、原始 argv 和未脱敏 stderr。不得通过 base64、截图裁剪遗漏或“内部附件”绕过规则。

## 11. Rollback、Cleanup 与 Signoff

### 11.1 Rollback / cleanup

- 演练失败时停止 helper/timer 和隔离 exporter 链路，保留隔离 evidence；不执行自动 retry、restore、down migration 或正式恢复。
- 只清理本次创建的隔离 DB/schema、fixture JSONL、隔离 backup package、明文 staging、textfile 临时文件、锁/租约、Prometheus TSDB 和 Alertmanager receiver；由责任人逐项确认范围。
- **不得自动删除正式 backup**，也不得清理无法证明属于本次演练的 backup。30 天 retention 仍由人工运维策略管理，不属于本 SOP 自动动作。
- 若怀疑存在正式资源影响、secret 泄露或数据边界越界，保持现场、停止清理并升级安全负责人和用户。

### 11.2 Signoff 门槛

签署前必须确认：

- 用户曾针对本次目标再次授权；
- 所有强制 preflight、happy path、failure matrix、Prometheus Q1–Q3、告警恢复和 cleanup 均有脱敏 evidence；
- 至少一条 scheduler-originated 正常 run 的配置摘要、上次/下次 trigger、实际 start 和 `<=12h` cadence evidence；手动 run 不作为调度验收；平台调度配置变更已重演；
- SQLite 与 PG fixture 的必要项均完成，PG server/client major 一致且 age 链路已验证；
- 无正式数据/正式服务接触，无 secret/token/private key 泄露，无通用 helper/template 被复制进仓库；
- 如签署 RTO，必须另有隔离 target-like 全流程计时证据：restore、`PI_MIGRATION_GATE=verify` 启动、`/health`、`/readyz`、合成无敏感业务检查、可服务状态、关闭与清理；默认 restore-time 证据不得替代该 signoff；
- signoff 明确写出：**WP5C 方案 B 是否建议进入验收评审**。在用户/变更审批人正式接受前，WP5C 仍未验收，WP5 仍未验收，服务仍非 production-ready。

## 12. 关联契约与当前交付状态

- [backup-freshness-exporter.md](backup-freshness-exporter.md)：WP5C 方案 B 部署契约、指标语义、PromQL、唯一性查询和部署后检查单。
- [operations.md](operations.md)：在线备份、外部 helper/timer、secret 与 migration 前置。
- [backup-restore.md](backup-restore.md)：SQLite/PG backup、restore、RPO/RTO 与 restore drill。
- [phase-3-data-retention-plan.md](phase-3-data-retention-plan.md)：WP5/Phase 3 状态与依赖。
- [decisions/0001-phase-3-data-retention-baseline.md](decisions/0001-phase-3-data-retention-baseline.md)：备份、恢复和监控决策记录。

当前结论：**SOP 已落地；实际部署演练按用户决定 deferred；strict foundation accepted；WP5C/WP5 均未验收；服务非 production-ready。**
