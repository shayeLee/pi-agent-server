# 精简用户登录设计

> 状态：三期已实现（2026-10-23，分支 `feat/login-phase1`）；本机 5180 部署的切换由用户按 §8 执行。2026-10-23 经 Astra 两轮审核：首轮 13 条意见已修订，§14 已按其意见定下；复审提出的 4 条（匿名静态资源通道、恢复时吊销 token、SSE 复核边界、`PI_PUBLIC_URL` 规则）与 scrypt 429 建议也已补入。关联：[小派管家设计](companion-butler.md) §0、[IP 访问控制](ip-rbac-design.md)、[已归档的 IAM 规划](archive/identity-access-plan.md)。

## 1. 目标

把身份从「来源 IP」换成「账号」，让同一个人从电脑、手机（局域网 IP）和 Claude Desktop 访问时是同一个主人，看到同一批会话，拥有同一个管家。

- 浏览器用账号密码登录，拿到 cookie。
- Claude Desktop bridge 和脚本用**个人 token**，映射到同一个账号。
- IP 白名单保留为第一道门；登录是第二道门。
- 账号和登录方式分开存，以后加谷歌等第三方登录只是多一种登录方式。

不做的事（第一版）：

- 不做公网 IAM：不做 OAuth 授权服务器、API Key 权限范围（scope）、审计日志、多租户。
- 不在 Web 上开放注册；账号只能由管理员用命令行创建。
- 不做第三方登录（只预留结构，见 §10）。
- 不做「忘记密码」流程；管理员用命令行重置。
- Web 上只做登录、登出、改密码；「已登录设备」和「个人 token」先只提供命令行，Web 界面以后再加。
- 仍然**禁止直接暴露到公网**。

## 2. 两种模式

新增 `PI_AUTH_MODE`：

| 值 | 行为 |
|---|---|
| `ip`（默认） | 与现在完全一致：身份 = 来源 IP，角色和 token 来自 IP 策略文件。**冻结**：只保留兼容，不再加功能；管家等账号相关能力只支持 `accounts`。 |
| `accounts` | 身份 = 账号；IP 策略文件只用于准入（网段、禁用），角色来自账号。 |

- 默认保持 `ip`，升级后不改配置的部署行为不变。切换到 `accounts` 前必须完成 §8 的切换流程。
- 两种模式不混用：`accounts` 模式下，IP 策略文件里出现 `role`、`tokenRequired`、`tokens` 任何一项都拒绝启动。这一检查在**解析原始 JSON 时**做：现有解析器会自动补出默认的 `role` / `tokenRequired`（`src/core/ip-access-policy.ts:313-365`），解析后再查就分不清是写了还是补的。
- 两种模式的差异只收在三处：配置解析、认证入口、身份派生。业务代码只认不透明的 owner key，不出现模式判断。
- `accounts` 模式下 **`PI_PUBLIC_URL` 必填**且必须是合法的 http/https URL，否则拒绝启动（`ip` 模式仍可不填，`src/server/start.ts:203`）。cookie 名、`Secure`、可信 origin 和 MCP 回调都依赖它。

## 3. 数据模型（迁移 v7）

SQLite 与 PostgreSQL 同时加四张表，按现有 `schema-manifest.ts` / `migration-manifest.ts` 流程（新 manifest 头、v7 定义、golden checksum、`db-schema.ts` 类型与兼容性检查），`dataTransform` 为 `none`（数据认领走 §8 的离线命令，不放进迁移）。

**accounts**：这个人是谁。

| 列 | 说明 |
|---|---|
| `id` | UUID，主键；owner key 用它派生，改名不影响归属 |
| `name` | 登录名，唯一，1–32 个字符，小写字母、数字、`-`、`_` |
| `role` | `admin` / `user` / `viewer` / `operator`，沿用现有角色 |
| `disabled` | 布尔 |
| `created_at` / `updated_at` | 毫秒时间戳 |

**login_methods**：怎么证明是他。

| 列 | 说明 |
|---|---|
| `id` | UUID，主键 |
| `account_id` | 外键 → accounts |
| `kind` | 第一版只有 `password`；以后 `oidc` |
| `issuer` | `password` 为空串；`oidc` 为发行方，如 `https://accounts.google.com` |
| `subject` | `password` 为账号 id；`oidc` 为发行方给的用户编号 |
| `secret` | `password` 为 scrypt 哈希串（含参数与盐）；`oidc` 为空 |
| `created_at` / `last_used_at` | |

