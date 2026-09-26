# 运维任务索引

本文是运维的**唯一总入口**：首次生产部署按下方[通用首次生产部署](#通用首次生产部署)完整流程执行；首次数据库初始化、离线工具和运行时探针见本文对应章节。数据库初始化与升级按本文对应章节执行；服务启动不会自动迁移数据库。备份、恢复及其长期运维边界见 [backup-restore.md](backup-restore.md)，本文不重复其内容。

`pi-agent-server` 在前台运行正式服务；进程守护和重启由 systemd 负责。

## 通用首次生产部署

本节是**首次部署到全新 Linux 主机**的完整流程，默认：Node.js 22.22.3 及以上版本与 pnpm 已由运维安装；服务账号 `agent-server`；源码目录 `/srv/pi-agent-server`；数据目录 `/var/lib/pi-agent-server`；SQLite 单实例；systemd 守护。账号和路径使用下文给出的示例值；仓库地址、发布版本、用户网段和模型标识需按实际环境填写。模型凭据的存放位置、文件所属用户和访问权限见第 5 步。

> 范围与状态：本流程面向**受控内网**的单实例部署。项目当前为 RC（见根 README「Status」），本节描述可执行的部署步骤，不宣称生产就绪。公网暴露禁止：IP-RBAC 只是访问准入，**不是**文件系统/工具沙箱。

### 0. 前置条件（运维已提供）

- Linux 主机，`systemd` 可用；`/srv`、`/var/lib` 在持久、可备份的磁盘上。
- Node.js **22.19.0 及以上版本**，并已安装 pnpm（不限定具体版本或管理器）。
- 已提供供服务账号执行的 Node.js 二进制绝对路径（版本不低于 22.22.3）；该路径对服务账号可穿越且可执行，避免运行时位于 root 私有目录。不要为了共享 Node 放宽整个 `/root` 的权限；在 §6 检查服务账号确实可执行。
- 确认哪些电脑可以访问服务，并准备它们的 IP 地址范围，用于第 4 步的 `PI_ALLOWED_CLIENT_CIDRS`。例如 `192.168.10.0/24` 表示允许 `192.168.10.*` 网段；这是格式示例，部署时要换成实际网段。若需要给某台电脑单独设置管理员或只读权限，再创建 `/etc/pi-agent-server/ip-access-policy.json`，并在第 4 步的环境文件中设置 `PI_IP_ACCESS_POLICY_FILE=/etc/pi-agent-server/ip-access-policy.json`；不需要单独设置权限时，可不创建该文件，也不设置这个变量。
- 确认服务要使用的模型提供方和模型名称，在第 4 步填写 `PI_DEFAULT_MODEL=提供方标识/模型标识`。具体标识由模型配置人员提供，必须与实际配置一致；模型访问凭据按第 5 步准备。
- 备份/加密（age）如未配置：最小路径只要求 `pnpm build` + `pnpm build:migrate`；`pnpm build:backup`（`dist-backup`：backup/restore）仅在启用加密备份时需要构建。备份边界见 [backup-restore.md](backup-restore.md)。

### 1. 服务账号与目录

除明确注明外，本节至 §8 的系统配置命令均以 `root` 执行（`useradd`/`install`/`runuser`/`systemctl` 需要 root）；§2–3 同样以 root 执行，确保能写入 root 所有的源码目录；服务账号不参与构建。

```bash
# 服务账号（系统账号、无登录 shell、同名用户组）
useradd --system --user-group --create-home --home-dir /var/lib/pi-agent-server \
  --shell /usr/sbin/nologin agent-server

# 源码目录（root 拥有，agent-server 只读）
install -d -o root -g root -m 0755 /srv/pi-agent-server

# 数据目录（即服务账号 HOME）：访问权限必须为 0700，所属用户必须是服务账号
# （useradd --create-home 可能建出非 0700 的 HOME，故再显式收紧；只针对该目录，非递归）
install -d -o agent-server -g agent-server -m 0700 /var/lib/pi-agent-server
chmod 0700 /var/lib/pi-agent-server
# 独立可写工作目录：工具的 cwd，绝不能指向源码仓
install -d -o agent-server -g agent-server -m 0750 /var/lib/pi-agent-server/workspace
# systemd 临时目录
install -d -o agent-server -g agent-server -m 0700 /var/lib/pi-agent-server/tmp
# 配置文件目录（root:agent-server）
install -d -o root -g agent-server -m 0750 /etc/pi-agent-server
```

- 权限只精确设置目录/文件，**不要** `chmod -R`：递归修改会破坏数据目录、会话文件与 staging 的既有权限（backup 对 staging 与白名单有严格的权限/symlink 校验）。
- 数据目录由 `agent-server` 拥有；源码目录保持 root 拥有、服务账号只读，避免 Agent 工具改写生产代码。

### 2. 获取源码并固定版本

```bash
git clone <repository-url> /srv/pi-agent-server   # <repository-url> 只可替换为实际远端
cd /srv/pi-agent-server
git checkout <release-tag-or-commit>
git status --short                                 # 应为空
```

`<repository-url>`、`<release-tag-or-commit>` 是占位符；不要写死或提交任何私有远端/凭据。

### 3. 安装依赖并构建

以 root 执行，避免普通账号无法写入 `/srv/pi-agent-server`；构建产物归 root，服务账号只读。构建环境需设置可读的文件权限：

```bash
cd /srv/pi-agent-server
umask 022
# 仓库当前未跟踪 pnpm-lock.yaml。若发布方提供受控锁文件，应先放入本目录并用 --frozen-lockfile。
# 无锁文件的首次解析不能宣称可重复构建；必须保存本次生成的锁文件和依赖清单随发布归档。
pnpm install
pnpm build          # dist/main.js（服务入口）
pnpm build:migrate  # dist-migrate/scripts/migrate.js（离线 migration 入口）
# 仅在启用加密备份时需要：
# pnpm build:backup
```

- `pnpm build` 产出 `dist/main.js`（`package.json` 的 `bin.pi-agent-server`）；`pnpm build:migrate` 产出 `dist-migrate/scripts/migrate.js`（`bin.pi-agent-server-migrate`）。服务入口与离线 migration 入口是**两个独立编译产物**。
- 构建末尾会跑 smoke：`pnpm build`（含 `build:drill`）与 `pnpm build:migrate` 的安装包 smoke 都会 `npm pack`/`npm install` 本地 tarball（临时空 npm cache，需能访问 npm registry 或已配置镜像）；`pnpm build:migrate` 还需 PATH 中有 `age` / `age-keygen`（如 `apt-get install -y age`）。drill 的编译 smoke 使用 fixture，不需要 podman。若宿主无网络或不准备安装 age，须在与目标兼容的构建环境产出完整发布目录：至少包含 `package.json`、`dist/`、`dist-migrate/` 以及可解析的生产依赖（`node_modules` 及其实际依赖目标）。不能只复制两个 `dist` 目录；发布目录必须经过服务账号的入口加载验证。
- 发布产物目录（`dist*`）不提交仓库（`.gitignore` 已忽略）。

### 4. 生产环境文件 `/etc/pi-agent-server/server.env`

```bash
install -o root -g agent-server -m 0640 /dev/null /etc/pi-agent-server/server.env
```

内容（systemd `EnvironmentFile` 语法，`KEY=value`；不含任何 secret 真实值）：

```ini
# /etc/pi-agent-server/server.env — root:agent-server 0640
HOST=127.0.0.1
PORT=8080
AGENT_CWD=/var/lib/pi-agent-server/workspace
DATA_DIR=/var/lib/pi-agent-server
DB_PATH=/var/lib/pi-agent-server/pi-agent-server.db
PI_STORAGE_DIALECT=sqlite
PI_MIGRATION_GATE=verify
PI_DATA_MODE=managed
# 127.0.0.0/8：本机直连与 /health、/readyz 探针；其余为真实用户来源网段（经同机反代时也必须覆盖用户网段）
PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,<user-cidr-1>,<user-cidr-2>
PI_AGENT_DIR=/var/lib/pi-agent-server/agent
PI_AUTH_PATH=/var/lib/pi-agent-server/agent/auth.json
PI_DEFAULT_MODEL=<provider>/<modelId>
PI_DEFAULT_THINKING_LEVEL=medium
# 可选：为指定 IP 设置管理员、只读等权限；先创建下面的 JSON 文件，再取消下一行注释
# PI_IP_ACCESS_POLICY_FILE=/etc/pi-agent-server/ip-access-policy.json
# 可选：备份 plaintext staging 根（默认在 HOME 下自动创建为 0700；显式设置时需使用绝对路径，访问权限为 0700，所属用户为 agent-server，且不得与 backup root 或其父目录重叠）
# PI_BACKUP_STAGING_ROOT=/srv/pi-agent-backup-staging
```

- `PI_ALLOWED_CLIENT_CIDRS` **必填**（无默认）：必须是严格 canonical CIDR、逗号分隔、无重复、无空白段；缺失/非法/重复即拒绝启动。不能只写 `127.0.0.0/8`——若用户经同机反代访问，必须包含真实用户网段。
- `PI_DEFAULT_MODEL` 可选但强烈建议显式设置：一旦设置，服务启动时用服务的 `ModelRuntime` 解析 `provider/modelId`，并要求该 provider 已配置凭证；解析失败报 `默认模型不可用：...`、无凭证报 `默认模型未配置凭证：...`，均为启动 fail-fast。**不设置**时服务回退到 Pi 的默认模型解析（settings 默认 → 有凭证的 provider 默认模型）；若仍无可解析模型，`GET /v1/models` 的 `defaultModel` 为 `null`、新建会话没有默认模型，因此部署时应填写实际可用且已配置访问凭据的模型标识，不要保留 `<provider>/<modelId>` 占位符。
- 模型凭证：`PI_AUTH_PATH` 指向服务账号持有的 `auth.json`（0600）；也可用 `PI_MODEL_PROVIDER`/`PI_MODEL_API_KEY` 注入运行时 key。**不要把 key 真实值写进 env 文件、文档或日志**；如需运行时 key，用 root 0600 的 systemd drop-in。
- 不要用 `source /etc/pi-agent-server/server.env` 之类把 env 文件当 shell 执行；systemd 用 `EnvironmentFile=`，手工命令用 `runuser ... env KEY=...` 显式传参。
- 权限固定 `root:agent-server 0640`；env 文件不提交 Git。

### 5. 工作目录与模型凭证

```bash
# 工作目录：Agent 工具的 cwd，必须可写，且不能是源码仓
runuser -u agent-server -- test -w /var/lib/pi-agent-server/workspace

# 模型目录与凭证（由服务账号持有；auth.json 0600）
install -d -o agent-server -g agent-server -m 0700 /var/lib/pi-agent-server/agent
# 本例选择文件凭据方式。先取得运维托管、格式有效的 auth.json，再替换下面的绝对路径。
# 不要打印文件内容，不要把 <...> 占位符原样执行。
install -o agent-server -g agent-server -m 0600 \
  /absolute/path/to/provisioned-auth.json /var/lib/pi-agent-server/agent/auth.json
runuser -u agent-server -- test -r /var/lib/pi-agent-server/agent/auth.json
# 如使用自定义 provider：/var/lib/pi-agent-server/agent/models.json（0600）
```

- `PI_AGENT_DIR`（模型目录）与 `PI_AUTH_PATH`（凭证）必须与 `server.env` 一致；`models.json` 位于 `PI_AGENT_DIR/models.json`。
- 本例使用文件凭据，须在启动前准备好可读、有效的 `auth.json`。若改用运行时 key，应按该方式配置并单独验证模型可用性，不要盲目执行本例复制命令或伪造空凭据文件。凭证文件不打印、不提交、不进 argv；备份不会包含凭证（见 [backup-restore.md](backup-restore.md)）。

### 6. 首次初始化数据库（完全空库，唯一一次）

仅在**全新空库**上执行；服务启动**不会**自动初始化或迁移。

```bash
cd /srv/pi-agent-server
# 取一个 agent-server 可执行、且与 §7 unit ExecStart 完全相同的 Node 绝对路径。
# 记录 Node 实际二进制绝对路径；可用 `node -p 'process.execPath'` 获取。
NODE_BIN=/absolute/path/to/node
runuser -u agent-server -- test -x "$NODE_BIN"   # 服务账号必须可执行该路径
runuser -u agent-server -- env \
  HOME=/var/lib/pi-agent-server \
  AGENT_CWD=/var/lib/pi-agent-server/workspace \
  DATA_DIR=/var/lib/pi-agent-server \
  DB_PATH=/var/lib/pi-agent-server/pi-agent-server.db \
  PI_MIGRATION_GATE=verify \
  "$NODE_BIN" /srv/pi-agent-server/dist-migrate/scripts/migrate.js \
    --bootstrap-baseline --bootstrap-confirm CONFIRMED

runuser -u agent-server -- env \
  HOME=/var/lib/pi-agent-server \
  AGENT_CWD=/var/lib/pi-agent-server/workspace \
  DATA_DIR=/var/lib/pi-agent-server \
  DB_PATH=/var/lib/pi-agent-server/pi-agent-server.db \
  PI_MIGRATION_GATE=verify \
  "$NODE_BIN" /srv/pi-agent-server/dist-migrate/scripts/migrate.js --verify
```

- `--bootstrap-baseline --bootstrap-confirm CONFIRMED` 是**唯一**建立 canonical baseline 的写入命令；不可混用 backup/maintenance 参数，也不会创建 pre-backup。它要求目标完全为空；对已有库重跑会 fail-closed。
- 手工命令**只显式传** `AGENT_CWD`/`DATA_DIR`/`DB_PATH`/`PI_MIGRATION_GATE`，值与 `server.env` 一致；不要 source env 文件。
- migration CLI 要求 `AGENT_CWD` 为绝对路径；入口是 `dist-migrate/scripts/migrate.js`（`bin.pi-agent-server-migrate`）。
- 空库是唯一例外：后续 schema 升级**禁止**再跑 bootstrap，必须走 [backup-restore.md §5.2](backup-restore.md#52-已有唯一-canonical-baseline-的-apply) 的 pre-backup → `--apply` → `--verify`。

### 7. systemd unit

`/etc/systemd/system/pi-agent-server.service`：

```ini
[Unit]
Description=pi-agent-server (RC, intranet, single-instance SQLite)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent-server
Group=agent-server
WorkingDirectory=/var/lib/pi-agent-server/workspace
Environment=HOME=/var/lib/pi-agent-server
Environment=TMPDIR=/var/lib/pi-agent-server/tmp
EnvironmentFile=/etc/pi-agent-server/server.env
# Node.js 二进制绝对路径（版本不低于 22.22.3）；可用 `node -p 'process.execPath'` 获取。
# 该路径须对 agent-server 可穿越且可执行，避免运行时位于 root 私有目录。
ExecStart=<NODE_BIN_ABSOLUTE> /srv/pi-agent-server/dist/main.js
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=90
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
```

- `ExecStart` 必须是**固定 Node 绝对路径**，直接启动 Node 进程而非包装命令；可用 `node -p 'process.execPath'` 获取实际二进制路径。不要猜 `/usr/local/bin/node`；该路径必须对 `agent-server` 可穿越且可执行，避免运行时位于 root 私有目录。直接启动 Node 可确保 `SIGTERM` 到达应用注册的优雅关闭处理器；若经包装进程启动，信号转发可能不可靠。
- unit **不得**加入 migration/backup 参数或启动前钩子：服务不自动 migrate、不自动 backup；migration 是离线一次性命令。
- `SIGTERM` 由 `dist/main.js` 处理：停止接收新请求并 `app.close()` 等在途请求完成；`TimeoutStopSec` 必须足够覆盖最长在途请求/SSE，过短会在优雅关闭完成前 `SIGKILL`。建议至少 90s，并在维护窗口用 `systemctl stop` 实测日志出现「收到 SIGTERM，开始优雅关闭」且进程正常退出。

### 8. 启动与探针校验

```bash
systemctl daemon-reload
systemctl enable --now pi-agent-server.service
systemctl is-enabled pi-agent-server.service   # enabled
systemctl is-active pi-agent-server.service    # active

# 探针从回环访问；/health 与 /readyz 永不需要 token
curl -fsS http://127.0.0.1:8080/health          # {"status":"ok"}
curl -fsS http://127.0.0.1:8080/readyz          # {"ready":true,"migrationGate":"verify","schema":"migration-head"}
```

- `/health` 是存活探针；`/readyz` 是就绪探针：只有安全启动完成（存储初始化 + migration gate 通过 + `listen` 成功）才返回 200，否则 503。`/metrics` 需要 `admin`/`operator` 角色（按策略可能还需 token），不要用它做基础探针。
- 启动失败时进程不监听，`ready` 恒为 false；用 `journalctl -u pi-agent-server -n 100 --no-pager` 查看 fail-fast 原因（错误不回显 env 值）。

### 9. 反向代理（可选，使用既有 nginx）

服务只监听 `127.0.0.1:8080`；同机 nginx 反代时，agent-server 看到的 TCP 对端恒为回环，此时才采用 `X-Forwarded-For` 的**最右一条**作为客户端 IP。因此：

- nginx 必须写入真实客户端地址。推荐直接覆盖，只留一个真实地址：

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $remote_addr;   # 覆盖任何客户端自带值
      proxy_buffering off;                             # SSE 需要
      proxy_read_timeout 1h;
  }
  ```

  也可用追加语义 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`（最右段即 nginx 写入的 `$remote_addr`，服务只取最右一条）。**禁止**使用 `$http_x_forwarded_for` 等客户端可控值。
- `PI_ALLOWED_CLIENT_CIDRS` 必须覆盖经代理到达的真实用户网段；`127.0.0.0/8` 只覆盖本机直连与探针。
- 服务只信任「对端为回环」这一代理边界：不要改 `HOST=0.0.0.0` 把服务直接暴露给内网/公网，否则非回环对端会忽略 XFF，且 IP-RBAC 不是沙箱。公网暴露禁止。

### 10. 升级与维护（停写备份）

1. `systemctl stop pi-agent-server.service`，并独立确认没有其他 writer（单实例：每个 DB + `DATA_DIR` 只允许一个实例）。
2. 按 [backup-restore.md](backup-restore.md) 做加密备份。`--apply` 强制要求绝对 `--backup-root` 与 `--age-recipient-file`，因此升级路径必须先具备加密备份能力；未配置备份/加密时，先完成该能力配置再升级。
3. 准备并部署**目标版本**的服务与 migration 产物（`pnpm build`、`pnpm build:migrate`）；可提前在独立发布目录构建，不能让旧版本 migration 工具代替目标版本。此时服务仍保持停止。
4. 使用**目标版本**的离线入口执行 `--dry-run` 审核 → 必要时 `--apply`（内部先创建并验证 pre-migration 加密备份）→ `--verify`，命令与边界见 [backup-restore.md §5.2](backup-restore.md#52-已有唯一-canonical-baseline-的-apply)。如无 schema 变化则仅验证，不多做迁移。
5. `systemctl start pi-agent-server.service`，重新检查 `/health`、`/readyz`。

禁止对已有库重跑 `--bootstrap-baseline`；该命令只用于完全空库。

### 11. 首次部署验收清单

- [ ] 服务账号与目录权限符合 §1（数据目录 0700、工作目录可写、env 文件 `root:agent-server 0640`）。
- [ ] `dist/main.js` 与 `dist-migrate/scripts/migrate.js` 存在（§3）。
- [ ] `server.env` 中 `PI_ALLOWED_CLIENT_CIDRS` 覆盖本机与真实用户网段，且不含 secret（§4）。
- [ ] `PI_DEFAULT_MODEL` 指向真实可用且已配置凭证的 model；启动无 `默认模型不可用`/`未配置凭证` 报错（§4/§8）。
- [ ] bootstrap + `--verify` 成功，且未对已有库重跑 bootstrap（§6）。
- [ ] `ExecStart` 指向固定 Node 绝对路径，unit 不含 migration/backup 参数（§7）。
- [ ] `/health`、`/readyz` 均成功；`systemctl is-enabled` 为 `enabled`（§8）。
- [ ] 如经 nginx：XFF 只写 `$remote_addr`/`$proxy_add_x_forwarded_for`，用户网段已加入 CIDR（§9）。

## 数据库初始化（通用，按存储方言）

正式 SQLite 首次部署按上方[通用首次生产部署](#通用首次生产部署)完整流程执行；本节保留通用初始化命令、PostgreSQL 初始化与升级边界。以下初始化步骤只适用于**新机器/空库**，不是现网升级命令；升级按 [Migration 启动门禁](#migration-启动门禁)及其引用的迁移流程执行。插件是可选能力；宿主本身不依赖任何具体插件或发布服务。

### SQLite

先准备工作目录和数据目录，再建立并校验数据库：

```bash
export AGENT_CWD=/absolute/path/to/workspace
export DATA_DIR=/absolute/path/to/data
export DB_PATH="$DATA_DIR/pi-agent-server.db"
mkdir -p "$AGENT_CWD" "$DATA_DIR"

pi-agent-server-migrate --bootstrap-baseline --bootstrap-confirm CONFIRMED
pi-agent-server-migrate --verify
```

校验成功后，在同一组环境变量下配置访问范围并启动：

```bash
export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8
pi-agent-server
```

### PostgreSQL

先创建一个空数据库和空的业务 schema，并确保连接后的 `current_schema()` 是该业务 schema，而不是 `public` 或系统 schema。然后执行：

```bash
export AGENT_CWD=/absolute/path/to/workspace
export DATA_DIR=/absolute/path/to/data
export PI_STORAGE_DIALECT=postgres
export PI_DATABASE_URL='postgresql://user:password@host:5432/database'
mkdir -p "$AGENT_CWD" "$DATA_DIR"

pi-agent-server-migrate --bootstrap-baseline --bootstrap-confirm CONFIRMED
pi-agent-server-migrate --verify

export PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8
pi-agent-server
```

本地 PostgreSQL 环境示例见 [postgres-podman-test.md](postgres-podman-test.md)。后续 schema 升级不要再次运行 `pi-agent-server-migrate --bootstrap-baseline --bootstrap-confirm CONFIRMED`；应按 [backup-restore.md §5.2](backup-restore.md#52-已有唯一-canonical-baseline-的-apply) 执行 pre-backup、`--apply` 和 `--verify`。

## 部署边界

- 每个 logical SQLite DB / PostgreSQL schema 及其 `DATA_DIR` 只支持一个 pi-agent-server 实例；不支持共享同一存储的多副本或重叠滚动升级，架构约束见 [architecture.md](architecture.md)。
- 备份根路径、age 密钥、异地边界、RPO/RTO、保留期和恢复演练要求以 [backup-restore.md](backup-restore.md) 为准。
- DELETE 会在数据库事务中写入 `file_operations` outbox；当前没有 worker、unlink 或 quarantine，物理 JSONL 不会被删除。

<details>
<summary>非当前生产方案：未来主服务 Podman 部署前置条件</summary>

### Podman 正式部署计划（未来方案）

当前仓库尚未提供主服务 Containerfile；`docker/scheduler/Containerfile` 只用于备份调度/演练。正式部署前完成以下事项：

1. 新增主服务 Containerfile，固定受支持的 Node.js 版本，以非 root 用户运行 `pi-agent-server`；
2. 镜像包含经过验证的服务与 migration/backup/restore 编译产物，数据库初始化和升级仍作为显式 one-shot 命令执行；
3. 数据目录和服务专用 `auth.json` 从宿主机挂载，不写入镜像；OpenAI Codex 等 OAuth 凭证先在宿主机通过独立 `PI_CODING_AGENT_DIR` 执行 Pi `/login` 生成，再以可读写方式挂载并通过容器内 `PI_AUTH_PATH` 使用，同时验证容器用户权限、token 刷新回写和停服后重新登录流程；
4. 通过环境变量或容器 secret 注入配置与凭证，镜像层、构建日志和运行日志不包含 secret；
5. 接入 `/health`、`/readyz`、停止信号和有界优雅关闭，并验证容器重启后的数据与凭证行为；
6. 增加镜像构建、启动、首次数据库初始化、升级和恢复 smoke test，形成可复制的 Podman run/部署示例。

验收产物包括主服务 Containerfile、部署说明、固定版本镜像构建命令和自动化 smoke test。该计划默认沿用当前单实例边界；多实例部署需等待对应架构改造。

</details>

## 任务入口

| 任务 | 命令 / 入口 | 权威文档 |
| --- | --- | --- |
| SQLite/PostgreSQL 备份 | `pnpm backup -- create` / `pi-agent-server-backup` | [backup-restore.md](backup-restore.md) |
| 隔离恢复 | `pnpm restore -- restore` / `pi-agent-server-restore` | [backup-restore.md](backup-restore.md) |
| 离线 migration bootstrap/apply/verify | `pnpm migrate -- ...` / `pi-agent-server-migrate` | [backup-restore.md](backup-restore.md) |
| legacy / 非 canonical 数据 | 不提供 reset、cutover 或 baseline adoption；无 ledger 或非唯一 canonical baseline 的库 fail-closed，只有重新准备完全空目标后才能用 `pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED` 建立 baseline | [ADR 0002](decisions/0002-canonical-baseline-and-migration-gate.md) |
| IP→IP owner transfer | `pnpm owner-transfer -- ...` | [owner-transfer.md](owner-transfer.md) |
| outbox 只读统计 | `pnpm file-ops -- run` | [file-operations.md](file-operations.md) |
| DB 引用只读分析 | `pnpm reconcile-jsonl -- run` | [reconcile-jsonl.md](reconcile-jsonl.md) |
| `/health`、`/readyz`、`/metrics` | 运行中服务 | [ip-rbac-design.md](ip-rbac-design.md) |
| 备份 freshness 部署/演练 | 部署方审核的 helper/timer（未安装，设计归档） | [archive/backup-freshness-exporter.md](archive/backup-freshness-exporter.md) / [SOP](archive/backup-freshness-drill-sop.md) |
| 备份 freshness 演练门禁/清理/run 资格 | `pnpm drill -- preflight` / `pnpm drill -- cleanup` / `pnpm drill -- run`（`pi-agent-server-drill`） | [archive/SOP](archive/backup-freshness-drill-sop.md) |

`pnpm` 命令只用于人工开发和演练。自动备份必须调用固定编译产物，不能以 `pnpm backup` 作为调度入口。`pi-agent-server-drill` 是隔离的一键演习执行器：`preflight` 只做安全门禁；`run` 自动执行合成 SQLite/PostgreSQL fixture、容器内真实 cron、编译产物 backup/restore/migrate、隔离恢复校验、临时 node_exporter/Prometheus/Alertmanager/测试 webhook 及完整故障矩阵，输出真实 `PASS`/`FAIL`/`DEFERRED`（仅在缺少 podman/age/pg 工具时 `DEFERRED`），绝不通过环境变量自证 `PASS`。本次运行专属 Podman 资源在结束后验证删除，脱敏 summary 保留。`cleanup` 先执行完整 preflight 且要求两个固定 secrets 均有效，只清空已知运行目录并固定保留 `$PI_DRILL_ROOT/secrets/`。

## 通用安全规则

1. migration、owner transfer 都是离线操作；先由 service manager 停止服务并独立确认无 writer。
2. `--maintenance-window CONFIRMED` 只是操作员声明，不是进程锁。
3. destructive/apply 操作必须先完成加密备份和包验证；失败时不自动 down、restore 或 retry。
4. restore 只能指向隔离的新目标，禁止覆盖源数据库、正式 schema 或正式 `DATA_DIR`。
5. 路径必须是明确的绝对路径；backup root 不得与源数据、staging 或凭证路径重叠。
6. PostgreSQL 必须显式设置 `PI_STORAGE_DIALECT=postgres` 与 `PI_DATABASE_URL`；server、`pg_dump`、`pg_restore` major 必须匹配。
7. secret 不得进入 argv、manifest、日志或证据包；`age-recipient-file` 只包含公钥 recipient。

## Migration 启动门禁

**当前 migration 实现：**

- 数据模式 `PI_DATA_MODE`（默认 `managed`）：`managed` = 正式受管数据，`rc` = 显式 disposable 的 RC 数据；未知非空值拒绝启动。
- `PI_MIGRATION_GATE`（默认 `verify`）为 verify-only：启动前只读检查 migration ledger/head（空库/无 ledger 库/非唯一 canonical baseline/落后库 fail-fast），**绝不自动 migration/reset**；显式 `off` 一律拒绝。
- `PI_DATA_MODE=managed` 与 `PI_DATA_MODE=rc` 均必须搭配 `PI_MIGRATION_GATE=verify`；`off` 在任何资源创建前 fail-closed。
- 完全空 SQLite DB 或完全空 non-public/non-system PostgreSQL schema 必须离线执行 `pnpm migrate -- --bootstrap-baseline --bootstrap-confirm CONFIRMED`；该命令不可混用 backup/maintenance 参数且不会创建 pre-backup。已有唯一 canonical baseline 的数据库才执行 `pnpm migrate -- --apply`，并经过已验证 pre-backup→apply→verify；其他状态均 fail-closed。

## 验证

日常验证使用 `pnpm verify`，发布验证使用 `pnpm verify:release`。真实 PostgreSQL/age 验收只有在当前环境提供相应 URL/二进制且对应 gate 实际运行时才成立；不以 skip 或历史测试数量代替证据。
