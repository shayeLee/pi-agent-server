# 身份与访问管理（IAM）规划：未来公网方案

> 本文只记录**未来公网暴露前**的 IAM 方案与路线图，是规划文档，**不是实现承诺**；凡标注「待定」的条目均未拍板，标注「尚未实现」的条目当前均为空白。当前 migration 与备份操作分别以 [operations.md](operations.md) 和 [backup-restore.md](backup-restore.md) 为准；**不记录测试数量、不转述历史验收证据**。
>
> 当前接入控制（RC）由 **IP-RBAC（WP5D）** 承担，语义见 [ip-rbac-design.md](ip-rbac-design.md) 与 [owner-transfer.md](owner-transfer.md)，本文不重复。IAM 从新主体体系开始。

## 1. 目的、范围与非目标

### 目的

为 pi-agent-server 的**公网暴露**建立完整的身份与访问管理，使服务具备：

- **认证 Authentication**：让浏览器、自定义 UI、工作流和业务系统以统一方式完成登录与凭证校验；
- **身份识别 Identity**：把认证结果解析为服务内部的稳定主体（用户身份 / 服务身份），取代「来源 IP 或静态 token 字符串」这类粗糙身份派生；
- **授权 Authorization**：基于角色与 scope、结合资源归属（owner），对每个请求做权限校验。

最终目标是对**所有客户端类型一视同仁**的接入机制：Web UI、自定义 UI、工作流与业务系统都通过同一 HTTP/SSE API 表面接入，统一使用 **Bearer Access Token** 鉴权。

### 范围

- Bearer Access Token 的签发、校验、过期与撤销；
- OAuth 2.0 / OIDC 作为登录与授权委托通道；
- API Key 全生命周期管理（签发、哈希存储、只显示一次、前缀、过期、轮换、撤销、scope、审计）；
- 用户 / 外部身份 / 服务身份的数据模型与归属关系；
- 角色与权限（RBAC + scope）；
- 审计日志。

### 非目标（本阶段不承诺）

以下条目**尚未决定**，本文不作出承诺，也不被本路线图隐含约束：

- 本地密码注册/登录（是否提供未决定；当前规划不依赖它，登录身份优先来自 OIDC provider）；
- 具体 OAuth provider（Google、Microsoft、Okta、钉钉、自建 Keycloak 等均未选定，见 §8）；
- Access Token 形态（JWT 还是 opaque 未决定，见 §6/§8）；
- 具体时间表（不承诺交付日期，仅给工作包顺序与验收标准）。

## 2. 当前接入控制（RC）边界

- 当前接入控制由 **IP-RBAC** 承担：所有路由以直接 TCP 对端 IP 过 CIDR/disabled gate；`/v1` 与 `/metrics` 上 `tokenRequired` 画像才要求 Bearer token（hash 绑定精确 IP）；`/health`、`/readyz` 永不需要 token；身份一律取直接 TCP 对端 IP，绝不使用 `X-Forwarded-For`/`request.ip`。详见 [ip-rbac-design.md](ip-rbac-design.md)。
- **无 legacy 账号/token 迁移**：本 RC 从未存在正式公网 token 数据，因此**不实现**任何「旧 token/旧账号 → 新主体」迁移代码；旧库或无 canonical baseline 的库不做在位转换。只有完全空目标可以离线执行 `pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED` 建立唯一 canonical baseline，具体接受面见 [ADR 0002](decisions/0002-canonical-baseline-and-migration-gate.md)。
- **公网暴露禁止**，直到未来 OIDC/IAM + workspace/sandbox 设计落地；IP-RBAC 不是 sandbox、不限制 cwd 或 Agent 工具绝对路径/OS 权限（workspace/sandbox 安全延期至公网暴露前）。

## 3. 术语与边界

