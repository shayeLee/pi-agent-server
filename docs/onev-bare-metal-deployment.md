# ONEV 裸机首次部署（pi-agent-server + 插件 + 前端）

本文记录 `pi-agent-server`、`pi-agent-capability-onev` 和 ONEV 前端在同一台 Linux 内网服务器上的首次部署流程。**本流程不使用 Docker、Podman，不新增 Nginx 或反向代理，也不面向公网。** 浏览器只访问原组件库文档网站的内网 Origin；agent-server 的 `/v1`、`/health` 与 `/readyz` 由该网站现有部署入口以同一 Origin 暴露。

适用的源码目录示例：

```text
/srv/pi-agent-server                 pi-agent-server
/srv/pi-agent-capability-onev        pi-agent-capability-onev（尚未发布）
/srv/onev                             ONEV 前端/组件库
```

## 0. 先确认交付边界

### 助手部署前需完成

以下是助手/研发侧的前置交付，不是操作人登录新机器后临时补做的步骤：

1. **已完成并通过本地真实验收**：ONEV 组件说明页的编辑图标 → 钉钉文档绑定/改绑 → 自动同步 → 状态与错误展示；Tag 文档已验证正文、标题编号/层级、11 张本地图片与浏览器渲染。
2. **已完成**：绑定、改绑、权限、同步状态、active job 去重、失败路径和生命周期自动化测试；真实 DWS 三读快照与 media download 链路已用操作人授权的可控文档确认。
3. **已收口验收证据**：插件仓 `docs/p8-integration-evidence.md`、ONEV 仓 `docs/p8-copilot-evidence.md` 与宿主 `docs/p8-host-integration-drill.md` 共同记录自动化和真实绑定/同步结果；正式生产部署仍须按本文重新执行受控验收。
4. **部署前待固化**：裸机 systemd unit 和安装/升级脚本目前尚未在本仓库形成正式产物。下面的 unit 只是示例，不能声称已有自动化部署产物。

### 操作人部署前需准备

- 一台只能从受控内网访问的 Linux 机器，并确定服务账号（下文以 `onev` 为例）。
- 绝对路径且权限清晰的目录：宿主源码、插件源码、ONEV 源码、宿主数据、插件数据、Pi 凭证目录、静态站点目录（或直接使用 ONEV checkout 下的构建目录）。
- Volta、systemd；由服务账号固定安装 Node.js `22.19.0` 和 pnpm `8.15.9`，ONEV 前端构建固定使用 Node.js `16.20.2` 与 yarn `1.22.22`。所有安装、构建、初始化和链接命令均以该服务账号执行，避免生成 root-owned 数据库或用户私有全局 link。
- Pi 的 `models.json`/`auth.json` 或等价凭据。建议把 `PI_AGENT_DIR`、`PI_AUTH_PATH` 放在服务账号可读且权限为 0600/0700 的目录中。
- 已登录且能被服务账号使用的 DWS CLI；插件要求通过 `ONEV_DWS_BIN` 指定绝对路径，不扫描 `PATH`。钉钉/DWS 凭据由 DWS 自己的凭据机制提供，不把 token 写进本文或 unit。
- 一篇可用于首次绑定与同步验收的非生产或可控钉钉文档，并确保服务账号具备读取权限。
- ONEV 文档站的内网 Origin（例如 `http://onev.internal`）、agent-server 的本机监听地址，以及现有网站如何把同一 Origin 下的 `/v1`、`/health`、`/readyz` 交给 agent-server。本文不新增反向代理配置。
- 原组件库文档网站必须已有可靠的内网访问控制。agent-server 看到的 TCP 对端是同机网站入口，因此当前宿主会把经该入口访问的浏览器视为同一身份；它不提供终端用户级隔离。

**首次部署没有生产数据，因此不要求部署前备份。** 后续已有数据的升级、迁移或换机，必须按 [backup-restore.md](backup-restore.md) 的备份、停写和恢复规则执行；这条例外不适用于本次空库初始化。

## 1. 版本和目录约定

| 部件 | Node.js | 包管理器/入口 | 数据或构建产物 |
| --- | --- | --- | --- |
| `pi-agent-server` | `>=22.19.0` | `pnpm` | `DATA_DIR`、`DB_PATH` |
| `pi-agent-capability-onev` | `>=22.19.0` | `pnpm` | `ONEV_DATA_DIR/onev.db`（当前 schema v8） |
| ONEV 前端 | `16.20.2` | `yarn`（仓库声明 yarn 1） | `examples/onev-ui` |

本文所有顶层 Node 工具命令都显式使用 `volta run`。不要直接运行裸的 `node`、`npm`、`pnpm` 或 `yarn`；ONEV 的 `build:docs` 也不要用宿主 Node 版本执行。