唯一约束 `(kind, issuer, subject)`；每个账号最多一个 `password` 方式。

**auth_sessions**：浏览器的登录状态。

| 列 | 说明 |
|---|---|
| `id` | UUID，主键（供「踢掉某台设备」引用） |
| `token_hash` | cookie 值的 SHA-256，唯一；明文只在 cookie 里 |
| `account_id` | 外键 |
| `created_at` / `last_seen_at` / `expires_at` | |
| `label` | 登录时的浏览器简述（User-Agent 截短） |

**api_tokens**：个人 token。

| 列 | 说明 |
|---|---|
| `id` | UUID |
| `account_id` | 外键 |
| `name` | 用途，如 `claude-desktop` |
| `token_hash` | SHA-256，唯一；明文只在创建时显示一次 |
| `prefix` | 明文前 8 位，用于在列表里认出是哪一个 |
| `created_at` / `last_used_at` / `revoked_at` | |

**owner key**：`user:<account id>`。五张授权归属表（`projects`、`sessions`、`uploaded_files`、`companion_personas`、`user_mcp_credentials`）照旧存字符串，只是派生规则变了；隔离查询（`listByOwner` 等）不变。另有两处存 owner 但**不是授权归属**，见 §8。

## 4. 请求如何通过认证（`accounts` 模式）

```
请求 → ① IP 准入：网段 / 禁用（不变）
     → ② 合法 CORS 预检，或精确的公共路由 → 放行（不伪造账号，不设角色）
     → ③ 认证：有 Authorization: Bearer → 查 api_tokens
              否则有登录 cookie → 查 auth_sessions
              都没有或无效 → 401
     → ④ cookie 认证的写请求 → CSRF 检查（§5）
     → ⑤ request.user = { kind: "account", accountId }，request.access.role = 账号角色
     → ⑥ 现有 RBAC 矩阵（不改）
```

- **公共路由**是一张精确列表，不按前缀放行：`/health`、`/readyz`、`GET /v1/auth/state`、`POST /v1/auth/login`，以及现有那条只含组件库公开字节的 ONEV `runtime.js` / `runtime.css` 内容寻址 GET（`src/server/network-admission.ts:65`）。
  - 前四条在 RBAC 里新增「公共」权限，对未认证请求放行。现有 `probe:health` / `probe:readyz` 本来就对所有已准入角色开放，改为公共即可；**`/metrics` 不公开**，`probe:metrics` 仍只给 admin / operator（`src/server/route-rbac.ts:90-94`），账号模式下要登录。RBAC 对其他路由缺失角色照旧拒绝（`src/server/route-rbac.ts:258-268`）。
  - ONEV 静态资源**不能走现有插件路由包装器**：包装器一进来就执行 `identityKey(request.user)` 并创建绑定 owner 的 session API（`src/server/plugin-host.ts:480-487`），没有身份会直接失败，也不应为它虚构一个 owner。改为插件宿主提供一条单独的「公开静态资源」通道：只匹配这条精确路径，不需要身份，不创建 session API，只返回内容寻址的字节。其他插件路由保持现有认证契约。
- `onRequest` 钩子本来就是 async（`src/server/app.ts:580`），要改的是其中同步的 `admission(request)`：拆成同步的「IP 准入」和异步的「账号认证」两步。还要接通 `main.ts` / `start.ts` 的配置、`ServerDeps`、`AccessProfile` 类型。
- **不做认证结果缓存**：每个请求都按主键 / 唯一索引查一次库（SQLite 本地查询，开销很小），这样命令行在另一个进程里做的改动，下一个请求就能看到。
- **已建立的 SSE**：账号认证的 SSE 连接每 30 秒复核一次。
  - 复核内容与新请求的认证相同：凭证仍有效（未登出、未过期、未吊销）、账号未禁用、**最新角色**仍有 `sessions:events` 权限。
  - 复核是异步的、不重叠：上一次没结束就不发起下一次；连接关闭时清掉定时器。
  - 单次复核有自己的上限（5 秒）；查库失败或超时按失效处理，关闭连接，不继续无限输出。
  - 失效时尽力发送一条 `auth_expired` 事件后关闭连接。断网或背压时客户端可能收不到，客户端仍以连接断开加下一次请求的 401 为准。
  - **认证关闭只关闭这条连接，不中止 Agent 任务**。现有「不允许输出」分支会调用 `runtime.abort()`（`src/server/app.ts:1483-1487`），认证失效不能复用这条路径，要走单独的关闭逻辑。
  - 所以「失效」的准确含义是：新请求立即生效；已连着的 SSE 在下一次复核时断开，即最长 30 秒检查间隔加上最多 5 秒查询时间。
