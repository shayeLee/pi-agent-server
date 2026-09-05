# WP5C 方案 B：backup freshness 部署契约（deployment contract）与验收清单

> **状态声明（不得曲解）**：本文是 WP5C **方案 B** 的**部署契约 + 验收清单**。早前版本曾把本方案表述为「外部 OS 调度器调用单一 root-owned Node 部署助手（模板）」并附可复制实现；因其安全属性（进程内降权、祖先链校验、跨 OS 原子发布）无法在不交出目标主机控制权的前提下由本仓库安全泛化，该形态已**收敛**：本仓库**不再交付、不再展示任何可复制的 root Node helper 源码、shell 运行脚本、systemd unit 或 launchd plist 模板**，**不再声称任何跨 OS 原子发布实现**。本文只定义部署方必须满足的**契约要求**与部署后**验收清单**；一切自动化由**部署方经过审核的 helper/timer（见契约）**承担。**本文可评审；未经过实际部署演练不验收**——本文不记录或推导测试数量，不构成验收证据。
>
> **Strict backup completeness foundation: ✅ accepted (separate from WP5C deployment acceptance).** The user's supplied complete real PG16+age `verify:release` success evidence after the fixture repair includes the strict completeness compiled/npm gates and real PostgreSQL CLI gate passing. This accepts only the backup-core/CLI final-snapshot binding and pre-publish fail-closed foundation; **WP5C Option B as a whole remains not accepted**, because the actual deployment helper/timer → textfile → Prometheus → Alertmanager drill is still missing.
>
> **方案 A（仓库内只读 backup health scanner observer）已放弃**：仓库内不再提供扫描 backup 根目录/解析 manifest 的 observer 代码、CLI、tests、smoke 或构建产物；`dist-hygiene.mjs` 已把该 scanner 的编译产物（`health-core.*`）列入禁止回归名单。
>
> 未来如需无外部 helper 的 freshness 来源（native in-process metrics）或基于 age identity 的 freshness 判定，作为**单独事项另行讨论**，不隐含在本契约中。
>
> 关联：[backup-freshness-drill-sop.md](backup-freshness-drill-sop.md)（实际部署演练 SOP；当前按用户决定 deferred）、[operations.md](operations.md)（在线备份，固定 12h 节奏）、[backup-restore.md](backup-restore.md)（RPO/RTO/retention/drill）、[phase-3-data-retention-plan.md](phase-3-data-retention-plan.md)（WP5 状态）。

## 1. 契约目标与责任分界

契约视图的数据流（只表达责任与要求，不表达实现）：

```
部署方经过审核的 helper/timer（§2；本代码库不交付/不安装）
  → 固定构建产物 backup CLI（§2 责任 1；专用低权限 backup 用户执行；secret 不进 argv）
  → exit 0 且机器可读 published output 校验通过（§1 成功判据；拒绝 dry-run）
  → 仅该 target 的 textfile 指标更新（§5；失败绝不更新）
  → node_exporter textfile collector（root-owned 目录，node_exporter 组只读）
  → Prometheus（§6 独立持久 inventory 与 actual freshness/up/textfile 集合）
  → 外部 Alertmanager（非本代码库组件）→ 告警

监控控制面 / inventory（独立于被监控 target，持久产生 expected-target metric）
  ───────────────────────────────────────────────────────────────→ Prometheus（同一完整 (job, cluster, instance) 三元组）
```

- **责任分界**：本代码库交付物 = 既有 backup CLI 编译产物 + 本文契约 + dist hygiene 回归断言（`dist-hygiene.mjs` 禁止 `health-core.*` 回归）。**helper/timer 的部署与审核是部署方责任**——本代码库不安装、不交付、不展示可复制的 helper 源码、shell 脚本、systemd unit 或 launchd plist。一切「自动化执行备份」的叙述统一指 **部署方经过审核的 helper/timer（见契约）**；`pnpm backup` 仅作人工 dev 命令，绝不进入任何自动化入口。
- **成功判据（两层，缺一不可）**：(1) backup CLI exit 0；(2) 该 target 的自动化运行**必须以 strict flag `--require-complete-session-references` 调用固定编译产物 backup CLI**，且 stdout 是**机器可读的 strict published output**（机器契约：恰好一行 `backup-json-report: {JSON}` 报告，JSON 必须断言 `status:"published"`、`strict:true`、`dryRun:false`、`missingSessionReferences:0`，且 `finalPath` 为绝对路径），发布路径位于 `BACKUP_ROOT` 之下、目录真实存在且**属主为 backup 用户**。stdout 含 `backup dry-run:` 行、缺失/多余机器报告行、报告行解析失败或字段不符（如 `strict:false`、`dryRun:true`、`missingSessionReferences>0`）一律不是成功。任何环节**绝不自行判断备份内容**——不扫描、不解析 manifest、不解密。
- **完整性（completeness）语义（strict 内置）**：strict 模式下任一缺失的 whitelist 内 session reference 都会在**任何 final publish/COMPLETE 之前** fail-closed（非零退出；清理 staging；不发机器成功行；错误稳定脱敏、只含计数、绝不泄露 session id/path/ref）。**strict 的绑定点是最终快照而不是 staging 之前**：SQLite 在 `VACUUM INTO` 完成后从最终快照重读 reference 集合，并与本次实际收集的 payload 集合逐条复核——inspect→snapshot 在线写窗口内出现的缺口（并发写者新增/改动 session 行、删除被引用 JSONL、或把引用指向 inspect 之后才创建的文件）都会在首个 ciphertext 发布前 fail-closed；PostgreSQL 的 reference 读取与 dump 消费的是同一个导出的快照事务，其绑定就是该快照。因此一次 strict 成功发布即声明「引用完整（zero missing）」，freshness 前进 = 完整已发布包。**人工默认运行（无 strict flag）明确不构成 freshness advancement**：默认兼容行为不变（缺失引用仍记录进加密 manifest 并照常发布、人工文本输出不变），但绝不能被任何自动化当作 success 依据。dry-run 永远不是成功；strict dry-run 也只输出 dry-run 行、绝无机器报告行。
- **per-target 指标**：每个期望备份目标一条指标序列（`pi_agent_server_backup_last_success_timestamp_seconds`，见 §5），以唯一目标标签集识别（§6）。**只有该 target 的 backup CLI 满足上述成功判据、发布验证完成之后**才更新对应指标；**失败绝不更新**——指标停留在最后一次成功时间，由 Prometheus stale 规则自然触发。期望目标不靠 target 自己打标签：独立监控控制面/inventory 持久产生 `pi_agent_server_backup_expected_target_info{job,cluster,instance}=1`，而非由被监控 node_exporter 或 textfile 目录产生。
- **首次缺失告警**：仅当独立 inventory `I` 存在、目标 `up==1` 且 freshness `F` 缺失时，按 `(I and U==1) unless F` 触发 `PiAgentServerBackupFreshnessMetricMissing`（§6）；`I unless A` 仅用于 Q3 的 inventory/actual 漂移，不是 freshness missing 规则；不使用无目标范围的全局 `absent()`。