## 2. 环境变量示例

在新机器上创建仅服务账号可读的环境文件，例如 `/etc/pi-agent-server/onev.env`。以下值都是示例，不能原样用于生产：

```dotenv
# pi-agent-server
# agent-server 只供同机的组件库网站部署入口访问。
HOST=127.0.0.1
PORT=8080
AGENT_CWD=/srv/onev
DATA_DIR=/var/lib/pi-agent-server
DB_PATH=/var/lib/pi-agent-server/pi-agent-server.db
# agent-server 的 TCP 对端是同机网站部署入口；不要使用 0.0.0.0/0。
PI_ALLOWED_CLIENT_CIDRS=127.0.0.1/32
# 浏览器访问同一 Origin，相对路径 /v1 不需要 CORS；保持 CORS_ORIGINS 未设置。
PI_MIGRATION_GATE=verify
PI_DATA_MODE=managed
PI_DEFAULT_MODEL=openai-codex/gpt-5.6-luna
PI_DEFAULT_THINKING_LEVEL=medium
# models.json/auth.json（或环境变量）还必须能解析并认证插件固定使用的：
# modelscope/deepseek-ai/DeepSeek-V4.1-Flash
# 用法原理/设计规范 thinkingLevel=medium；交互原型 thinkingLevel=high
MODELSCOPE_API_KEY=<通过受限环境或 secret 注入，不写入 Git>
PI_AGENT_DIR=/var/lib/pi-agent-server/pi-agent
PI_AUTH_PATH=/var/lib/pi-agent-server/pi-agent/auth.json
PI_PLUGINS=pi-agent-capability-onev

# pi-agent-capability-onev：独立于宿主数据库
ONEV_DATA_DIR=/var/lib/pi-agent-capability-onev
ONEV_DWS_ENABLED=true
ONEV_DWS_BIN=/usr/local/bin/dws
# 可选：仅在要启用对应只读 Pi 工具时配置
ONEV_VUE2_INDEX_BIN=/usr/local/bin/vue2-index
ONEV_GITNEXUS_BIN=/usr/local/bin/gitnexus
```

本方案要求浏览器看到的文档页面和 `/v1` API **协议、主机、端口三者完全相同**；只有主机名相同但端口不同仍属于跨 Origin。ONEV 保持 `window.ONEV_COPILOT_CONFIG.baseUrl` 为空，使用相对路径 `/v1`，不设置 `CORS_ORIGINS`。agent-server 只监听 `127.0.0.1:8080`，由原组件库网站已有的同源部署入口在服务器内部访问；不要把 `8080` 直接暴露给浏览器或公网。

插件也提供可复制的 `.env.example`，但生产环境应使用上述受限环境文件。`ONEV_DATA_DIR` 必须是独立目录，不能把插件数据库放进宿主 `DATA_DIR`；插件注册只打开已迁移到当前 head 的库，不会隐式建库或迁移。

## 3. 首次安装、构建和初始化

### 3.1 准备目录和源码

```bash
sudo install -d -o onev -g onev -m 0750 \
  /srv/pi-agent-server /srv/pi-agent-capability-onev /srv/onev \
  /var/lib/pi-agent-server /var/lib/pi-agent-capability-onev
sudo install -d -o onev -g onev -m 0700 \
  /var/lib/pi-agent-server/pi-agent
```

将三个源码 checkout 放到第 1 节的目录，确认服务账号能读取源码、写入两个数据目录，并确认 `ONEV_DWS_BIN` 指向真实的普通可执行文件。插件不是已发布 npm 包，部署时必须保留其源码 checkout 并从源码构建。

### 3.2 构建宿主

```bash
cd /srv/pi-agent-server
volta run --node 22.19.0 -- pnpm install --frozen-lockfile
volta run --node 22.19.0 -- pnpm build
volta run --node 22.19.0 -- pnpm build:migrate
```

### 3.3 构建插件并初始化插件 v8 数据库

插件的 `build` 会把 `src` 生成到 `dist`；`migrate` 是显式操作，会创建 `ONEV_DATA_DIR/onev.db` 并应用到当前 schema head（目前为 v8）。

```bash
cd /srv/pi-agent-capability-onev
volta run --node 22.19.0 -- pnpm install --frozen-lockfile
volta run --node 22.19.0 -- pnpm build

export ONEV_DATA_DIR=/var/lib/pi-agent-capability-onev
volta run --node 22.19.0 -- pnpm run migrate -- --data-dir "$ONEV_DATA_DIR"
volta run --node 22.19.0 -- pnpm run migrate -- --data-dir "$ONEV_DATA_DIR" --dry-run
```