- 失效对正在跑的任务的影响：禁用账号、登出、吊销 token **不会中止**已经在跑的 Agent 任务，只是不能再发新请求、看不到后续输出；需要中止时由管理员先中止再禁用。
- 401 响应不区分「没登录」「过期」「禁用」，统一为 `auth_required`。
- `request.subjectHash`、日志脱敏沿用现有派生方式（基于 `identityKey`）。

## 5. Cookie、token 与 CSRF

**登录 cookie**

- 名称带端口：`pi_session_<有效端口>`（如 `pi_session_5180`）。cookie 不按端口隔离，本机 dev（5173）和正式（5180）同在 `127.0.0.1`，同名会互相覆盖登录状态。
  - 有效端口取 `PI_PUBLIC_URL` 的端口；URL 用的是默认端口时，标准解析得到的是空串（`new URL("https://h:443").port === ""`），此时按协议补：https 为 `443`，http 为 `80`。
- 值为随机 32 字节（base64url）；服务端只存 SHA-256，不需要签名密钥。
- 属性：`HttpOnly`、`SameSite=Lax`、`Path=/`、不设 `Domain`（只对当前主机名有效）、`Max-Age` = 剩余绝对期限；`PI_PUBLIC_URL` 是 https 时加 `Secure`。清除时用同名同路径、`Max-Age=0`。
- 有效期：30 天绝对期限；14 天没有任何请求即失效；`last_seen_at` 每天最多刷新一次，所以闲置判定有最多约一天的误差，可以接受。
- 登出删除当前这一条；改密码删除该账号所有登录状态，当前这条重新签发。
- **按主机名区分**：从 `192.168.5.137` 登录和从 `127.0.0.1` 登录是两份 cookie，互不相通。

**个人 token**

- 格式 `pi_` + 32 随机字节（base64url）；服务端只存 SHA-256；明文只在创建时输出一次。
- bridge 照旧从 `PI_BRIDGE_TOKEN_FILE` 读取，文件要求 `0600`；bridge 只在启动时读文件（`src/claude-bridge/config.ts:25-36`），换 token 后要重启 Claude Desktop 的连接器。

**响应头**：`/v1/auth/*` 的响应一律 `Cache-Control: no-store`。

**CSRF**（只针对 cookie 认证的 `POST/PUT/PATCH/DELETE`，以及登录接口本身）

1. 请求带 `Origin`：必须**精确**等于可信 origin 之一，否则 403。
2. 请求不带 `Origin`：才允许用 `Sec-Fetch-Site: same-origin` 判定；两者都没有则 403。回退不能覆盖错误的 Origin。
3. `Origin: null` 一律拒绝。

- 可信 origin 来自新配置 `PI_TRUSTED_ORIGINS`（逗号分隔的完整 origin，不接受 `*`，不能带路径）。它**独立于** `CORS_ORIGINS`：CORS 可以配成 `*`，但那不能变成 CSRF 白名单。
  - **公共 origin**：从 `PI_PUBLIC_URL` 取 `scheme://host[:port]` 并规范化（默认端口省略）。`PI_PUBLIC_URL` 允许带路径（`src/mcp/oauth-connections.ts:34-41`），比较时只用 origin，不用完整 URL。
  - 未设置 `PI_TRUSTED_ORIGINS` 时，可信列表只有公共 origin。
  - 设置时**替换**默认值，但必须包含公共 origin，否则拒绝启动。
