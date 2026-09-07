# IP Access Policy 设计（WP5D）

> 当前 RC 以**直接 TCP 对端 IP**作为身份：`PI_ALLOWED_CLIENT_CIDRS` 显式必填，可选 `PI_IP_ACCESS_POLICY_FILE` 提供 per-IP role/disabled/token 画像；逐路由 RBAC 默认拒绝。IP-RBAC 不是 filesystem sandbox，公网暴露禁止。owner transfer 见 [owner-transfer.md](owner-transfer.md)，未来公网 IAM 见 [identity-access-plan.md](identity-access-plan.md)；migration 与部署门禁见 [operations.md](operations.md)。

## 1. 动机与范围

RC 阶段的接入控制把「哪些客户端 IP 能访问、以什么角色访问、是否需要出示 token」固化为显式、可审计、fail-fast 的
**策略核心**：直接 TCP 对端 IP → CIDR gate →（可选）精确 IP 策略画像 → 逐路由 RBAC。

WP5D-1 交付 **core**：CIDR/IP canonical 化与匹配、策略 JSON v1 解析、纯函数决策解析器、token 校验助手、环境变量解析与策略文件安全加载。**不修改**数据库 schema、不引入 owner transfer。

WP5D-2 交付 **HTTP 接线**：startServer/buildApp 强制准入配置（failfast）、全局 onRequest admission（覆盖探针与 `/v1`）、探针与 `/v1` 的 401/403 语义。**不执行** role 授权（WP5D-3）与 workspace 安全（当前 RC 决策：整体延期）。

WP5D-3 交付 **role 授权矩阵**：基于 `request.access.role` 的逐路由授权（每路由显式 permission、全局
default-deny、纯函数决策）、探针/metrics/operator/viewer/user/admin 冻结矩阵（见 §6）、403 固定响应体
（不泄 role/IP/path）、CORS 预检不做 role、SSE viewer 只读、矩阵与 failclosed/副作用语义。**不执行** admin 跨
owner 只读、workspace/sandbox 安全（current RC 决策：整体延期）、owner transfer。

## 2. 冻结决策（本工作包已定，不得在实现中偏离）

1. **身份以直接 socket IP 为准**：不使用 `X-Forwarded-For` 等代理头推导客户端 IP；一律读
   `request.raw.socket.remoteAddress`（`request.ip` 受 Fastify trustProxy 配置影响，亦不使用）。双栈 socket 上报的
   `::ffff:a.b.c.d` **归一为 v4** 再参与后续判定，身份键/ownerKey 一律使用 canonical IP 文本。
2. **一个 IP = 一个用户**：策略解析的单位是 canonical IP；IP 是身份键、资源隔离键（`owner_key`）与速率限制主体的基础。
3. **`PI_ALLOWED_CLIENT_CIDRS` 显式必填，无默认值**：缺失/空白直接拒绝启动。CIDR 外的 IP 一律 deny（默认拒绝模型）。
4. **CIDR 内未登记（策略文件中无精确条目）的 IP 使用默认画像**：`role=user`、`tokenRequired=false`（token off）。**没有 workspace 概念**：IP-RBAC 不限制 cwd 或 Agent 工具的绝对路径/OS 权限（不是 sandbox；见 §7）。
5. **可选 `PI_IP_ACCESS_POLICY_FILE`**：其中**精确 IP** 条目可覆盖：`role`（仅 `admin|user|viewer|operator` 四选一）、`disabled`、`tokenRequired`、绑定的 token `sha256` 哈希列表。
6. **token 只保存 `sha256:<64 位小写 hex>`**；全文件**全局唯一**（一个 token hash 只能绑定一个精确 IP）；`tokenRequired=true` 的条目**必须有**非空 hash 列表；未启用 `tokenRequired` 的条目**不得**携带任何 hash（off 不得 hash）。token gate **作用于 `/v1` 与 `/metrics`**：`tokenRequired` 画像的**实际请求**（GET/非预检 OPTIONS）必须出示绑定该 IP 的 Bearer token；合规 CORS 预检免 token；`/health`、`/readyz` 存活/就绪探针**永远免 token**（任意 admitted IP/role，不被令牌问题卡死）。
7. **token 不换绑、不迁移**：token 与精确 IP 的绑定在策略文件中一次性固化；不存在换绑接口；迁移到未来 IAM 账号体系（identity-access-plan 工作包 1）**不**把策略 token 迁走，策略 token 只服务 IP 接入阶段。
8. **规则异常 failfast**：任何非法/非规范/自相矛盾的配置（含策略条目超出允许 CIDR 的死配置）在加载期抛错，绝不静默降级、绝不部分生效。
9. **工作目录不受 IP-RBAC 约束（当前 RC 决策）**：内网当前不做 workspace 强制；IP-RBAC 不限制 cwd 或 Agent 工具的绝对路径/OS 权限（不是 sandbox）。workspace 安全（收窄工具/会话可见根目录、防路径逃逸）**仅公网暴露前需要**，随未来 OIDC/IAM + workspace/sandbox 设计一起做。当前服务 cwd（`AGENT_CWD` / 项目 cwd）行为保持原状，不被 IP-RBAC 约束。