**边界（本契约不做，也不允许部署方依赖仓库实现）**：

| 不做的事 | 说明 |
| --- | --- |
| 无扫描 | 仓库内无任何扫描 backup 根目录/解析 manifest 的代码；方案 A scanner 已放弃并有 hygiene 回归断言 |
| 无 age identity | 任何环节不接触 age 私钥/identity；backup CLI 只用 `--age-recipient-file`（公钥路径） |
| 无服务集成 | 不接入 `startServer`、不进服务进程、不新增 src 模块 |
| 无仓库 timer/helper | 仓库不交付/不安装任何 helper、timer、systemd unit、launchd plist 或运行脚本；自动化由部署方经过审核的 helper/timer 承担（§2） |
| 无自动 backup | 契约只定义「调度执行备份 + 校验发布 + 记录成功时间」的要求，不改动备份语义与调度所有权 |
| 无删除 | 30 天保留的手动清理见 §9；CLI/契约永不自动删除备份（自动 retention 属未来工作包，不属于 WP5B/WP5C） |

## 2. 外部部署责任（契约要求；部署方逐项落实并审核）

部署方必须满足下列契约要求；**每一项都是 §8 验收清单的检查对象**。本仓库不提供实现，也不认定任何具体实现（OS 调度器、helper 语言、发布工具链）为唯一形态——**同一契约不得被解读为仓库曾实现或担保任何 helper**。