- **Authentication（认证）**：验证调用方出示的凭证是否有效，回答「你是谁」。**认证通过 ≠ 拥有权限**。
- **Identity（身份识别）**：把认证结果解析为服务内部的稳定主体标识（用户身份或服务身份），并承载归属（owner）关系。
- **Authorization（授权）**：基于主体、角色/scope、资源归属，判定「你能做什么」。只有认证 + 身份之后才进入授权。
- **OAuth 2.0**：**授权委托**协议，核心是资源所有者授权第三方应用代表自己访问受保护资源；OAuth 本身不提供用户身份语义。
- **OIDC（OpenID Connect）**：在 OAuth 2.0 之上增加**身份层**，通过 ID Token 与 userinfo 端点提供登录后的身份断言；「用户登录」用 OIDC，「代表用户访问资源」用 OAuth 授权码流程（实践中常一起出现，授权码 + PKCE 即典型 OIDC 登录流程）。
- **Access Token**：本服务统一使用的请求级鉴权凭证（短期、可撤销、绑定主体，随 `Authorization: Bearer <token>` 携带）。**不是登录协议**。
- **API Key**：面向非交互程序（业务系统、批量任务、CI）的**长期机器凭证**，识别 **service identity**。

**一句话边界**：OAuth 主要做**授权委托**，OIDC 提供**登录身份**；Access Token 是**请求级鉴权凭证**，API Key 是**长期服务凭证**——它们不是同义词。

## 4. 已确认架构原则

以下原则**已确认**，后续设计与实现不得偏离：

1. **Client-neutral 接入**：HTTP/SSE API 是唯一接入表面，不做"浏览器专用"或"内部专用"的认证旁路。
2. **Access Token only**：所有客户端统一使用 Bearer Access Token，不使用 Session Cookie / 会话式鉴权（无 Cookie、无 CSRF 依赖）。
3. **从新主体体系开始**：IAM 从新主体体系开始（见 §2）。
4. **最小权限**：默认无权限，按角色 + scope 显式授予；请求级校验集中化，禁止业务代码自行判断。
5. **资源归属（ownership）**：`owner_key` 隔离是既有正确基线并继续演进；认证/身份层产出稳定 subject，资源归属以其为准。
6. **审计**：认证、授权、token 签发/撤销、API Key 生命周期、鉴权失败均须持久化审计；记录主体、动作、资源、结果与时间，**不记录密钥、token 明文与消息正文**。
7. **凭证不落明文**：app secret / API Key 明文只在签发时展示一次；落库与日志只存单向哈希 + 可检索前缀；token 记录同样只存哈希。
8. **认证与身份分离**：token 校验通过后，身份取自账号体系，而不是 token 字符串本身、来源 IP 或静态映射账号名。
9. **数据变更门禁**：一旦承诺保留真实用户数据，IAM 表上线前必须完成正式 migration / 备份 / 回滚；当前不支持 reset、final reset 或 cutover，migration 只能走完全空目标 bootstrap 或已有 canonical baseline 的 apply（见 [ADR 0002](decisions/0002-canonical-baseline-and-migration-gate.md)）。

## 5. 目标架构与典型流程

### 5.1 整体分层

```text
                         ┌──────────────────────────────────────┐
 客户端（Web UI / 自定义UI│                                        │
 / 工作流 / 业务系统）     │   pi-agent-server                    │
   │                      │   ├ 认证 Authentication（凭证校验）     │
   │ Bearer Access Token  │   ├ 身份 Identity（→ 用户/服务主体）    │
   ▼                      │   ├ 授权 Authorization（角色/scope/owner）│
 ┌──────────┐             │   ├ Token 生命周期（签发/验证/过期/撤销）│
 │HTTP + SSE│────────────▶│   └ 审计（鉴权与凭证生命周期事件）      │
 └──────────┘   /v1/*     │                                │
                        └──────────────────────────────────────┘
                                                │
                          OIDC 登录（浏览器/UI）  ▼
                           ┌────────────── OIDC Provider ──────────────┐
                           │ 授权码 + PKCE → ID Token / userinfo        │
                           └───────────────────────────────────────────┘
```

### 5.2 典型流程 A：浏览器 / 自定义 UI（OIDC 登录）