## 3. 配置契约

| 环境变量 | 必填 | 语义 | 校验（外层 parser） |
| --- | --- | --- | --- |
| `PI_ALLOWED_CLIENT_CIDRS` | **是**（无默认） | 逗号分隔的允许客户端 CIDR 列表 | 每个元素必须是**严格 canonical** CIDR（规范网络地址/前缀）；v4 无前导零、v6 小写且 RFC 5952 规范化、主机位为零；IPv4-mapped 形式允许并归一为 v4（前缀 ≥96，映射出的 v4 地址必须是对应前缀的网络地址、主机位为零：`::ffff:1.2.3.0/120` → `1.2.3.0/24`，`::ffff:1.2.3.4/120` 拒绝）；无重复 |
| `PI_IP_ACCESS_POLICY_FILE` | 否 | 策略文件绝对路径 | 设置时必须为绝对路径；文件加载另有完整安全检查（§8） |

### 3.1 策略文件 JSON（version 1）

```jsonc
{
  "version": 1,                    // 必须为数字 1
  "ips": [                         // 非空；精确 IP 条目
    {
      "ip": "203.0.113.7",         // 必须：canonical IP 文本（mapped 归一为 v4）；全文件唯一
      "role": "admin",             // 可选：admin|user|viewer|operator；缺省 user
      "disabled": true,            // 可选：true = 永远 deny；disabled 条目不得携带其他字段
      "tokenRequired": true,       // 可选：true ⇔ 必须提供非空 tokens
      "tokens": [                  // 可选：仅当 tokenRequired=true；全文件全局唯一
        "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
      ]
    }
  ]
}
```

严格性（全部 failfast，错误消息不回显 token 值）：

- 顶层仅允许 `version`、`ips`；`version` 必须等于数字 1；`ips` 非空数组。
- JSON 语法由**受限解析器**完整校验：**任意对象层级不得重复 key**（顶层/条目/tokens 内对象一律拒绝，不用 `JSON.parse` 的“后者覆盖前者”语义）；错误消息不回显文件内容或 key 名（脱敏）。
- 条目仅允许 `ip/role/disabled/tokenRequired/tokens`；未知字段拒绝（防拼写错误）。
- `disabled: true` 与 `role/tokenRequired/tokens` **互斥**（否定性死配置直接拒绝）。
- `tokenRequired` 与 `tokens` 的组合严格互证（缺一即错）。
- 精确 IP 不能重复（归一后判重）；token hash 全文件唯一（不换绑的直接体现）。
- 加载期一致性：**每个精确 IP 必须落在 `PI_ALLOWED_CLIENT_CIDRS` 内**，否则死配置 failfast。

## 4. 解析流程（纯函数 `resolveIpAccess` + 接线 `createAdmission`）

```text
直接 socket IP（request.raw.socket.remoteAddress；X-Forwarded-For 一律忽略）
   │ parseIpStrict：canonical 化（::ffff:a.b.c.d → v4；不可解析 → failclosed 403）
   ▼
是否命中 PI_ALLOWED_CLIENT_CIDRS 任一网段？
   ├─ 否 → deny 403 (outside-cidr)   ← 出示任何 token 都不能绕过
   ▼ 是
策略文件是否有该精确 IP 条目？
   ├─ 有且 disabled → deny 403 (disabled)
   ├─ 有 → allowed：role=条目.role、tokenRequired=条目.tokenRequired、
   │        tokenHashes=条目.tokens
   │        ├─ /v1 或 /metrics 且 tokenRequired：合规 CORS 预检（OPTIONS + Origin +
   │        │   Access-Control-Request-Method）免 token，随后交 CORS origin policy
   │        ├─ 其他 /v1 或 /metrics 实际请求（GET）与非预检 OPTIONS：缺失/错误 Bearer → deny 401 (token-required)
   │        ├─ /health、/readyz（任意 admitted role，永不 token gate）：Bearer 忽略，直接放行
   │        └─ token off：Bearer 忽略，直接放行
   └─ 无 → allowed（默认画像）：role=user、token off
```