1. **固定构建产物与完整信任边界**：自动化路径只调用**固定绝对路径的编译产物 backup CLI**；信任边界覆盖整个固定 `dist-backup` 树及其运行时传递闭包（入口及其全部 import/require 到达的文件/目录，不得只校验 entrypoint；任何留在该根下的额外 entry 也必须纳入闭包审计；若解析到根外依赖，该依赖必须一并纳入同一 approved closure，否则拒绝部署）以及从该根到 `/` 的祖先链。闭包内每个文件/目录都必须 `root:root`、真实对象、**无 symlink、无 group/world 写**；每个祖先组件也必须 root-owned、真实目录、非 symlink、无 group/world 写。固定 node 二进制同样必须是 root-owned、非 symlink、无 group/world 写、可执行，并固定到部署记录中的**确切版本（≥ 22.19.0）**；helper 每次运行前必须验证其 resolved realpath、所有权/模式与 `node --version`，不可退回 `AGENT_CWD`、`pnpm backup` 或不受控 PATH。backup CLI 必须实际以**专用低权限系统用户**（无登录 shell、无密码、非 root、无组特权）运行；部署方审核该用户对固定闭包、数据路径的可执行/可读/可写边界。
2. **外部工具路径与版本必须受控**：`age`、`age-keygen`、`pg_dump`、`pg_restore` 只能使用部署记录中的已审核绝对路径，或来自**受控 root-owned 安全 PATH**（PATH 目录及其祖先链均真实、非 symlink、root-owned、无 group/world 写；不得含空项、`.` 或继承的不受控目录）。helper 必须清空/替换继承 PATH，解析每个工具到最终 resolved binary，验证该 binary 的所有权、非 symlink、模式、祖先链与可执行性，并在使用前验证版本：age 工具匹配固定批准版本；`pg_dump`/`pg_restore` 与服务端 major 匹配；任何解析或版本校验失败都 fail-closed，绝不按命令名回退。版本检查、helper 诊断与错误输出必须脱敏且不得打印 secret。
3. **调度节奏 ≤ 12h**：自动化调度须满足 §7 的时间预算（默认**固定 12h 节奏**；**任何部署不得使用 24h 间隔**，24h 间隔超出本契约默认部署模式，需另行单独评审）。
4. **secret 不得 argv**：所有 secret（`PI_DATABASE_URL`、token 等）**绝不进入任何进程的 argv、unit/plist、版本/错误输出或日志**；只能经进程环境（或部署方等价的安全通道）从部署方持有的受限配置（如 root 0600 env 文件）传递。backup CLI 的 argv 只允许非 secret 的固定 CLI 参数（`create --backup-root <路径> --age-recipient-file <路径> --require-complete-session-references`——**strict flag 对自动化是强制项**；不带该 flag 的运行不满足 §1 成功判据，绝不更新 freshness）；PG 凭证不得拼入 URL/工具 argv，helper 不得回显环境内容或未脱敏子进程错误。
5. **服务 auth token 不可读取**：服务账号的 auth 文件（`PI_AUTH_PATH`）必须**服务账号属主 0600**——backup 用户对文件内容**不可读**；backup 用户只获得沿每个祖先目录的**精确 traverse（仅 search，不可 list/写）**能力（Linux `setfacl` / macOS `chmod +a` 或等价精确机制；**禁止以 root 预检代替真实可遍历性**——backup 进程自身必须能沿父链走到该路径，且不能读取 token 内容；无任何 root preflight 替代）。
6. **per-target 指标更新时机**：per-target textfile 指标**仅在**该 target 的 backup CLI 满足 §1 两层成功判据（exit 0 + 机器可读 published output 校验通过）且发布验证完成后更新；**任何失败（非零退出/超时/被杀/输出校验失败/发布失败）绝不更新**——指标保持原样，由 stale 规则暴露。
7. **target root / ACL / atomicity 由部署审核**：backup root、staging、textfile 目录的**属主/权限/完整祖先链**（§3）以及指标发布的**原子性**（同文件系统原子替换、无半写、发布完成前无属主变更）由**部署方在目标主机审核并留证**。**契约不宣称、仓库也不实现跨 OS 原子发布**——部署方必须针对目标 OS 的既有机制证明「指标文件要么完整替换、要么保持原样」成立，并把审核结论写入部署记录（§8）。
8. **Prometheus 规则与唯一性验收查询**：按 §6 配置独立持久 inventory、actual freshness/up/textfile 集合与 missing/stale/future/exporter 规则，并执行唯一性验收查询 Q1–Q3（§6.2）。

## 3. 部署布局与属主（部署方落实并审核的最终状态）

所有路径必须**绝对**；目录/文件属主与权限是安全边界，**未经契约授权不得放宽**。下表是部署方落实后应达到的**最终状态**（不是本代码库的安装动作）：

| 路径 | 属主/权限 | 契约要求 |
| --- | --- | --- |
| 固定 `dist-backup` 根及其完整运行时传递闭包（如 `/opt/pi-agent-server/dist-backup/`） | 根与闭包内每个文件/目录均 `root:root`，真实对象、**无 symlink、无 group/world 写**；从 `/` 到该根的每个祖先组件同样 root-owned、真实目录、非 symlink、无 group/world 写 | 覆盖整个 `dist-backup` 树、backup CLI 入口及全部 import/require 到达文件；不得只审核 `scripts/backup.js`，根外解析依赖也不得逃逸审计；helper 必须验证闭包与祖先链 |
| 编译产物 backup CLI（如 `/opt/pi-agent-server/dist-backup/scripts/backup.js`） | 上述闭包的一部分；`root:root`，非 symlink，无 group/world 写 | 固定绝对路径；只能由已验证的 pinned node 执行（`.js` 不要求自身 executable 位） |
| 固定 node 二进制（如 `/opt/pi-agent-server/bin/node`） | `root:root`，非 symlink，无 group/world 写，可执行，部署记录中的确切版本 **≥ 22.19.0**；其祖先链同样受控 | 固定绝对路径或受控安全 PATH 的 resolved binary；backup 用户可实际执行；helper 使用前验证 realpath、权限与版本 |
| 外部工具 `age`/`age-keygen`/`pg_dump`/`pg_restore` | 已审核 resolved binary；root-owned、非 symlink、无 group/world 写、可执行；其 PATH/绝对路径祖先链同样受控 | 只允许已审核绝对路径或受控 root-owned 安全 PATH；helper 使用前验证 resolved binary 与批准版本/PG major；不得使用不受控 PATH |
| 受限配置（env 文件，如 `/etc/pi-agent-server/backup.env`；所在目录 `root:root` 0750） | `root:root` **0600**，非 symlink | 唯一 secret 来源；内容只含 `KEY=VALUE` 行（§4） |
| textfile 目录（如 `/var/lib/node_exporter/textfile`） | `root:node_exporter` **0750**（组只读；**node_exporter 不可写**） | **完整祖先链（从 `/` 到目录本身）每级 root 属主、真实目录、非 symlink、无 group/world 写**——部署方逐级审核；指标文件 root 属主、无 group/world 写 |
| 备份根 `<BACKUP_ROOT>`（如 `/var/lib/pi-agent-server/backups`） | backup 用户 **0700** | 仅 backup 用户可遍历/写入（含发布包） |
| `<BACKUP_ROOT>` 的**父目录**（如 `/var/lib/pi-agent-server`） | `root:root` **0755** | root 控制；backup 用户不可写——阻止 backup 用户在父目录创建/删除条目 |
| staging 根（如 `/var/lib/pi-agent-server-backup/staging`） | backup 用户 0700 | backup CLI 的明文 staging 根（env 配置必须显式设置，不依赖服务用户 HOME 推断） |
| 服务数据目录（`AGENT_CWD`/`DATA_DIR`/DB 文件） | 对 backup 用户**只读** | 备份输入；绝不给写权限 |
| `PI_AUTH_PATH`（服务账号 auth.json） | **服务账号属主 0600（backup 用户不可读内容）**；backup 用户对**每个祖先目录**持**精确 traverse（仅 search，不可 list/写）** ACL | §2 责任 5；**无 root preflight 替代** |