1. 客户端发起 OIDC 登录（Authorization Code + PKCE）；
2. provider 回调后，服务端校验 `authorization code`、验证 ID Token 签名与声明，调用 `userinfo`（按 provider 能力）；
3. 服务端将 provider 主体映射/创建为**内部用户身份**（`users` + `external_identities`，见 §6）；
4. 服务端为该用户**签发 Bearer Access Token**（形态见 §8）；
5. 后续请求携带 `Authorization: Bearer <access token>`；
6. 服务端校验 token → 解析用户主体 → 按角色/scope/资源归属授权 → 进入业务处理。

> 明确不引入 Session Cookie：登录成功后浏览器持有的是 Access Token，不是会话 cookie。

### 5.3 典型流程 B：业务系统 / API Key

1. 业务系统持有为其签发的 API Key（仅创建时展示一次明文，服务端只存哈希）；
2. 请求携带 `Authorization: Bearer <api_key>`（或约定的 key 头，形态未定）；
3. 服务端按前缀定位候选、哈希比对 → 校验过期/撤销状态 → 解析为**服务身份（service identity）**与绑定 scope；
4. 按 scope + 资源归属授权后进入业务处理；关键动作落审计。

### 5.4 Token 生命周期（当前定调）

- **签发**：登录（OIDC）或凭 API Key 的场景按策略签发；签发时明文只出现一次。
- **校验**：每次请求校验存在性、未过期、未撤销、绑定主体有效。
- **过期**：Access Token 短期有效，过期后客户端须重新获取。
- **撤销**：显式撤销（用户登出、安全事件、管理员操作）写入吊销状态，立即失效。
- **轮换**：涉及刷新/密钥轮换，具体形态**待定**（§8）。

> **Refresh Token 形态未定**：是否引入、opaque 旋转式还是长期式、服务端/客户端存储、与 Access Token 的寿命比例，全部列入 §8 待决策项。

## 6. 数据模型方向（非最终 DDL）

> 以下表仅为**方向性设计**，不是最终 DDL。最终实现必须走既有约束：运行时 Schema Manifest 为唯一来源、`schema-types.ts` 推导类型、方言 DDL 由 bootstrap 生成（详见 [database-design.md](database-design.md)），并**先完成正式 migration / 备份 / 回滚**（操作来源见 [operations.md](operations.md) 与 [backup-restore.md](backup-restore.md)）。

| 表（方向） | 责任 | 关键字段方向 | 敏感字段处理 |
| --- | --- | --- | --- |
| `users` | 内部用户主体（用户侧身份） | `id`、`username`/`display_name`（形态待定）、`status`（active/disabled）、`created_at`、`last_login_at` | **不存密码 / 不存外部凭证**；凭据在 OIDC provider 侧或按 §8 决策 |
| `external_identities` | 用户 ↔ 外部登录主体的映射 | `id`、`user_id`（FK）、`provider`、`subject`（provider 侧唯一标识）、`email`、`created_at` | email 等 PII 受访问控制；不做明文密码 |
| `access_tokens` | Access Token 的登记与生命周期 | `id`、`user_id`、`token_hash`（单向哈希）、`prefix`（可检索前缀）、`issued_at`、`expires_at`、`revoked_at`、`scopes`、`created_at` | **只存哈希 + 前缀**，绝不存明文；签发时明文仅返回一次 |
| `api_keys` | 服务身份长期凭证 | `id`、`prefix`、`key_hash`、`display_name`、`actor_id`/`user_id`、`scopes`、`expires_at`、`revoked_at`、`last_used_at`、`created_at` | 同上：哈希 + 前缀；明文只显示一次；可独立撤销 |
| `roles` / `permissions` | 角色与权限点定义 | `id`、`code`、`description`、`permission_codes`（RBAC 模型见 §8） | 非敏感，无密钥 |
| `role_bindings` | 主体（用户或服务）→ 角色 | `id`、`actor_type`（user/service）、`actor_id`、`role_id`、`scope`、`created_at` | 可追踪谁被授予什么 |
| `audit_logs` | 鉴权与凭证生命周期审计 | `id`、`time`、`actor_type`、`actor_id`、`action`、`resource`、`scope`、`result`、`request_id`、`client_ip`（可选） | **不记录** token 明文、API Key、消息正文、密钥；保留期与访问权限单独定义 |

**设计要点**：