- 说明：CORS 限制的是「能否读取响应」，不阻止跨站页面发出带 cookie 的简单请求，所以 CSRF 必须单独检查。
- 开发环境：Vite 代理的 `changeOrigin: true` 改的是转发请求的 Host，不改 Origin（`web/vite.config.ts:27-30`），浏览器发来的 Origin 仍是页面地址 `http://127.0.0.1:5173`，dev 后端要把它放进 `PI_TRUSTED_ORIGINS`。检查只比较 Origin 与配置，不与代理后的 Host 比较。
- 手机访问的地址（如 `http://192.168.5.137:5180`）也要列入，验收时分别从电脑、手机、dev 页面各测一次。
- Bearer 请求不做 CSRF 检查（浏览器不会自动带上 Authorization）。

## 6. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/auth/state` | 公共：`{ mode: "ip" }` 或 `{ mode: "accounts", publicOrigin }`。Web 用 `mode` 决定是否显示登录页，用 `publicOrigin`（§5 规范化后的公共 origin）检查当前页面是不是统一入口（§9.1） |
| `POST` | `/v1/auth/login` | 公共：`{ name, password }` → 设置 cookie，返回 `{ account }`；失败统一 `401 invalid_credentials` |
| `POST` | `/v1/auth/logout` | 删除当前登录状态并清 cookie |
| `GET` | `/v1/auth/me` | `{ account: { id, name, role }, via: "cookie" \| "token" }` |
| `PUT` | `/v1/auth/password` | `{ current, next }`；只允许 cookie 认证 |

- 这些接口在 `ip` 模式下返回 `404 auth_not_enabled`（`/v1/auth/state` 除外）。
- 已登录设备、个人 token 的列表与管理第一版只走命令行（§7）；接口以后随 Web 界面一起加。

**登录的资源上限**

- 请求体上限 4 KiB（全局默认 bodyLimit 很大，`src/server/app.ts:477`，登录路由单独收紧）；密码长度 12–256 个字符。
- 用异步 scrypt（N=2^15, r=8, p=1, 16 字节盐），显式设置 `maxmem: 64 MiB`。实测这组参数在 Node 默认内存上限下直接报错，必须显式设置。
- 同时进行的 scrypt 计算最多 2 个，超出直接返回 `429`，不排队。
  - 这种「忙不过来」的 429 带 `Retry-After: 1`，**不计入**失败次数（它不是密码错误）；Web 收到后提示「稍后重试」。
  - 限速退避产生的 429 也带 `Retry-After`，值为距下次允许的秒数。
- 账号不存在、已禁用、没有密码方式、密码错误：都做一次同等成本的 scrypt，返回同样的错误，计入同样的失败次数，避免靠响应时间或 429 猜出账号状态。

**限速**

- 键：准入解析出的客户端 IP，以及登录名；两者分别计数。
- 连续失败后指数退避（1 秒起，最长 5 分钟）：记录「下次允许的时间」，期间的请求立即 `429`，不让请求在服务端睡眠堆积。
- 内存记录，最多 1000 条、30 分钟无活动淘汰，重启清零。成功登录清除该键。

## 7. 管理命令

第一版账号管理只走命令行（与 `migrate`、`backup`、`owner-transfer` 同样是独立入口），服务运行时也可以执行：

```bash
pnpm accounts -- create --name mz --role admin        # 交互输入密码
pnpm accounts -- set-password --name mz               # 同时清掉该账号所有登录状态
pnpm accounts -- set-role --name mz --role user
pnpm accounts -- disable --name mz                    # 同时清掉登录状态，吊销全部 token
pnpm accounts -- list
pnpm accounts -- sessions --name mz                   # 已登录设备
pnpm accounts -- kick --session <id>
pnpm accounts -- issue-token --name mz --label claude-desktop   # 打印一次明文
pnpm accounts -- tokens --name mz
pnpm accounts -- revoke-token --id <id>
pnpm accounts -- claim --from ip:127.0.0.1 --name mz --dry-run                    # 预演，见 §8
pnpm accounts -- claim --from ip:127.0.0.1 --name mz --maintenance-window CONFIRMED # 停服后执行
```

- 生效时机统一：服务**下一个请求**就按新状态处理（§4 不缓存）；已连着的 SSE 最长 30 秒内断开；在跑的任务不中止。降权（`set-role`）同样适用。
- 密码只从交互输入或 stdin 读取，不接受命令行参数（避免进 shell 历史）。