硬前置条件（部署方逐项确认后才可在验收清单勾选）：

1. 固定 `dist-backup` 根、完整运行时传递闭包及祖先链均已按上表验证；pinned node 为部署记录中的确切版本且 **≥ 22.19.0**，backup 用户对其有实际可执行性（部署方实测审核）；
2. 自动化以能读取受限配置并降权执行 backup CLI 的方式运行（部署方经过审核的 helper/timer）；
3. textfile 目录与备份根位于**支持原子替换/fsync 的本地文件系统**（拒绝 NFS/网络盘；部署初始化时验证一次）；
4. `age`/`age-keygen` 使用批准版本，且 `pg_dump`/`pg_restore` 与 server major 匹配；每次运行均使用已审核绝对路径或受控 root-owned 安全 PATH，并由 helper 验证 resolved binary、所有权/祖先链与版本；不接受不受控 PATH。

## 4. 受限配置与 secret 契约

- **env 文件状态（示例形态，非唯一）**：`root:root 0600`、非 symlink；只含 `KEY=VALUE` 行（KEY ∈ `[A-Za-z_][A-Za-z0-9_]*`，按第一个 `=` 切分、值内可含 `=`），**零注释、零引号、零展开、零重复、零 CR**；`PI_STORAGE_DIALECT` 必须精确为 `sqlite` 或 `postgres`，并按 dialect 强制 `DB_PATH`（sqlite，绝对）或 `PI_DATABASE_URL`（postgres，`postgresql://` 或 `postgres://` 开头）；`AGENT_CWD`/`DATA_DIR`/`BACKUP_ROOT`/`AGE_RECIPIENT_FILE`/`PI_AUTH_PATH`/staging 根必须为服务实际使用的绝对路径（`PI_AGENT_DIR` 绝对或留空；`PI_AUTH_PATH` **不可留空**）。
- **secret 通道**：secret 只经进程环境从受限配置进入 backup CLI 的执行环境；**任何 argv、unit/plist、日志都不得含 secret 值**。部署方审核：检查调度配置、helper、日志输出与进程列表，确认无 secret 泄漏（§8 检查项）。
- **token 不可读**：backup 用户对 auth.json **无任何读取权限**（服务账号属主 0600），仅持祖先目录精确 traverse（§2 责任 5）。部署方以 backup 用户实测「可沿父链到达路径 + 不可读文件内容」（§8 检查项）；**无 root preflight 替代**。

## 5. 指标契约（per-target、仅成功发布后更新、失败不更新）