第二条命令会实际读取数据库 migration ledger；预期 `appliedVersion` 与 `targetVersion` 均为 `8`，且 `pending`、`drift`、`unknown` 均为空。不要用只输出配置目标的 `config` 命令或启动宿主来代替迁移校验。

### 3.4 初始化宿主数据库

新机器上的宿主数据库同样是空库，必须显式建立 canonical baseline。以下示例使用 SQLite；PostgreSQL 不属于本裸机首次部署的默认路径。

```bash
cd /srv/pi-agent-server
export AGENT_CWD=/srv/onev
export DATA_DIR=/var/lib/pi-agent-server
export DB_PATH=/var/lib/pi-agent-server/pi-agent-server.db

volta run --node 22.19.0 -- node dist-migrate/scripts/migrate.js \
  --bootstrap-baseline --bootstrap-confirm CONFIRMED
volta run --node 22.19.0 -- node dist-migrate/scripts/migrate.js --verify
```

服务启动门禁固定为 `PI_MIGRATION_GATE=verify` 的语义：宿主启动不会自动 bootstrap、reset 或 apply migration。后续升级应先停止 writer、备份，再显式 apply/verify。

### 3.5 用宿主侧本地 link 接入未发布插件

当前插件尚未发布，接入方式是“插件源码构建 + 宿主本地 `pnpm link <dir>`”，不是从 registry 安装，也不使用依赖操作者私有 `PNPM_HOME` 的全局 link。以 `onev` 服务账号在宿主目录执行：

```bash
cd /srv/pi-agent-server
volta run --node 22.19.0 -- pnpm link /srv/pi-agent-capability-onev
volta run --node 22.19.0 -- pnpm list --depth 0
volta run --node 22.19.0 -- node -e \
  "import('pi-agent-capability-onev').then(() => console.log('plugin resolved'))"
```

确认宿主 `node_modules/pi-agent-capability-onev` 指向插件 checkout 的已构建包，并且 `PI_PLUGINS=pi-agent-capability-onev`。插件是宿主同进程的受信任代码，不是独立服务或进程隔离边界。

## 4. 构建 ONEV 前端静态产物

ONEV checkout 的 `package.json` 将文档站构建固定为 `build:docs`，该命令会清理并重新生成 `examples/onev-ui`。它使用 Node.js `16.20.2`，不要用 Node 22 构建：

```bash
cd /srv/onev
unset ONEV_COPILOT_BASE_URL
volta run --node 16.20.2 --yarn 1.22.22 -- yarn install --frozen-lockfile
volta run --node 16.20.2 --yarn 1.22.22 -- yarn build:docs
```

ONEV 的 `yarn.lock` 当前包含内网 registry `http://10.0.0.205:4873`；构建机必须能访问该受控 registry，或在部署前另行交付经过审核、可从受支持 registry 重建的锁文件/离线缓存。

验收时确认 `/srv/onev/examples/onev-ui/index.html` 存在，并由原组件库文档网站既有方式发布该目录。构建目录属于前端发布产物，不要把它当成插件数据库或宿主 `DATA_DIR`。

## 5. 使用原组件库文档网站的同一内网 Origin

ONEV 无需配置独立 API 域名。生产页面继续使用 HTTP 客户端的默认配置：`baseUrl` 为空，所有请求使用 `/v1/...` 相对路径，SSE 也使用同一 Origin。

部署验收必须确认：

1. 浏览器地址栏中的文档站 Origin 与 `/v1` 的 Origin 完全一致（协议、主机、端口均一致）；
2. 原组件库网站现有部署入口能在服务器内部访问 `127.0.0.1:8080`，并把 `/v1`、`/health`、`/readyz` 暴露在其自身 Origin；
3. 构建时 `ONEV_COPILOT_BASE_URL` 已清空，运行时 `window.ONEV_COPILOT_CONFIG.baseUrl` 未设置或为空字符串，浏览器实际请求相对路径 `/v1`；
4. `CORS_ORIGINS` 未设置，因为不存在浏览器跨 Origin 请求；
5. agent-server 的 `8080` 不直接对内网客户端或公网开放；
6. 原文档网站的访问控制已启用，并已接受“当前所有经同机入口访问者共享宿主身份、没有终端用户级 owner 隔离”的边界。

本文不新增或管理 Nginx/反向代理；同源路径如何接入 agent-server 由原组件库文档网站既有部署方式负责。若实际部署只能使用不同端口，必须回到跨 Origin 方案并显式配置 `CORS_ORIGINS`，不能只凭“域名相同”判断为同源。

## 6. systemd 托管（示例待固化）

