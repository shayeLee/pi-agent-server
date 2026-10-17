# 配置与访问控制

## 访问控制

未设置 CIDR allowlist 时默认 `127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`；显式配置会完整替换默认列表，空白或非法配置拒绝启动。例如：

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8
```

身份即客户端 IP：默认取直接 TCP 对端 IP；当 TCP 对端为回环（`127.0.0.0/8` 或 `::1`，即同机反向代理，如 nginx 反代到 `127.0.0.1:8080`）时，改用 `X-Forwarded-For` 的**最右**一条（nginx 是追加语义，最右条目才是代理实际看到的地址）。XFF 缺失或不可解析时回落到 socket 对端 IP；非回环对端一律忽略 XFF。若真实用户经同机代理到达，允许网段必须覆盖用户所在内网，而不只是 `127.0.0.0/8`。详见 [docs/ip-rbac-design.md](ip-rbac-design.md) 与 [ADR 0003](decisions/0003-loopback-proxy-client-ip.md)。

可选的绝对路径 `PI_IP_ACCESS_POLICY_FILE` 能为精确 IP 定义：

- `role`：`viewer`、`user`、`operator` 或 `admin`；
- `disabled`；
- `tokenRequired` 与全局唯一的 `sha256:<64位小写hex>` token hash。

允许 CIDR 内未登记的 IP 使用 `role=user` 且关闭 token。Token 不能绕过 CIDR 准入、改变角色或跨 IP 使用。

## 环境变量

| 变量 | 当前默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 绑定地址 |
| `AGENT_CWD` | 服务启动时的工作目录 | 默认项目的工具工作目录；额外项目使用各自 cwd；离线 migration CLI 必须显式提供绝对路径 |
| `PI_AGENT_DIR` | `<DATA_DIR>/agent` | 服务模型资源目录（如 models.json）；不改变凭证或会话来源的默认路径 |
| `DATA_DIR` | `~/.pi` | 服务数据、旧布局 JSONL 与默认 SQLite 位置；不覆盖统一会话来源根 |
| `PI_SESSION_SOURCE_DIR` | CLI agent 目录 + `/sessions` | CLI/Web 新建私有 JSONL 的统一根；独立于 `DATA_DIR`/服务端 `PI_AGENT_DIR`；隔离存储须显式覆盖 |
| `PI_SESSION_SHARE_EXCLUDE_CWDS` | 未设置（共享所有符合条件的项目） | 逗号 split/trim/去空项；精确 canonical cwd 排除；无效目录 fail closed；修改后重启 |
| `DB_PATH` | `<PI_AGENT_DIR>/pi-agent-server.db` | SQLite 文件 |
| `PI_STORAGE_DIALECT` | `sqlite` | `sqlite` 或显式 `postgres` |
| `PI_DATABASE_URL` | 未设置 | PostgreSQL 必填 |
| `PI_ALLOWED_CLIENT_CIDRS` | `127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | 允许访问服务的来源 IP 网段，例如 `127.0.0.0/8` |
| `PI_IP_ACCESS_POLICY_FILE` | 未设置 | 可选策略文件的绝对路径，用于为指定 IP 设置角色、禁用状态和 token 要求 |
| `PI_AUTH_PATH` | `~/.pi/agent/auth.json` | 非开发环境应使用服务专用文件 |
| `PI_MODEL_PROVIDER` / `PI_MODEL_API_KEY` | 未设置 | 默认 provider 运行时凭证注入 |
| `PI_DEFAULT_MODEL` | 未设置 | `provider/modelId` |
| `PI_DEFAULT_THINKING_LEVEL` | Pi 默认值 | `off` 至 `max` |
| `PI_COMPANION_GREETING` | 开启 | 设为 `off` 时，空白会话的数字人不再调用默认模型写开场白，只用本地句子。开启时每个用户、项目和情境组合约 30 分钟最多调用一次 |
| `PI_SYSTEM_PROMPT` | Pi 默认提示词 | 可选的系统提示词整体覆盖；保留既有语义 |
| `PI_APPEND_SYSTEM` | 未设置 | 追加系统提示词原文，**不是路径**；空白不追加。先于文件原文和能力片段追加。修改后重启并新建会话；见 [SDK 提示词边界](pi-sdk-api.md#35-资源加载与系统提示词安全边界)。 |
| `PI_APPEND_SYSTEM_FILE` | 未设置 | 显式 UTF-8 文件，启动仅读一次；相对路径基于服务启动 cwd，不展开 `~`。无效文件拒绝启动。修改后重启并新建会话；冻结提示词不变。不自动发现 `APPEND_SYSTEM.md`。 |
| `TOOLS` | 允许全部工具 | 受信服务配置，不是会话输入。纯工具名形成完整白名单，包含扩展/插件工具。全 modifier `+name,-name` 按顺序调整 Pi 默认选择（`read,bash,edit,write`），再冻结为宿主白名单；例如 `-bash,+custom_tool` 保留 read/edit/write 并允许已注册的自定义工具。混合纯名/modifier 或 modifier 通配符拒绝启动。未设置/空白/仅逗号允许全部；程序化 `StartConfig.tools=[]` 禁用全部。 |
| `PI_PLUGINS` | 未设置 | 逗号分隔的显式加载、受信任同进程 ESM specifier；可以是包名，也可以是构建产物入口的绝对路径（裸机部署用后者，因为 `pnpm link` 在重建 `node_modules` 后不保留）；不扫描目录或 `.pi` |
| `PI_EXTENSION_PATHS` | 未设置 | 显式加载 Pi SDK 扩展的主变量，逗号分隔（绝对路径或 `~/…`）；不自动发现，无效路径或加载失败即拒绝启动。`PI_PROVIDER_EXTENSION_PATHS` 为已弃用兼容 alias：去除空白与空项后，仅旧变量得到非空列表时在路径校验前警告；两个变量都得到非空列表则拒绝启动 |
| `CORS_ORIGINS` | 空 | 允许在浏览器中调用本服务的网页地址；多个地址用逗号分隔，例如 `http://127.0.0.1:5173` |
| `PI_BACKUP_STAGING_ROOT` | 按平台的每用户私有目录：macOS `~/Library/Application Support/pi-agent-server-backup-staging`；Linux `$XDG_STATE_HOME/pi-agent-server/backup-staging`（未设置或为相对路径时用 `~/.local/state/pi-agent-server/backup-staging`）；Windows `%LOCALAPPDATA%\pi-agent-server\backup-staging` | 备份或数据库升级时存放明文的临时工作目录，完成后清空；通常无需设置 |
| `PI_RESTORE_NATIVE_SOURCE_ROOT` | `<target-root>/native-sessions` | 恢复备份时原生共享会话写入的目录；默认放在本次恢复目标内，不碰正在使用的会话目录。只有要直接恢复回某个会话目录时才需要设置 |

路径关系：未显式配置时，`DATA_DIR=~/.pi`，`DB_PATH=~/.pi/agent/pi-agent-server.db`，`PI_AGENT_DIR=~/.pi/agent`；`PI_AUTH_PATH` 仍为 `~/.pi/agent/auth.json`，会话来源仍为 `PI_CODING_AGENT_DIR/sessions`（未设置时 `~/.pi/agent/sessions`）。路径配置为空白时视为未设置；服务存储路径不展开字面量 `~` 或 `$HOME`，显式配置请填写绝对路径。

升级注意：原默认数据目录为 `~/.pi/agent`。`PI_AGENT_DIR` 原默认值为 `<DATA_DIR>/.pi-agent`，现为 `<DATA_DIR>/agent`。本次默认值变更不会搬移数据库或模型配置；保留旧模型资源目录请显式设置 `PI_AGENT_DIR`。自定义旧数据目录的部署应显式核对 `DATA_DIR`、`PI_AGENT_DIR` 和 `DB_PATH`；仅保留 `DATA_DIR` 不保证数据库路径不变，因为默认数据库现跟随 `PI_AGENT_DIR`。运行中的实例及显式路径配置不受源码默认值变更影响。

## Pi 扩展

可通过 `PI_EXTENSION_PATHS` 配置要加载的 Pi 扩展：

```bash
PI_EXTENSION_PATHS=/absolute/path/to/pi-extension
```

不设置时不加载扩展；路径校验与弃用变量见上表 `PI_EXTENSION_PATHS`。