- **指标**：`pi_agent_server_backup_last_success_timestamp_seconds`（gauge，Unix epoch 秒），node_exporter textfile 格式；**每个期望备份目标一条序列**，以 §6 的唯一目标标签集区分，写入 textfile 目录下的 `.prom` 文件。
- **strict 完整性（hard constraint）**：自动化必须使用 strict flag；**strict 成功 = 引用完整已发布包**（§1 完整性语义）。任一 strict 失败——包括任一缺失 session reference——绝不更新指标，成功序列停在最后成功时间，由 missing/stale critical 告警暴露（§6.2）；**不允许以非 strict 成功更新 freshness**，不允许把 dry-run 当作成功。
- **更新时机（硬约束）**：per-target 指标**仅在**该 target 的 backup CLI 满足 §1 两层成功判据、发布验证完成**之后**更新；值 = **backup start**（调用 CLI 之前记录的 wall-clock epoch），不是完成时间——在线备份中 DB 快照与 JSONL 复制不是全局原子操作，数据可安全恢复的最早保证点是备份开始时刻；用完成时间会高估安全面。**任何失败（非零退出/超时/被杀/输出校验失败/发布失败）绝不更新**——指标停留在最后一次成功时间，stale 规则自然触发。
- **「最后成功」语义**：指标断言「一个开始于 T 的备份已成功发布」——即「数据截至 T 是安全的」。RPO 承诺（最大丢失窗口 = 故障时刻 − 上次成功 start）成立的前提是调度节奏满足 §7。
- **wall clock vs monotonic**：指标值**必须使用 wall clock epoch**，因为 Prometheus 规则用 `time() - metric` 跨主机比较（`time()` 是 Prometheus 服务器自身的墙钟）；**monotonic 时钟只能用于单机时长，不能跨主机作为时间戳**。
- **时钟同步**：备份主机与 Prometheus 主机必须接入同一时间源并监控时钟源状态；偏斜预算 ≤ 60s；任何大于 300s 的未来时间戳 = **无效 freshness/RPO 判定失守**，由 §6.2 的 future-timestamp 告警**以 critical 暴露**（它同时说明 stale 规则当时不可信、会被压掉，因此绝不能降级为 warning）。
- **同 target 单飞（hard constraint）**：同一 target 同一时刻只允许一个 helper run。部署方必须以目标 OS 的排他互斥机制（文件锁/锁目录原子创建/调度器单实例保证）串行化同 target 的更新路径；后到的 run 检测到同 target 进行中时必须等待或跳过，**绝不并发写同一个 `.prom` 文件**。锁必须带租约/超时或由调度器清理：helper 崩溃（被杀/断电）后不得遗留永久死锁——恢复后按现有已发布指标继续判定，无需补写历史。
- **时间戳单调（max 语义，hard constraint）**：指标值 = 本 target 已发布值与本次 backup start 的 **max（单调不减）**。更新在锁内执行**读-比较-写**：仅当本次 start > 已发布值时才覆盖；等于视为一致（无需写入）；小于已发布值（时钟回拨/乱序/旧 run 迟到）必须**拒绝覆盖并 fail-closed**（helper 报错退出、`.prom` 文件保持原样），防止旧 run 倒退 freshness 或压掉新 run 的成功。**失败/崩溃语义**：任何失败（CLI 非零/输出校验失败/锁获取失败/原子替换失败）都不更新；更新本身是独占名临时文件 + fsync + 同文件系统 rename——崩溃发生在 rename 前 → 旧文件完整保留；发生在 rename 后 → 新文件已完整发布；绝无半写，失败路径不得触碰已发布的最终文件。
- **原子性（部署审核要求）**：每次成功更新**原子替换**整个 `.prom` 文件内容（HELP/TYPE/样本一体），不出现半写；发布完成前不发生属主变更。**契约不宣称跨 OS 原子发布的实现**——部署方按 §2 责任 7 在目标主机审核原子替换机制并留证；无法证明的目标平台**拒绝部署本方案**，改走另行评审的方案（如 native in-process metrics），而不是降级为不安全发布。
- **发布目录与祖先链（部署审核要求）**：textfile 目录 root 属主、node_exporter 组只读（0750）、node_exporter **不可写**——不给 node_exporter 写权限，消除其 textfile 目录被滥用为任意文件写入口的提权面；**完整祖先链（从 `/` 到目录本身）每级 root 属主、真实目录、非 symlink、无 group/world 写**是阻止非 root 主体替换目录或指标文件的机制；部署方逐级核对并记录（§8 检查项）。临时文件发布模式（独占名 + 同文件系统 rename）由部署方 helper 在目标 OS 上证实可行，且失败路径不得触碰已发布的最终文件。

## 6. Prometheus 规则与唯一性验收查询（部署层配置）

**期望清单的唯一来源是独立、持久的监控控制面/inventory 指标**：
`pi_agent_server_backup_expected_target_info{job,cluster,instance}=1`。该指标由 inventory/control plane 产生，**不是被监控 target、node_exporter 或其 textfile collector 产生**；target 即使 down，该序列仍必须保留。`job`、`cluster`、`instance` 三个标签是目标身份的一部分，三者始终都存在（不得在单集群时省略 `cluster`）。inventory 的抓取 job/producer 元数据不得覆盖这三个目标标签。

下文把以下 actual 集合统一限定为专用于备份目标的 node_exporter 抓取 job（将 `node-exporter` 替换为部署中的固定 job 名；该 job 不得混入非备份目标）：

- `I` = `pi_agent_server_backup_expected_target_info{job="node-exporter"} == 1`（独立持久 inventory）；
- `F` = `pi_agent_server_backup_last_success_timestamp_seconds{job="node-exporter"}`（target textfile freshness）；
- `U` = `up{job="node-exporter"}`（target scrape 状态）；
- `T` = `node_textfile_scrape_error{job="node-exporter"}`（target textfile collector 状态）；
- `A` = `U or on (job, cluster, instance) F or on (job, cluster, instance) T`（actual target 身份集合）。

所有 alert 都必须以 `I` 作为 expected 侧，并用完整三元组 `on (job, cluster, instance)` 与 actual freshness/up/textfile 匹配：freshness missing 必须是 `(I and U==1) unless F`，即 I 存在且 `up==1` 而 F 缺失；stale/future 使用 `actual and on (...) I`。`I unless A` 与 `A unless I` 仅用于 Q3 的双向 inventory/actual 漂移比较，不得把 `I unless A` 当作 freshness missing。不使用 `pi_agent_server_backup_expected` target 标签，也不使用无目标范围的全局 `absent()`；inventory 控制面自身的可用性/覆盖率另由其监控负责。**strict 完整性失败不产生任何 inventory 改动**（expected 序列不受影响）；inventory drift（额外/缺失/重复 expected 序列）仍由 Q1–Q3 唯一性验收查询发现。

### 6.1 唯一性验收查询（部署后必做；结果固化进 §8 检查单）