解析器是纯函数（无 IO、无日志），输入为已校验配置 + IP 文本，输出 `denied`/`allowed+profile`。接线层
（`src/server/network-admission.ts` 的 `createAdmission`）把 socket IP、CIDR gate、token gate 组装为
per-request 决策：allowed 只携带 `user`（canonical IP 身份）+ `access`（public profile，**无 token
hashes**）注入 `request`；401/403 响应体不含原始 IP/token/path。profile 是 WP5D-3 授权（role）的
唯一依据：role 已用于逐路由授权（§6.1）；**workspace 安全不在 WP5D 内**（IP-RBAC 不限制 cwd/工具
绝对路径/OS 权限，当前 RC 决策延期）。

## 5. Bearer token 语义

- 存储：只存 `sha256:<64 位小写 hex>`（`hashBearerToken`）。
- 校验：出示 token **只哈希一次**；随后与该 IP 画像绑定的**全部**哈希逐项做定长常量时间比较（`timingSafeEqual`），**遍历全部条目、不短路**，累积匹配结果——对固定画像，比较工作量与命中位置、命中与否无关（准确表述：常量时间指单项定长比较与不短路遍历；总工作量随画像 hash 条数线性增长，不依赖任何秘密内容）。
- **IP binding**：只比较当前请求 IP 画像上的哈希——同一 token 出现在别的 IP 下无效（换绑被策略结构禁止）。
- token off 的请求可不带 token（出示的 Bearer 一律忽略）；token required 时实际请求与非预检 OPTIONS 缺省/错误 token 一律 401。
  **token gate 作用于 `/v1` 与 `/metrics`**：合规 CORS 预检（`OPTIONS` + `Origin` + `Access-Control-Request-Method`）免 token，随后仍交 CORS origin policy；`/health`、`/readyz` 存活/就绪探针仅 IP gate（tokenRequired 画像的 IP
  访问这两个探针也无需出示 token）——探针可被监控正常消费，且不因未登记/令牌问题误报进程状态；`/metrics` 是 admin/operator 运维面，其画像 tokenRequired 时实际 GET 仍须出示 token（预检例外同上）。
- **日志红线**：token 明文与哈希均不得记录；对外日志只允许 `publicProfile`（ip/role/tokenRequired/registered，无哈希），且接线层日志只带 `subjectHash`（IP 派生哈希），**不记录原始 IP**；`request.access` 与 `request.user` 是唯一注入点，token hashes 从不挂到 request 上。
- 配合既有 §5 日志约定：涉及主体聚合的日志字段继续使用 `subjectHash`（IP 的派生哈希），不记录原始 IP 或 token。

## 6. 角色矩阵（WP5D-3 已实现并强制）

矩阵冻结如下，`src/server/route-rbac.ts` 的 `ROUTE_PERMISSIONS` 是唯一权威定义（每路由显式声明
`config.permission`；不是按 HTTP method 粗略匹配）：

| 路由类别 | viewer | user | operator | admin |
| --- | --- | --- | --- | --- |
| `GET /health`、`GET /readyz` | ✅ 任意 admitted role | ✅ | ✅ | ✅ |
| `GET /metrics` | ❌ | ❌ | ✅ | ✅ |
| `GET /v1/models`、`GET /v1/projects`、`GET /v1/sessions`、`GET /v1/sessions/:id/export`、`GET /v1/sessions/:id/events`（SSE） | ✅ 纯读 | ✅ | ❌（/v1 一律 403） | ✅ |
| `POST /v1/projects`、`POST /v1/sessions` | ❌ | ✅ | ❌ | ✅ |
| `PATCH /v1/sessions/:id`、`PATCH /v1/sessions/:id/config`、`DELETE /v1/projects/:id`、`DELETE /v1/sessions/:id` | ❌ | ✅ | ❌ | ✅ |
| `POST /v1/sessions/:id/messages`、`POST …/steer`、`POST …/follow-ups`、`POST …/abort` | ❌（写/控制） | ✅ | ❌ | ✅ |