## 8. 从 IP 身份切换到账号

现有数据都归 `ip:127.0.0.1`。按顺序执行：

1. **停服**。
2. **加密备份**：按 `~/pi-agent-server-backups/README.md` 的流程。注意 MCP 凭证的加密密钥（`PI_MCP_TOKEN_KEY_FILE`）不在备份包里（`docs/backup-restore.md:308`），确认它也有副本。
3. **迁移**：`pnpm migrate` apply 到 v7 并 verify。服务启动时不会自动建表（`src/server/start.ts:683-689`），这一步不能省。
4. **建账号**：`pnpm accounts -- create --name mz --role admin`。
5. **预演**：`pnpm accounts -- claim --from ip:127.0.0.1 --name mz --dry-run`，它会：
   - 直接读取五张表的原始行，不用会把解密失败当作「不存在」的 repository（`src/storage/kysely-mcp-oauth-repository.ts:81-110`）。
   - 检查 `PI_MCP_TOKEN_KEY_FILE` 是否就是加密这些凭证的那把密钥，逐行试解密，列出解不开的行。
   - 检查目标 owner 下所有可能冲突的**唯一约束**，不只是主键：`companion_personas` 主键、`user_mcp_credentials` 主键 `(owner_key, server_name)`、`uploaded_files` 的 `(owner_key, project_id, upload_key)`（`src/storage/schema-manifest.ts:513-516`）。
   - 检查归属一致性：要迁移的会话、上传所属的项目，要么同样归源 owner，要么归系统（owner 为空串，例如默认项目）；在第三个 owner 的项目里就拒绝。
   - 打印每张表要改多少行。
6. **执行**：去掉 `--dry-run`，加 `--maintenance-window CONFIRMED`（确认已停服；两个参数必须二选一）。在一个事务里重做第 5 步的全部检查，然后：
   - 把五张表中 `owner_key = 'ip:127.0.0.1'` 的行改为 `user:<id>`。只改**精确等于**源 owner 的行；默认项目和 native 会话（owner 为空串）不动。
   - `user_mcp_credentials` 的密文以 owner 作附加数据（AAD，`src/mcp/token-cipher.ts:3`），用同一把密钥解密后按新 owner 重新加密。
   - **任何一行解密失败，整个事务回滚**。只有显式加上 `--drop-unreadable-credentials`，才允许删除解不开的行，并列出需要重新授权的 MCP server。
   - 任何唯一约束冲突都回滚，不做隐式合并。
   - 提交前核对各表改动行数与预演一致。
   - 输出旧 → 新 owner 映射，供插件迁移自己的数据（见下文）。
7. **改配置**：`PI_AUTH_MODE=accounts`；IP 策略里删掉 `role`、`tokenRequired`、`tokens`；配置 `PI_TRUSTED_ORIGINS`；bridge 的 `PI_BRIDGE_TOKEN_FILE` 换成 `issue-token` 发出的个人 token。
8. **启动**，各个浏览器**刷新页面并重新登录**。Web 在发现身份变化（`/v1/auth/me` 的账号与上次不同，或从 `ip` 模式切到 `accounts`）时，丢弃旧身份下待重试的会话创建（`web/src/hooks/useWebAppController.ts:649,682,801`）：会话创建的幂等 ID 由 owner 派生（`creationSessionId`，`src/server/app.ts:447-453`），旧请求换了 owner 再重试会建出重复会话。

**存 owner 但不迁移的地方**

- `project_mcp_servers.updated_by`：记录「谁改的」，不是授权归属，保留旧值作为历史（`src/server/app.ts:1016`）。
- native 会话消息的幂等指纹包含调用者 owner（`src/application/session-service.ts:605-606`）：切换前发出、切换后用同一 requestId 重试的 native 消息会被判为冲突。停服切换时基本不会遇到，接受。

**切换后的预期变化**

- 运行和排队的并发配额按身份累计（`src/runtime/session-runtime.ts:682`、`src/core/concurrency-control.ts:28-40`）：电脑、手机、bridge 合并成一个账号后，共用一份额度。这是预期行为。
- 进行中的 MCP OAuth 授权和模型登录（内存记录，按 owner 校验）在重启时本来就会丢失。