```promql
# Q1：每个参与的指标族都按完整三元组计数，必须精确为 1；必须无返回。
#     Q3 负责发现某个三元组在另一指标族中完全缺失。
count by (job, cluster, instance) (pi_agent_server_backup_expected_target_info{job="node-exporter"} == 1) != 1
or count by (job, cluster, instance) (up{job="node-exporter"}) != 1
or count by (job, cluster, instance) (pi_agent_server_backup_last_success_timestamp_seconds{job="node-exporter"}) != 1
or count by (job, cluster, instance) (node_textfile_scrape_error{job="node-exporter"}) != 1

# Q2：同一个 instance 不得跨 job 或 cluster 重复；必须无返回。
#     Q1 负责同一完整三元组内的重复序列。
count by (instance) (
  count by (job, cluster, instance) (
    pi_agent_server_backup_expected_target_info{job="node-exporter"} == 1
  )
) > 1

# Q3：inventory 与 actual target 身份集合必须相等；两边的差集都必须无返回。
(
  pi_agent_server_backup_expected_target_info{job="node-exporter"} == 1
  unless on (job, cluster, instance)
  (
    up{job="node-exporter"}
    or on (job, cluster, instance) pi_agent_server_backup_last_success_timestamp_seconds{job="node-exporter"}
    or on (job, cluster, instance) node_textfile_scrape_error{job="node-exporter"}
  )
)
or
(
  (
    up{job="node-exporter"}
    or on (job, cluster, instance) pi_agent_server_backup_last_success_timestamp_seconds{job="node-exporter"}
    or on (job, cluster, instance) node_textfile_scrape_error{job="node-exporter"}
  )
  unless on (job, cluster, instance)
  (pi_agent_server_backup_expected_target_info{job="node-exporter"} == 1)
)
```

### 6.2 规则集（`for` 时长按部署节奏调整）

```yaml
groups:
  - name: pi-agent-server-backup-freshness
    rules:
      # 0) inventory 保留 expected target；没有 live up 序列也告警。
      - alert: PiAgentServerNodeExporterDown
        expr: (pi_agent_server_backup_expected_target_info{job="node-exporter"} == 1)
              unless on (job, cluster, instance)
              (up{job="node-exporter"} == 1)
        for: 15m
        labels: { severity: critical }
        annotations: { summary: "expected backup target {{ $labels.instance }} has no live node_exporter up=1" }

      # 1) textfile collector 报错；expected 侧来自独立 inventory。
      - alert: PiAgentServerBackupTextfileScrapeError
        expr: (pi_agent_server_backup_expected_target_info{job="node-exporter"} == 1)
              and on (job, cluster, instance)
              (node_textfile_scrape_error{job="node-exporter"} == 1)
        for: 15m
        labels: { severity: critical }
        annotations: { summary: "node_exporter textfile scrape error on expected target {{ $labels.instance }}" }

      # 2) exporter live but the textfile collector series itself is absent.
      - alert: PiAgentServerBackupTextfileMetricMissing
        expr: ((pi_agent_server_backup_expected_target_info{job="node-exporter"} == 1)
               and on (job, cluster, instance) (up{job="node-exporter"} == 1))
              unless on (job, cluster, instance)
              node_textfile_scrape_error{job="node-exporter"}
        for: 15m
        labels: { severity: critical }
        annotations: { summary: "textfile collector metric missing on expected target {{ $labels.instance }}" }

      # 3) live expected target has never published freshness; no global absent() fallback.
      - alert: PiAgentServerBackupFreshnessMetricMissing
        expr: ((pi_agent_server_backup_expected_target_info{job="node-exporter"} == 1)
               and on (job, cluster, instance) (up{job="node-exporter"} == 1))
              unless on (job, cluster, instance)
              pi_agent_server_backup_last_success_timestamp_seconds{job="node-exporter"}
        for: 15m
        labels: { severity: critical }
        annotations: { summary: "live expected target {{ $labels.instance }} has no backup freshness metric" }

      # 4) 成功备份超龄：超 RPO 24h（基于保守 backup-start 时间戳；时钟偏斜预算见 §5）。
      #     strict 完整性失败（任一缺失 session reference）同样只表现为 freshness 停止前进，
      #     由本 critical 告警与 missing 告警暴露——不另设 completeness 指标；strict 成功即声明引用完整。
      - alert: PiAgentServerBackupStale
        expr: (time() - pi_agent_server_backup_last_success_timestamp_seconds{job="node-exporter"} > 24 * 60 * 60)
              and on (job, cluster, instance)
              (pi_agent_server_backup_expected_target_info{job="node-exporter"} == 1)
        for: 15m
        labels: { severity: critical }
        annotations: { summary: "last successful pi-agent-server backup (start) is older than RPO 24h" }

      # 5) 未来时间戳：时钟同步错误/写入错误 = 无效 freshness / RPO 判定失守（未来值会压掉
      #    stale 规则，必须单独暴露），因此是 critical 而非 warning。
      - alert: PiAgentServerBackupFreshnessFutureTimestamp
        expr: (pi_agent_server_backup_last_success_timestamp_seconds{job="node-exporter"} > time() + 300)
              and on (job, cluster, instance)
              (pi_agent_server_backup_expected_target_info{job="node-exporter"} == 1)
        for: 15m
        labels: { severity: critical }
        annotations: { summary: "expected target {{ $labels.instance }} reports a future backup timestamp: freshness/RPO evaluation is invalid" }
```

**Alertmanager 完全由外部配置**（非本代码库组件）：本仓库不提供、不安装 Alertmanager 配置、路由或 receiver；部署方自行消费上述告警。inventory 控制面必须持久保留 expected 序列并单独监控其覆盖/新鲜度；node_exporter 需启用 textfile collector（`--collector.textfile.directory` 指向 §3 的 textfile 目录）。