- **operator：`/v1` 全部拒绝（403）**，含纯读 GET；仅探针 `/health`/`/readyz`/`/metrics` 可达。
- **viewer：只读**——允许上述纯读 GET 与 SSE 订阅；一切 POST/PATCH/DELETE（含 messages/steer/
  follow-ups/abort）一律 403。
- **SSE viewer 语义（P2 稳定受控态）**：viewer 订阅只走 `registry.getExisting`，**绝不创建 runtime**；
  会话记录存在但无 runtime（未实例化）时返回**稳定受控态 `204 No Content`**（无可订阅的 live 事件流，
  零 adapter/DB/文件副作用）；已有 runtime 的会话可正常订阅（200 流）。这是有意区分：documented
  404 = 不存在/越权，`204` = 存在但无 live 流。
- **会话导出只读（P1）**：`GET /v1/sessions/:id/export` 对任何角色都**绝不实例化 runtime**：已有 runtime
  走活会话导出；无 runtime 且未持久化（`conversationRef` null）→ 空消息 + 游标 0；无 runtime 但已持久化 →
  注入的 `ConversationStorage` 零写只读解析（与活会话导出同一 `{role,text}` 投影，文件指纹验证零写、
  错误脱敏），绝不 createAdapter/写 DB/写 conversationRef。
- **user/admin**：允许既有 own-resource 路由行为；资源访问仍 **owner 隔离**（列表/子资源访问他人
  资源统一 404）。**admin 跨 owner 只读未实现（WP5D 明确不做）**：admin 与其他角色一样只能访问
  自己的会话/项目。
- **workspace 安全已延期（当前 RC 用户决策）**：内网不做 workspace 强制，workspace 安全仅公网暴露前需要。
- role 是 per-IP 画像的一部分（一个 IP = 一个用户），不因出示 token 而改变（token 只满足
tokenRequired，不换角色）；未登记 IP 默认 `user`。

### 6.1 路由授权实现（WP5D-3，已接线）

- **中央定义**：`src/server/route-rbac.ts` 的 `ROUTE_PERMISSIONS`（permission → 允许角色集合）与
  `evaluateRouteAuthorization`（纯函数决策）；`requirePermission(permission)` 是每路由显式声明点。
- **default-deny**：全局 `onRequest` hook（注册顺序：admission → `@fastify/cors` → `routeRbacOnRequest`）
  读 `request.routeOptions.config.permission`；**真实路由未声明/未知 permission → 403**，绝不因
  method 粗略匹配误放行；未匹配真实路由的请求（含 route-level 禁用的 HEAD/未知路径）交回 404。
- **failclosed**：`request.access` 缺失/role 未知/伪造 → 403（不泄 role/IP/path；固定 `FORBIDDEN_BODY`）。
- **403 固定响应体**：与准入 403 同一字面量 `{statusCode:403, error:"Forbidden", message:"请求被拒绝"}`；
  拒绝日志只带固定枚举（`authz:"denied"` + reason，subjectHash 由准入后置日志携带）。
- **401 保持 token 语义**：token gate（admission 层）先于 role gate；`tokenRequired` 缺失/错误 token
  仍 401（`WWW-Authenticate: Bearer`），不因角色允许而跳过。
- **CORS 预检不做 role/token**：合规预检（`OPTIONS` + `Origin` + `Access-Control-Request-Method`）由
  CORS 插件在 role gate 之前的 onRequest 直接回 204（仍先过 admission）；实际请求才 role gate。
- **owner 隔离不变**：user/admin 跨 owner 访问统一 404（与不存在一致），admin 暂不跨 owner。

## 7. 边界与明确不做（WP5D 范围内）

- **IP-RBAC 不是 sandbox，也不限制 cwd**：本阶段的网络准入 + 角色授权只判断「谁能访问哪些路由」；
  **不限制** Agent 工作目录（cwd）、Agent 工具的绝对路径或 OS 级权限，也不做路径逃逸防护。文件系统级
  隔离由 OS 账号、容器与网络边界负责。**公网暴露禁止**：公网部署不得开放本服务（含 `POST /v1/projects`
  的任意 cwd 创建项目接口，见 needs.md §7）；workspace/sandbox 安全设计（收窄工具/会话可见根、防路径
  逃逸）随未来 OIDC/IAM 工作包一起做。