**插件**：插件契约允许插件用 `context.ownerKey` 关联自己的数据（`src/plugin/contract.ts:145-147`）。宿主不迁移插件的数据；切换前逐个检查已装插件是否存了 owner，按 `claim` 输出的映射自行迁移，或确认不支持。`ownerKey` 本来就是不透明字符串，格式变化不需要升级插件接口版本。

**从备份恢复**：恢复会把 `auth_sessions` 和 `api_tokens` 恢复成备份时的样子。恢复出来的数据库不知道哪些登录和 token 是在备份之后才登出或吊销的，只提示确认挡不住它们重新生效。所以：

- 恢复时**默认清空 `auth_sessions`**（所有人重新登录），并**吊销恢复出来的全部个人 token**（写入 `revoked_at`），之后用 `pnpm accounts -- issue-token` 重新签发，bridge 换上新 token。
- 这一步放在恢复流程内部、**发布恢复结果之前**完成：SQLite 在最后一次 rename 发布之前（`src/backup/restore-core.ts:949-979`），PostgreSQL 在恢复重映射事务的 COMMIT 之前（`src/backup/postgres-restore-core.ts:991-1058`）。这一步失败，整个恢复失败，不报告成功。
- 不放在服务启动路径里，否则每次重启都会把所有人踢下线。
- v7 之前的备份没有这两张表，跳过这一步。
- 恢复的 dry-run 只报告「将清空 N 条登录状态、吊销 M 个 token」（报告的 `counts.authSessionsCleared`、`counts.apiTokensRevoked`），不修改恢复目标。PostgreSQL 的 dry-run 不执行 `pg_restore`，这两项报 0；SQLite 的 dry-run 在临时副本上算出实际条数。

`owner-transfer` 工具只处理 `projects` 与 `sessions`、且只认 IP，不复用它的转移范围；它的安全校验做法（备份、身份绑定、校验）可以参考（`src/owner-transfer/owner-transfer-core.ts:233-285`）。

## 9. 各处的配套改动

| 位置 | 改动 |
|---|---|
| `src/core/user-identity.ts` | `UserIdentity` 增加 `{ kind: "account"; accountId }`，`identityKey` 产出 `user:<id>`；文件头「一个 IP = 一个用户」的冻结说明改为按模式描述 |
| `src/core/ip-access-policy.ts` | 账号模式下在原始 JSON 层拒绝 `role` / `tokenRequired` / `tokens` |
| `src/server/network-admission.ts`、`app.ts` | 准入拆成同步 IP 准入与异步账号认证；公共路由精确列表；CSRF；SSE 定时复核凭证，认证失效走单独的关闭逻辑（不调用 `runtime.abort()`） |
| `src/server/route-rbac.ts` | 现有矩阵不变；新增「公共」权限，用于 `/health`、`/readyz`、`/v1/auth/state`、`/v1/auth/login`；其余 `/v1/auth/*` 为所有已登录角色；`probe:metrics` 不变 |
| `src/server/plugin-host.ts` | 新增「公开静态资源」通道：精确匹配 ONEV 内容寻址 runtime 资源，不需要身份、不创建 session API；其他插件路由不变。注释更新：`context.ownerKey` 来自身份，格式随模式变化 |
| `src/backup/restore-core.ts`、`postgres-restore-core.ts` | 发布恢复结果前清空 `auth_sessions`、吊销恢复出的 `api_tokens`；v7 之前的备份跳过 |
| `src/server/start.ts`、`src/main.ts` | 账号模式下 `PI_PUBLIC_URL` 必填；计算公共 origin、有效端口与 cookie 名；解析 `PI_TRUSTED_ORIGINS` |
| `src/client/sse-client.ts` | 区分「认证失效」与普通错误：收到 401 或 `auth_expired` 时返回可识别的结果并**停止重连**（现在任何错误都会一直重连，`src/client/sse-client.ts:54-59,179-188`） |
| `web/` | 启动先读 `/v1/auth/state`；账号模式下 `/v1/auth/me` 401 显示登录页；任何请求或 SSE 认证失效都进入登录态。登出或换账号时清掉旧账号的会话缓存、事件游标、上传引用和待重试请求；输入框草稿按账号 id 分开存，不会恢复给另一个账号。设置里加「登出」「改密码」 |
| ops-viewer（`src/ops-viewer/data.ts`、`server.ts`、`web/ops-viewer/main.tsx`） | 全链路从「按 IP」改为「按 owner」：数据层去掉 `LIKE 'ip:%'`、`slice(3)`、`ip:${ip}` 重建；接口 `/api/ips`、`?ip=` 改为 `/api/owners`、`?owner=`；前端类型与文案改为不透明的 owner id 加显示名（账号模式显示账号名）。仍然是独立、只限本机的运维工具 |
| `src/claude-bridge` | 不改代码；文档改写「bridge 与 Web 共用 127.0.0.1 身份」一段 |
| 本机部署 `.pi/local-deploy/start.mjs` | 想让手机直连时：5180 改为监听局域网地址，转发时把真实客户端 IP 写进 `X-Forwarded-For`（现在强制写成 127.0.0.1），`PI_ALLOWED_CLIENT_CIDRS` 加入 `192.168.5.0/24`，`PI_PUBLIC_URL` 设为大家共用的那个地址（见 §9.1）。这是部署文件，不进仓库 |