## 7. RPO 覆盖与调度节奏约束（保守时间戳的前提）

指标时间戳 = **backup start**。设 `C` = 调度间隔（**必须 ≤ 12h**）、`D` = 最坏备份时长、`J` = 随机延迟上限 + 时钟偏斜预算 + `for` 时长，则必须满足：

```
C + D + J < 24h   （否则 stale 规则会在“一切正常”时误报，RPO 承诺名存实亡）
```

- **固定节奏 = 每 12 小时**（默认；部署不得使用每日 24h 间隔示例——24h 间隔需要极其严格的 D+J 预算且无任何裕量，不属于本契约默认部署模式；需要该节奏的部署须另行单独评审）。最坏丢失窗口 ≈ 12h + D，显著优于 RPO 24h（**RPO = 24h，已确认**）。
- 随机延迟**必须 ≤ 300s 且计入 J**；错过的运行补跑以实际开始时刻记录（保守，不违反）。
- **自动化部署叙述全仓统一**：所有「自动化执行备份」的叙述（本契约、operations/backup-restore/plan/ADR/README）一律指**部署方经过审核的 helper/timer（见契约）**调用固定构建产物；**禁止任何直接以 pnpm/CLI 形式给出的自动 timer 示例**——`pnpm backup` 仅作为人工 dev 命令。
- 一旦任一环节违反上述预算，要么调快节奏，要么调大 `for`/阈值（并重新评审），不能靠「exit 0 就写完成时间」绕过——完成时间会高估安全面（§5）。
- **RTO = 4h（已确认）**：默认 restore drill 只产出 restore-time/完整性证据，不能单独验收 RTO。完整 RTO signoff 必须在隔离 target-like 环境、仅用合成且无敏感业务数据，计时 `restore → PI_MIGRATION_GATE=verify 启动 → /health、/readyz 与合成无敏感业务检查 → 可服务`，随后关闭并清理隔离服务；全流程 `<=4h` 且有阶段时间证据才可签署。执行需用户/变更审批授权，不得正式服务。

## 8. 部署后验收清单（检查单；部署方逐项执行并留证）

1. **发布目录状态**：textfile 目录属主/权限符合 §3（`root:node_exporter`、组只读、node_exporter 不可写）；每个期望 target 的 `.prom` 指标文件存在且为 root 属主、无 group/world 写；无 `.tmp.*` 残留、无符号链接；空闲时无锁目录残留。
2. **祖先链审核**：textfile 目录自 `/` 起的每个祖先组件均为 root 属主、真实目录、非 symlink、无 group/world 写（部署方逐级核对并记录）。
3. **固定产物与受限配置**：env 文件 root:root 0600 非 symlink；固定 `dist-backup` 根及其完整运行时传递闭包、从 `/` 到该根的祖先链均 root-owned、真实对象/目录、非 symlink、无 group/world 写；固定 node 为部署记录中的确切版本 ≥ 22.19，且 helper 实测 resolved binary 与版本；`age`/`age-keygen`/`pg_dump`/`pg_restore` 只能来自已审核绝对路径或受控 root-owned 安全 PATH，helper 实测 resolved binary/祖先链/版本；backup 用户对固定 node 有实际可执行性。
4. **auth token 不可读**：auth.json 服务账号属主 0600；backup 用户对每个祖先目录仅持 search（traverse）ACE（核对 ACL 一览）；**撤销任一祖先的 traverse 后手动运行部署 helper → fail-closed（探针类失败，exit 非零），指标不变**。**无 root preflight 替代**。
5. **成功路径**：由部署方 scheduler/timer **实际触发一次正常 run**（不是手动触发 helper；必须带 strict flag `--require-complete-session-references`）→ 该 target 指标值 = 本次 backup **start** epoch（≈ 当前时间 − 备份耗时）；stdout 含且仅含一行 `backup-json-report:` 机器报告（状态字段符合 §1）；node_exporter 抓取正常（`node_textfile_scrape_error 0`），指标可见。记录 scheduler identity、非敏感配置摘要、上次 trigger、下次 trigger、实际 start 与 `<=12h` trigger 间隔。手动 run 可作链路探针但不能验收 scheduler/cadence；平台调度配置变更后必须重演 scheduler-originated 正常 run。
6. **失败路径注入**：临时改错接收方/缺失配置 → 非零退出、指标文件 mtime/内容不变；注入仅输出 `backup dry-run:` 且 exit 0 的测试形态 → 输出校验拒绝、指标不变；**注入缺失 session reference（带 strict flag 运行）→ 非零退出、无 `backup-json-report:` 行、无任何发布包/COMPLETE/staging 残留、指标不变**；把指标文件替换为 symlink、或放宽 textfile 任一祖先目录写权限 → 部署 helper fail-closed、指标不变。
7. **单飞与单调（部署层验证）**：并发触发两次同 target helper（或先成功一次、再以更早的 start 迟到覆盖）→ 互斥生效、**指标保持较新的成功值不被倒退**（monotonic max 读-比较-写）；模拟 helper 崩溃后锁/租约不残留死锁，恢复后的下一次成功 run 正常更新指标。
8. **首次缺失**：保留独立 inventory 序列并确保 target `up==1`，删除某 target 的 freshness 指标模拟「从未成功」→ 精确的 `(I and up==1) unless F` 在 `for` 时长后触发 `PiAgentServerBackupFreshnessMetricMissing`；`I unless A` 只用于 Q3 漂移；不得用 target 自己删除/伪造 expected inventory。
9. **stale / future**：把指标值改为 25h 前（对 inventory 与 actual 唯一三元组匹配的实例）→ `PiAgentServerBackupStale` 触发；改为 `time()+600` → `PiAgentServerBackupFreshnessFutureTimestamp` 触发，**并断言该告警 severity = critical**（future timestamp = 无效 freshness / RPO 判定失守；severity 低于 critical 视为验收失败）。
10. **exporter-down**：停掉 node_exporter → inventory `unless` live `up==1` 的 `PiAgentServerNodeExporterDown` 触发（提醒 freshness 规则处于不可信窗口）。
11. **唯一性验收（§6.1 Q1–Q3）**：Q1 的每个完整三元组计数必须精确 1；Q2 必须无跨 job/cluster 的 instance 重复；Q3 的 inventory/actual 双向差集必须无返回。
12. **恢复**：巡检失败后下一次成功 run 指标更新、告警自动恢复；空闲锁残留由部署方对超过一个调度周期的残留锁做清理并记录。
13. **原子性审核证据**：部署方针对目标 OS 记录「.prom 文件原子替换」的审核结论（§2 责任 7）；无法证明的目标平台拒绝部署。