- **归属演进**：现有 `owner_key` 继续作为资源隔离键；IAM 落地后，主体标识的派生规则从「IP/静态账号」切换为「账号体系」，隔离查询语义（`listByOwner`）保持不变。
- **凭证密码学**：所有 secret 值单向哈希（算法待定，§8）；前缀用于键盘输入/日志定位与数据库索引，不泄露密钥本身。
- **scope 粒度**：scope 字符串集合随 token / API Key 落库，授权时做交集校验（token scope ∩ 主体角色 ∩ 资源归属）。
- **最终依赖**：所有新表上线前提是正式 migration / backup / rollback 就绪（见 §7 工作包 0）——**在承诺保留真实用户数据之前，禁止在任何真实库上做 destructive reset**。

## 7. 分阶段工作包、依赖与验收

依赖主线：**0 → 1 → 2 → 3 → 4 → 5**。IAM 工作包 0–5 均为规划，尚未开始；每个工作包完成后必须跑对应测试与 build；后续工作包不得提前宣称前置包已完成。

### 工作包 0：前置（数据与基建就绪）

- **内容**：
  - 数据策略决策：是否开始保留真实用户数据；一旦保留，正式 migration / 备份 / 回滚与当前适用的启动门禁必须先就绪；操作来源是 [operations.md](operations.md) 与 [backup-restore.md](backup-restore.md)。
  - IAM schema decision：确定 §6 表集、Access Token 形态、哈希算法、scope 命名（产出决策记录，更新本文档）。
- **依赖**：数据策略与 IAM schema 决策是本包自身应完成的内容；正式 migration / backup / rollback 依赖当前操作文档所定义的 canonical baseline 与门禁。
- **验收**：数据策略与 IAM 决策书面确认；无任何真实库上执行 destructive reset；IAM schema 决策完成。

### 工作包 1：identity / token 基础

- **内容**：
  - `users` / `external_identities` 基础模型与 Repository/Port/Service；
  - Access Token 签发 / 验证 / 过期 / 撤销（服务端 token 记录 + 哈希存储，形态可为 opaque，JWT 决策见 §8）；
  - 认证与身份解耦：token 校验通过后身份一律来自账号体系；不做任何静态映射账号到新主体的迁移。
- **依赖**：工作包 0。
- **验收**：token 生命周期（签发/过期/撤销）单测 + 集成测试通过；身份派生切换后 `owner_key` 隔离语义不变；既有测试与 build 全绿。

### 工作包 2：OIDC / OAuth provider 接入

- **内容**：
  - 选定并按序接入至少一个 OIDC provider（列表见 §8，未定）；
  - 实现 Authorization Code + PKCE 登录流程、ID Token 验证、userinfo 获取；
  - `external_identities` 映射：首次登录自动建档或按待定策略关联（§8）；
  - 登录成功签发 Access Token，接入 §5.2 流程 A。
- **依赖**：工作包 1（身份模型与 token 能力）。
- **验收**：mock provider 与真实 provider（在安全测试环境）的完整登录→取 token→鉴权链路通过；PKCE、ID Token 签名校验、状态参数防 CSRF 有对应测试；用户建档/关联策略按 §8 决策落实。

### 工作包 3：authorization（RBAC + scope + 资源归属）

- **内容**：
  - `roles` / `permissions` / `role_bindings` 落地（模型按 §8 决策）；
  - 请求级授权中心化：角色权限 ∩ token/API Key scope ∩ 资源归属（owner）；
  - 现有资源（项目/会话）接入授权校验，默认无权限；
  - 审计埋点：授权拒绝与放行关键事件。
- **依赖**：工作包 1（身份稳定），可与工作包 2 并行设计，但实现须在 1 之后。
- **验收**：权限矩阵测试（无角色/弱 scope/越权访问均正确拒绝）通过；授权逻辑集中、无业务代码私自放行；拒绝路径返回一致状态码且有审计。

### 工作包 4：API Key + audit

- **内容**：
  - `api_keys` 生命周期端到端：签发（明文只显示一次）、哈希存储、前缀、过期、轮换、撤销、scope 绑定；
  - service identity 解析与 §5.3 流程 B 落地；
  - `audit_logs` 全面落地：认证、授权、token/API Key 生命周期、鉴权失败；保留期与访问权限；写入失败告警。