### 9.1 MCP OAuth 回调与统一入口

- 回调地址与授权完成后的返回地址都由 `PI_PUBLIC_URL` 构造（`src/mcp/oauth-connections.ts:106-109`），pending state 照旧校验 owner（`:177-182`），state 与 PKCE 校验不变。
- 回调不再免认证，靠登录 cookie 确认是发起授权的同一个人。因为 cookie 按主机名区分，**发起授权的浏览器必须已在 `PI_PUBLIC_URL` 那个主机上登录**。例如在 `192.168.5.137` 登录、回调却回到 `127.0.0.1`，就没有 cookie；手机上访问 `127.0.0.1` 更是指向手机自己。
- 所以账号模式下建议**所有设备都用同一个地址**访问，就是 `PI_PUBLIC_URL`（局域网时用 `http://192.168.5.137:5180`，电脑也用这个；有 HTTPS 域名后用域名）。Web 在发起授权前，用 `/v1/auth/state` 返回的 `publicOrigin` 与当前页面的 `location.origin` 比较（两边都只比 origin，不比路径），不等时提示先切到那个地址登录。
- 用个人 token 发起授权不支持：回调是浏览器整页跳转，带不上 token。
- 验收：从不同入口发起、授权途中登录过期、回调时登录的是另一个账号，三种情况都要失败得清楚。

## 10. 以后加谷歌登录

结构已就位，加谷歌只需：

1. `login_methods` 新增 `kind = "oidc"`、`issuer = https://accounts.google.com`、`subject = 谷歌用户编号` 的行。
2. 新增 `/v1/auth/oidc/google/start` 与回调：标准授权码 + PKCE，校验 `id_token` 的签名、`iss`、`aud`、`nonce`、过期时间。
3. **不开放注册**：只有已绑定的谷歌账号能登录；绑定由已登录用户在设置里发起。
4. 前提：谷歌只接受 `http://localhost` 或 HTTPS 域名的回调地址，不接受局域网 IP。手机要用谷歌登录，需要先给服务配 HTTPS 域名（建议 Tailscale 的 `*.ts.net`）。

## 11. 安全说明

- **局域网走 HTTP 是用户明确接受风险的选项，不是推荐做法。** 风险不只是被偷看：
  - 同一网络里的人能截获密码、登录 cookie 和个人 token，这些凭证长期有效。
  - 主动的中间人还能**篡改页面**，借你已登录的身份给 Agent 发指令，而 Agent 能读写服务器上的文件、执行命令。
  - IP 白名单、`HttpOnly`、`SameSite`、CORS 都挡不住局域网中间人。
- **推荐**：给服务配一个 HTTPS 私网入口（如 Tailscale 的 `*.ts.net` 证书），所有设备都走它；它同时解决在外访问和谷歌登录的回调要求。
- 用 HTTP 时，至少只在自己信任的家庭网络里用，不在公共 Wi-Fi 下用；怀疑泄露时用命令行吊销 token、改密码。
- IP 准入仍是第一道门，账号模式下不要把网段放得比需要的更宽。
- 登录不是沙箱：Agent 的文件与命令权限仍由运行服务的系统账号决定（同 IP-RBAC）。

## 12. 取代的既有约束