## 9. 人工 runbook：30 天保留清理

自动删除**未实现、未排期**（30 天保留是运维策略承诺；自动 retention 属于**未来单独工作包**，不属于 WP5B（durable idempotency 加固，仅设计注记）也不属于 WP5C（exporter 契约）范围）。每月由 operator：

- 只读查看超过 30 天的备份包（按部署的备份根路径列出 `backup-*` 目录的修改时间，仅观察、不修改）；
- 删除前确认：最近 restore drill 已通过；目标不是 pre-migration/pre-reset 所需；先移到备用 quarantine 目录（如备份根下的 `.quarantine/`），观察期后再物理删除；
- **删除是 operator 决策；CLI、helper、本契约均不自动删除任何备份。**

## 10. 人工 runbook：每季度 + 重大 migration 前 restore drill（顺序修订）

1. **选包（顺序关键）**：
   - 季度 drill：选**最近成功的自动备份**（固定 12h 节奏）；
   - **重大 migration 前 drill：选最近成功的自动备份，或在 migration 窗口前主动创建的一次性 drill backup**——**绝不能选 pre-migration backup**（它在正式 migration 时才生成，drill 时还不存在）。
2. **默认隔离恢复**：按 [backup-restore.md](backup-restore.md) 在隔离环境执行（一次性 target root / 临时 DB schema；drill 解密使用专属一次性 age identity，**与生产私钥隔离，绝不用于本文任何环节**）。默认路径只记录 restore-time 和完整性证据，**不能单独作为 RTO=4h signoff**。
3. **完整 RTO signoff（单独授权后才可执行）**：在 disposable target-like 环境使用合成且无敏感业务数据，计时 `restore → 以 PI_MIGRATION_GATE=verify 启动 → /health、/readyz 与合成无敏感业务检查 → 可服务`；不得接收正式流量或正式服务。完成后立即关闭隔离服务并清理资源；全流程 `<=4h` 且每阶段有脱敏时间证据，才可签署 RTO。
4. **校验**：COMPLETE/manifest/hash/白名单、认证的 migration 前缀与 schema、JSONL/DB 关系、行数/结构抽查；完整 RTO signoff 还必须包含 migration gate、探针、合成业务检查和可服务状态。
5. **记录**：分别记录 restore-time；若执行完整 RTO signoff，再记录上述每个阶段的 start/end、总耗时和关闭/清理结果。默认 restore-time 不得标为 RTO signoff 证据。
6. **顺序保证**：重大 migration drill **必须在 migration 窗口打开之前完成并记录**；随后正式 pre-migration 流程（停服 → 独立确认无写者 → dry-run 审阅 → `--apply --maintenance-window CONFIRMED`）**不停顿地立即执行**——pre-migration backup 在 `--apply` 内部生成，是真正的恢复锚点；drill 之后人为插入等待只会延长无保护窗口，不增加任何安全性。

## 11. 本仓库交付范围与验收状态

- **SOP 状态**：实际部署演练 SOP 已形成，见 [backup-freshness-drill-sop.md](backup-freshness-drill-sop.md)；按用户决定当前为 **DEFERRED**，执行前必须再次获得目标环境授权。Strict backup completeness foundation 已验收，但 **WP5C 仍未验收，WP5 整体仍未验收，服务仍非 production-ready**。

- 本仓库交付物 = **本文契约 + 既有 backup CLI 编译产物 + dist hygiene 回归断言**（`dist-hygiene.mjs` 禁止 `health-core.*` 回归）。仓库内没有 scanner/observer 代码、没有 helper/timer/systemd unit/launchd plist 模板、没有 Alertmanager 配置、没有自动 backup/删除逻辑。
- **验收状态：未验收（可评审）**。本文可评审；**未经过实际部署演练不验收**——部署方按本文落地、连续稳定运行并验证 §8 清单（含 missing/stale/future/per-instance 告警真实触发、§6.1 唯一性验收查询与原子性审核证据）后另行验收；在此之前本文不产生测试数量、不构成验收证据。