- **owner transfer 仅 DB 层面，且只存在 IP→IP 形态**：`owner-transfer` 离线 CLI（WP5D-4，见 [owner-transfer.md](owner-transfer.md)）在数据库层变更 owner 映射（把一个 IP 身份资源归属转到另一个 IP 身份，仅更新 projects.owner_key / sessions.owner_key）；**不迁移**政策文件的 IP 条目与 token 绑定、不迁移角色——接收方继承自己的 IP 画像，与资源原 owner 的画像无关。
- **无 legacy 账号/token 迁移（RC 决策）**：新 RC **不存在** legacy 账号/token 的 owner 迁移——正式旧公网 token 数据从未存在，因此不实现任何「旧 token/旧账号 → 新主体」迁移代码，也不存在 owner transfer 的账号维度。旧库或无 canonical baseline 的库不做在位转换；只有完全空目标可以按 [ADR 0002](decisions/0002-canonical-baseline-and-migration-gate.md) 离线 bootstrap，绝不把已有数据自动采用为 baseline。
- **不做**：token 签发/轮换/撤销接口（无签发端点）、OIDC/账号体系（见 identity-access-plan 工作包 1–2）、基于 header 的客户端 IP 推导、审计落库（WP5D-2 接线时按 needs.md §7 要求补齐鉴权审计埋点）。
- **当前为单实例**：未来多实例改造需要统一设计策略分发、共享 JSONL 和分布式协调，架构边界见 [architecture.md](architecture.md)。

## 8. 策略文件加载安全（`readIpAccessPolicyFile`）

对齐 backup-core 既有的文件安全约定（`src/backup/backup-core.ts`）：

1. **绝对路径**（parser 已强制，loader 复核）；
2. `lstat` 先验：**非符号链接**、普通文件、**单一硬链接**（nlink=1）；
3. **属主 = 当前 euid 或 root**（`st.uid` 检查；允许部署以 root 属主挂载配置）；
4. **无任何 group/world 权限位**（`mode & 0o077 == 0`，即 0600/0400 之类）；
5. **大小上限** 1 MiB（`IP_POLICY_FILE_MAX_BYTES`），超出即拒绝；
6. 以 `O_RDONLY | O_NOFOLLOW` 打开，**fd 上的 `fstat` 复核**同一组约束（打开与统计之间不可被替换）；
7. 按 fstat 报告的大小精确循环读取，读毕再次 `fstat`：`size/mtime/ino/nlink/uid/mode` 任一变化 → 判定读取期间文件被替换/修改，整体拒绝（稳定读取，杜绝 TOCTOU 不一致内容）。

## 9. HTTP 接线（WP5D-2，已实现）

接线已改变 HTTP 行为，本文上述语义在运行的服务上**生效**：

- **启动路径**：`main.ts` 调 `parseIpAccessEnv(process.env)`（`PI_ALLOWED_CLIENT_CIDRS` 显式必填）→
  `loadIpAccessPolicy`（可选策略文件安全加载）→ 组装 `ipAccess` 注入 `startServer`；
  **缺失/非法配置拒绝启动**。`startServer` 与 `buildApp` 入口都执行
  `requireIpAccessRuntimeConfig` 运行时严格 shape 校验（含策略覆盖复核），直接 JS bypass 也 fail。
- **请求路径**：`buildApp` 注册**全局** `onRequest` admission（`createAdmission`），覆盖探针与 `/v1`：
  读 `request.raw.socket.remoteAddress` → CIDR/disabled gate（denied → 403）→（`/v1` 或 `/metrics` 且 tokenRequired，且非合规 CORS 预检）
  `verifyProfileToken`（缺失/错误 → 401）；allowed 注入 `request.user`（canonical IP 身份）与
  `request.access`（public profile，无 hashes），`subjectHash` 只进日志。unknown socket IP → failclosed 403。
- HTTP 状态码：CIDR 外/disabled/不可解析 → `403`（body 不含原始 IP/token/path）；`/v1` 与 `/metrics`
  tokenRequired 缺失/错误 → `401`（沿用「缺少或无效的 Bearer Token」），token off 忽略 Bearer；
  `/health`、`/readyz` 仅 IP gate（任意 admitted role，免 token）。
- 鉴权审计按 needs.md §7 埋点沿用 `subjectHash`（IP 派生哈希）关联，不记录原始 IP。