pi-agent-server 前台运行，systemd 负责启动、停止和故障重启。以下 unit 仅为示例，**不是仓库已经提供的 systemd 文件**；其中 Volta 的绝对路径必须按服务账号实际安装位置修改：

```ini
[Unit]
Description=pi-agent-server with ONEV capability
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=onev
Group=onev
WorkingDirectory=/srv/pi-agent-server
EnvironmentFile=/etc/pi-agent-server/onev.env
ExecStart=/home/onev/.volta/bin/volta run --node 22.19.0 -- node /srv/pi-agent-server/dist/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
```

示例 unit 固化后再执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pi-agent-server.service
sudo systemctl status pi-agent-server.service
```

若 `auth.json` 需要 Pi 自动刷新 token，确保服务账号对该文件拥有所需的最小读写权限；不要把凭据写入 unit、Git、构建日志或 journal。

## 7. 启动和验收

### 7.1 手动前台启动

在 systemd unit 尚未固化前，可用同一个环境文件前台启动验证。`dist/main.js` 使用已构建的宿主和 link 后的插件：

```bash
cd /srv/pi-agent-server
set -a
. /etc/pi-agent-server/onev.env
set +a
volta run --node 22.19.0 -- node dist/main.js
```

不要用 `pnpm dev:real` 作为生产托管命令；它是开发启动入口。

### 7.2 基本探针

```bash
curl --fail --silent --show-error http://onev.internal/health
curl --fail --silent --show-error http://onev.internal/readyz
```

预期：`/health` 返回 HTTP 200 和 `{"status":"ok"}`；`/readyz` 返回 HTTP 200 且 `ready` 为 `true`。若 `/readyz` 为 503，先查宿主 migration verify、数据库路径、插件注册错误和 journal，不要反复重启掩盖根因。

### 7.3 绑定和同步 smoke

以下路径是宿主 `/v1` 下挂载的插件路由：

```text
/v1/capabilities/onev/documents/links
/v1/capabilities/onev/sync/dingtalk/:name
/v1/capabilities/onev/jobs/:id
```

在浏览器中通过“组件说明编辑图标 → 绑定钉钉文档”完成一次绑定，然后检查：

1. 点击“保存并同步”后，UI 自动保存绑定并创建或复用该 binding snapshot 的 active job；不要再手工点击第二次同步。
2. 以 UI 返回的任务状态作为首选验收路径；仅在 UI 无法取得任务状态、需要诊断时，才在已配置有效 Bearer token 的情况下用组件名执行：

   ```bash
   read -r -s ONEV_TOKEN
   curl --fail --silent --show-error \
     -H "Authorization: Bearer $ONEV_TOKEN" \
     -X POST "http://onev.internal/v1/capabilities/onev/sync/dingtalk/<URL编码后的组件名>"
   unset ONEV_TOKEN
   ```

   预期返回 HTTP 202 和 job id。随后轮询 `GET /v1/capabilities/onev/jobs/<job-id>`，直至 `status=succeeded`。
3. 确认项目目录出现 `examples/docs/zh-CN/<组件名>_desc.md`，有图片时确认 `examples/assets/dingtalk/<组件名>/` 下有对应产物；UI 本轮只验收绑定与同步状态。当前静态文档站不会自动读取同步后的新文件，必须先经过内容安全审核与显式重新构建，不能把 job 成功误记为页面内容已经发布。
4. 若绑定或同步返回 401/403，检查 IP-RBAC 与 Bearer token；若同步返回 503，检查 `ONEV_DWS_ENABLED`、`ONEV_DWS_BIN`、DWS 凭据和 project/dataDir ownership。不要把 503 当成成功证据。

探针与绑定/同步 smoke 通过后，才可以把本机验收记录连同助手阶段的 P8 最终证据归档。首次空库不要求恢复演练；后续有数据的备份/恢复验收另按运维文档执行。

## 8. 常见误区

- 不要运行 Docker/Podman，也不要把仓库现有的容器演练文档当成裸机部署实现。
- 不要把插件 `onev.db` 与宿主 `pi-agent-server.db` 合并；新机器必须分别初始化宿主 baseline 和插件 v8。
- 不要从 npm registry 安装一个声称已发布的 `pi-agent-capability-onev`；当前正确方式是源码构建后 `pnpm link`。
- 不要用 Node 16 启动宿主/插件，也不要用 Node 22 构建 ONEV `build:docs`。
- 不要在服务启动时期待自动 migration；两套数据库都应在首次启动前显式迁移并验证。
- 不要声称 systemd unit 或同源接入配置已经固化；本文件中的 systemd 配置仍标记为“示例待固化”，同源路径由原文档网站的既有部署入口负责。