账号模式下，下列说法不再成立，实施时同步改文档与代码注释：

- `docs/ip-rbac-design.md`：「服务按客户端 IP 识别用户」「同一 IP 共用一个身份」「token 不会改变 IP 的角色」——账号模式下身份与角色来自账号；该文档改为只描述 `ip` 模式与两种模式共用的准入。
- `src/core/user-identity.ts`、`src/server/network-admission.ts` 文件头的「身份 = canonical IP；token 不改变身份」。
- `docs/archive/identity-access-plan.md` 的「只用 Bearer、不使用 Session Cookie」「不提供本地密码」「users 表不存密码」：那是公网方案的取舍；本设计面向本机 / 局域网个人服务器，浏览器用 cookie 更简单，密码哈希放在独立的 `login_methods` 里。该文档保持归档，不再作为约束。
- `docs/claude-desktop-bridge.md`：「两个后端都把 127.0.0.1 映射为 admin、bridge 与 Web 共用身份」——账号模式下改为个人 token。

## 13. 分期与验收

| 期 | 内容 |
|---|---|
| 一 | 迁移 v7；`accounts` 命令行；账号模式的认证（cookie、token、CSRF、登录资源上限与限速、SSE 复核）；`/v1/auth/*` 接口；SSE 客户端识别认证失效。默认 `ip` 模式不变 |
| 二 | Web 登录页、登出、改密码；401 处理与按账号清理状态 |
| 三 | `claim` 命令、备份恢复后的登录状态处理、ops-viewer、文档改写；本机部署切换 |

**测试矩阵**（不做全量笛卡尔积，但下列每项都要有；现有 `ip` 模式的测试继续通过，不代表账号模式已被验证）：

- 迁移 v7 与 `claim`：SQLite、PostgreSQL 各一遍，包括解密失败回滚、`--drop-unreadable-credentials`、唯一约束冲突回滚、默认项目与 native 记录不被改动。
- 准入：两种模式 × 四个角色 × cookie / Bearer / 无凭证；合法 CORS 预检；每条公共路由；`/metrics` 未登录被拒；账号模式下策略文件含 `role` 时、`PI_PUBLIC_URL` 缺失或 `PI_TRUSTED_ORIGINS` 不含公共 origin 时拒绝启动。
- 公开静态资源：未登录请求经过**真实的插件宿主通道**拿到 ONEV runtime 资源（不只测准入放行）；同一插件的其他路由未登录仍 401。
- 配置：`PI_PUBLIC_URL` 用默认端口（`https://h`、`http://h`）与显式端口时的 cookie 名；带路径的 `PI_PUBLIC_URL` 得到正确的公共 origin。
- 恢复：SQLite、PostgreSQL 各恢复一个 v7 备份，恢复后旧 cookie 与旧 token 都是 401；恢复 v7 之前的备份正常完成；dry-run 不改目标。
- CSRF：Origin 精确命中、错误 Origin、`Origin: null`、无 Origin 加 `Sec-Fetch-Site`、两者都无；dev 代理页面、电脑、手机三个入口。
- 失效：命令行在服务运行时禁用账号、降权、踢设备、吊销 token、改密码，下一个请求即生效；已连着的 SSE 在下一次复核时断开（检查间隔与复核超时在测试里可调小）；复核查库失败时连接关闭；**在跑的任务不被中止**。
- 登录：限速与退避（带 `Retry-After`）、并发 scrypt 超限 429 带 `Retry-After` 且不计入失败次数、不存在 / 禁用 / 错密码的响应一致。
- MCP OAuth：§9.1 的三种失败情况和正常完成。
- Web E2E：登录、刷新保持、登出、401 回登录页、换账号不恢复上一个账号的草稿与缓存。

## 14. 已定（原待定项）

1. **未登录一律 401**，不保留「未登录只读」；只有 §4 的精确公共路由例外。个人服务器不需要匿名访问，也省掉匿名权限分支。
2. **登录有效期 30 天绝对、14 天闲置**；`last_seen_at` 每天刷新一次带来的约一天误差可以接受。HTTP 环境下延长有效期并不会更安全。
3. **`ip` 模式长期保留但冻结**：只做兼容，不再加功能；账号相关能力（包括管家）只支持 `accounts` 模式，测试不能只走 `ip` 模式。