- **依赖**：工作包 1（token 机制基础）+ 工作包 3（scope 语义）。
- **验收**：API Key 全生命周期单测/集成测试通过；撤销即时生效；审计事件覆盖清单全部落库且不含密钥/正文/明文；审计写失败有告警机制。

### 工作包 5：安全、测试与发布

- **内容**：
  - 攻击测试：token 伪造/篡改、重放、越权、过期 token、撤销后重用、日志泄漏、CSRF（若残留任何浏览器流程）；
  - 密钥轮换演练与 KMS/密钥管理决策落地（§8）；
  - 监控告警：鉴权失败率、token 撤销风暴、异常签发、审计缺口；
  - 正式 migration / 备份 / 回滚演练（与工作包 0 的策略衔接）；
  - 双库（SQLite/PG）验收与发布检查。
- **依赖**：工作包 2/3/4 的核心实现完成。
- **验收**：攻击测试清单全部通过或有明确缓解；轮换与回滚演练流程化并有文档；监控项上线；正式发布通过双库验收与既有回归。

## 8. 待决策项清单（TBD）

以下条目**尚未决定**，决策前不得在实现中隐含默认值：

| # | 待决策项 | 影响面 | 备注 |
| --- | --- | --- | --- |
| 1 | OIDC provider 选型（Google / Microsoft / Okta / 钉钉 / 自建 Keycloak 等） | 工作包 2 | 影响外部身份映射与合规 |
| 2 | Access Token 形态：JWT vs opaque（随机串 + 服务端记录） | 工作包 1/2 | 影响撤销粒度、校验开销、离线校验能力 |
| 3 | Refresh token：是否引入、形态、存储（服务端/客户端）、轮换 | §5.4 | 本文不把任何形态定死 |
| 4 | 用户注册/邀请：预置邀请、首次登录自动建档、管理员签发 | 工作包 2 | 影响 `users` 建档入口 |
| 5 | 角色模型：静态角色名 vs 权限点+组合、内置角色集 | 工作包 3 | 影响 `roles`/`permissions` 结构 |
| 6 | Token 存储与密码学：哈希算法、前缀长度、签名/加密密钥与 KMS | 工作包 1/4/5 | 影响密钥管理与轮换 |
| 7 | 本地密码/MFA 是否纳入 | 全阶段 | 当前默认不依赖本地密码 |

决策流程：每项决策须在对应工作包落地前书面记录（更新本文档与相关设计文档），并附验收口径。

## 9. 完成定义与相关文档

### 完成定义（IAM 整体）

当且仅当以下条件全部满足，IAM 方可视为完成：

1. 工作包 0–5 各自验收全部通过（§7）；
2. 用户可经 OIDC 登录获取 Access Token，所有客户端统一 Bearer 接入，无任何 Session Cookie 路径残留；
3. 业务系统经 API Key 获得 service identity 与 scope 授权；
4. 授权遵循最小权限与资源归属，越权一律拒绝并审计；
5. 凭证全部哈希存储、明文仅签发时展示一次，日志无密钥/正文泄漏；
6. 数据策略冻结：在保留真实数据的情况下无 destructive reset，正式 migration / 备份 / 回滚流程化。

### 相关文档

- 架构与核心数据流：[architecture.md](architecture.md)
- 数据库设计与 Schema Manifest 约束：[database-design.md](database-design.md)
- 当前接入控制（IP-RBAC）：[ip-rbac-design.md](ip-rbac-design.md)、[owner-transfer.md](owner-transfer.md)
- ADR 决策索引：[decisions/README.md](decisions/README.md)；当前 migration 门禁：[decisions/0002-canonical-baseline-and-migration-gate.md](decisions/0002-canonical-baseline-and-migration-gate.md)
- 本地 PostgreSQL 测试流程：[postgres-podman-test.md](postgres-podman-test.md)
- 平台需求基线：[../needs.md](../needs.md)
- 对外状态与限制：[../README.md](../README.md) / [../README.zh-CN.md](../README.zh-CN.md)
