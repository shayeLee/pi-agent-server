# ONEV 裸机首次部署（pi-agent-server + 插件 + 前端）

本文记录 `pi-agent-server`、`pi-agent-capability-onev` 和 ONEV 前端在同一台 Linux 内网服务器上的首次部署流程。**本流程不使用 Docker、Podman，也不面向公网。** 浏览器只访问原组件库文档网站的内网 Origin；该 Origin 由本机 nginx 同源反代，把 `/v1`、`/health`、`/readyz` 转发到 `127.0.0.1:8080`（见 §5），因此 agent-server 看到的 TCP 对端恒为 `127.0.0.1`。

文档站内容在同步成功后由**最简 HTTP publisher**（见 §6）自动重建：插件在 job 成功时 POST 通知本机 publisher，publisher 立即返回 `202` 并在后台执行固定的 `build:docs`。本文不使用文件监听，也不引入 releases/outbox 目录。

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
4. **部署前待固化**：裸机 systemd unit、最简 HTTP publisher（§6）和安装/升级脚本目前尚未在本仓库形成正式产物。下面的 unit 与 publisher 源码只是示例，不能声称已有自动化部署产物。插件侧的 `ONEV_PUBLICATION_WEBHOOK_URL` 通知能力同样以插件实际交付版本为准；若该版本不发送通知，只能按 §4 手工重建。

### 操作人部署前需准备

- 一台只能从受控内网访问的 Linux 机器，并确定服务账号（下文以 `onev` 为例）。
- 绝对路径且权限清晰的目录：宿主源码、插件源码、ONEV 源码、宿主数据、插件数据、Pi 凭证目录、静态站点目录（或直接使用 ONEV checkout 下的构建目录）。
- Volta、systemd；由服务账号固定安装 Node.js `22.19.0` 和 pnpm `8.15.9`，ONEV 前端构建固定使用 Node.js `16.20.2` 与 yarn `1.22.22`。所有安装、构建、初始化和链接命令均以该服务账号执行，避免生成 root-owned 数据库或用户私有全局 link。
- Pi 的 `models.json`/`auth.json` 或等价凭据。建议把 `PI_AGENT_DIR`、`PI_AUTH_PATH` 放在服务账号可读且权限为 0600/0700 的目录中。
- 已登录且能被服务账号使用的 DWS CLI；插件要求通过 `ONEV_DWS_BIN` 指定绝对路径，不扫描 `PATH`。钉钉/DWS 凭据由 DWS 自己的凭据机制提供，不把 token 写进本文或 unit。
- 一篇可用于首次绑定与同步验收的非生产或可控钉钉文档，并确保服务账号具备读取权限。
- 若需要“同步后自动重建文档站”，按 §6 部署最简 HTTP publisher：准备 `/srv/onev-publisher` 目录与 `onev-publisher.service`，并在环境文件设置 `ONEV_PUBLICATION_WEBHOOK_URL=http://127.0.0.1:9091/publish`。该端口只应绑定回环，不得转发到内网其他主机。
- ONEV 文档站的内网 Origin（例如 `http://onev.internal`）、agent-server 的本机监听地址（`127.0.0.1:8080`），以及本机 nginx 如何把同一 Origin 下的 `/v1`、`/health`、`/readyz` 反代到 agent-server（配置示例见 §5）。
- 原组件库文档网站必须已有可靠的内网访问控制。agent-server 看到的 TCP 对端是同机 nginx（`127.0.0.1`），因此宿主仅在「对端为回环」时采用 nginx 写入的 `X-Forwarded-For` 最右条目作为真实客户端 IP；这样 mode 会话、原型等用户资源仍保留各自的 owner 隔离。钉钉文档绑定与同步任务是插件级全局配置，不使用 IP 作为 owner：任何获得 `canBind` 的管理员都能查看、绑定、换绑和同步同一批组件。服务仍不提供终端用户级认证——同一内网 IP 背后的多人共享同一身份。

**首次部署没有生产数据，因此不要求部署前备份。** 后续已有数据的升级、迁移或换机，必须按 [backup-restore.md](backup-restore.md) 的备份、停写和恢复规则执行；这条例外不适用于本次空库初始化。

## 1. 版本和目录约定

| 部件 | Node.js | 包管理器/入口 | 数据或构建产物 |
| --- | --- | --- | --- |
| `pi-agent-server` | `>=22.19.0` | `pnpm` | `DATA_DIR`、`DB_PATH` |
| `pi-agent-capability-onev` | `>=22.19.0` | `pnpm` | `ONEV_DATA_DIR/onev.db`（当前 schema v8） |
| ONEV 前端 | `16.20.2` | `yarn`（仓库声明 yarn 1） | `examples/onev-ui` |
| 最简 publisher（§6） | `>=22.19.0` | Node HTTP（无第三方依赖） | 无数据；触发 `build:docs` |

本文所有顶层 Node 工具命令都显式使用 `volta run`。不要直接运行裸的 `node`、`npm`、`pnpm` 或 `yarn`；ONEV 的 `build:docs` 也不要用宿主 Node 版本执行。

## 2. 环境变量示例

在新机器上创建仅服务账号可读的环境文件，例如 `/etc/pi-agent-server/onev.env`。以下值都是示例，不能原样用于生产：

```dotenv
# pi-agent-server
# agent-server 只供同机 nginx 反代访问（HOST=127.0.0.1，外网不可直达）。
HOST=127.0.0.1
PORT=8080
AGENT_CWD=/srv/onev
DATA_DIR=/var/lib/pi-agent-server
DB_PATH=/var/lib/pi-agent-server/pi-agent-server.db
# 准入网段必须覆盖真实用户所在内网：同机 nginx 经 X-Forwarded-For 把用户 IP 传给 agent-server，
# agent-server 取 XFF 最右条目作为身份。127.0.0.0/8 用于无 XFF 的本机直连与探针。
# 不要使用 0.0.0.0/0。按实际内网网段收窄（下面仅示例）。
PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
# 浏览器访问同一 Origin，相对路径 /v1 不需要 CORS；保持 CORS_ORIGINS 未设置。
PI_MIGRATION_GATE=verify
PI_DATA_MODE=managed
PI_DEFAULT_MODEL=openai-codex/gpt-5.6-luna
PI_DEFAULT_THINKING_LEVEL=medium
# models.json/auth.json（或环境变量）还必须能解析并认证插件固定使用的：
# modelscope/deepseek-ai/DeepSeek-V4.1-Flash
# 用法原理/设计规范 thinkingLevel=medium；需求原型 thinkingLevel=high
MODELSCOPE_API_KEY=<通过受限环境或 secret 注入，不写入 Git>
PI_AGENT_DIR=/var/lib/pi-agent-server/pi-agent
PI_AUTH_PATH=/var/lib/pi-agent-server/pi-agent/auth.json
# 插件入口：裸机用绝对路径（不依赖宿主 node_modules，重装宿主依赖不会丢失）。
# 目标机仍需按 §3.3 在相同路径重建插件 checkout 与 dist。
# 开发期若用 `pnpm link`，此处改为包名 pi-agent-capability-onev（见 §3.5）。
PI_PLUGINS=/srv/pi-agent-capability-onev/dist/index.js

# pi-agent-capability-onev：独立于宿主数据库
ONEV_DATA_DIR=/var/lib/pi-agent-capability-onev
ONEV_DWS_ENABLED=true
ONEV_DWS_BIN=/usr/local/bin/dws
# 可选：仅在要启用对应只读 Pi 工具时配置
ONEV_VUE2_INDEX_BIN=/usr/local/bin/vue2-index
ONEV_GITNEXUS_BIN=/usr/local/bin/gitnexus

# 文档站自动重建：job 成功后插件 POST 本机最简 publisher（见 §6）。
# publisher 只监听 127.0.0.1，无 token；未设置时插件不发送通知，需手工重建。
ONEV_PUBLICATION_WEBHOOK_URL=http://127.0.0.1:9091/publish
```

本方案要求浏览器看到的文档页面和 `/v1` API **协议、主机、端口三者完全相同**；只有主机名相同但端口不同仍属于跨 Origin。ONEV 保持 `window.ONEV_COPILOT_CONFIG.baseUrl` 为空，使用相对路径 `/v1`，不设置 `CORS_ORIGINS`。agent-server 只监听 `127.0.0.1:8080`，由原组件库网站已有的同源部署入口在服务器内部访问；不要把 `8080` 直接暴露给浏览器或公网。

插件也提供可复制的 `.env.example`，但生产环境应使用上述受限环境文件。`ONEV_DATA_DIR` 必须是独立目录，不能把插件数据库放进宿主 `DATA_DIR`；插件注册只打开已迁移到当前 head 的库，不会隐式建库或迁移。

## 3. 首次安装、构建和初始化

### 3.1 准备目录和源码

```bash
sudo install -d -o onev -g onev -m 0755 \
  /srv/pi-agent-server /srv/pi-agent-capability-onev /srv/onev
sudo install -d -o onev -g onev -m 0750 \
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

### 3.5 接入未发布插件（裸机用绝对路径入口；开发期可用 `pnpm link`）

当前插件尚未发布到 npm，**裸机部署不要依赖 `pnpm link`**。原因：`pnpm link <dir>` 在 pnpm 8 下只在 `node_modules` 下建一个 symlink，**既不写 `package.json` 也不写 `pnpm-lock.yaml`**，因此它是一次性的、不可重现的：

| 操作 | `pnpm link` 建立的链接 |
|---|---|
| `pnpm install --frozen-lockfile`（`node_modules` 完好） | 保留 |
| `rm -rf node_modules` 后重装（宿主升级常见） | **丢失** |
| 换机器 / 新 checkout | 本来就不存在 |

链接丢失后，宿主会因 `PI_PLUGINS` 解析不到包而 **fail-fast 拒绝启动**（不会静默降级），但这是不必要的运维中断。

**推荐做法**：把 `PI_PLUGINS` 直接指向插件构建产物的**绝对路径入口**。`PluginSource` 接受任意 ESM specifier，Node 的 `import()` 接受绝对文件路径，因此这条路不经过宿主 `node_modules`，宿主重装依赖不会把它冲掉（换机器后仍需按 §3.1/§3.3 在相同路径恢复 checkout 并重建 `dist`）：

```bash
# 第 2 节环境文件（例如 /etc/pi-agent-server/onev.env）中：
PI_PLUGINS=/srv/pi-agent-capability-onev/dist/index.js
```

插件 `package.json` 的 `exports["."]` 为 `./dist/index.js`，故该路径与按包名导入的是同一个入口。可用宿主自己的加载器验证（不要用裸 `node -e "import(...)"` 代替，那只证明 Node 能解析，不证明宿主 manifest/tools/modes 校验通过）。下面的命令在宿主构建产物上运行，所以需先完成 §3.2：

```bash
cd /srv/pi-agent-server
volta run --node 22.19.0 -- node --input-type=module -e '
const { PluginLoader } = await import("./dist/application/plugins/loader.js");
const loader = new PluginLoader({ projectCwd: process.cwd() });
const loaded = await loader.load("/srv/pi-agent-capability-onev/dist/index.js");
console.log(loaded.manifest.id, loaded.manifest.version, loaded.tools.map((t) => t.name).join(","));
'
```

预期输出 `onev 1 vue2-index,gitnexus`（工具顺序不固定）。然后按 §8 起服务并跑探针。

**开发期备选：`pnpm link`**（仅限本机联调，由操作人手动执行，不要写进部署流程）：

```bash
cd /srv/pi-agent-server
volta run --node 22.19.0 -- pnpm link /srv/pi-agent-capability-onev
volta run --node 22.19.0 -- pnpm list --depth 0
volta run --node 22.19.0 -- node -e \
  "import('pi-agent-capability-onev').then(() => console.log('plugin resolved'))"
```

这条路径要求 `PI_PLUGINS=pi-agent-capability-onev`（包名），并确认宿主 `node_modules/pi-agent-capability-onev` 指向插件 checkout。**每次重建 `node_modules` 后都要重跑 `pnpm link`**，否则服务拒绝启动。它不使用依赖操作者私有 `PNPM_HOME` 的全局 link。

无论哪种方式，插件都是宿主**同进程的受信任代码**，不是独立服务或进程隔离边界；宿主 `package.json` **不声明**对插件的依赖（依赖方向是插件 `peerDependencies` → 宿主）。

## 4. 构建 ONEV 前端静态产物

ONEV checkout 的 `package.json` 将文档站构建固定为 `build:docs`，该命令会**先清空再重新生成** `examples/onev-ui`。它使用 Node.js `16.20.2`，不要用 Node 22 构建：

```bash
cd /srv/onev
unset ONEV_COPILOT_BASE_URL
volta run --node 16.20.2 --yarn 1.22.22 -- yarn install --frozen-lockfile
volta run --node 16.20.2 --yarn 1.22.22 -- yarn build:docs
```

ONEV 的 `yarn.lock` 当前包含内网 registry `http://10.0.0.205:4873`；构建机必须能访问该受控 registry，或在部署前另行交付经过审核、可从受支持 registry 重建的锁文件/离线缓存。

验收时确认 `/srv/onev/examples/onev-ui/index.html` 存在，并由原组件库文档网站既有方式发布该目录（nginx `root` 仍指向该目录，见 §5.1）。构建目录属于前端发布产物，不要把它当成插件数据库或宿主 `DATA_DIR`。

本节是**首次部署的手工构建**。生产运行中，同步成功后的自动重建由 §6 的 publisher 调用**同一条** `volta run --node 16.20.2 --yarn 1.22.22 -- yarn build:docs`；两者命令必须一致。

## 5. 使用原组件库文档网站的同一内网 Origin

ONEV 无需配置独立 API 域名。生产页面继续使用 HTTP 客户端的默认配置：`baseUrl` 为空，所有请求使用 `/v1/...` 相对路径，SSE 也使用同一 Origin。

部署验收必须确认：

1. 浏览器地址栏中的文档站 Origin 与 `/v1` 的 Origin 完全一致（协议、主机、端口均一致）；
2. 本机 nginx 能在服务器内部访问 `127.0.0.1:8080`，并把 `/v1`、`/health`、`/readyz` 暴露在其自身 Origin（配置见下方示例）；
3. 构建时 `ONEV_COPILOT_BASE_URL` 已清空，运行时 `window.ONEV_COPILOT_CONFIG.baseUrl` 未设置或为空字符串，浏览器实际请求相对路径 `/v1`；
4. `CORS_ORIGINS` 未设置，因为不存在浏览器跨 Origin 请求；
5. agent-server 的 `8080` 不直接对内网客户端或公网开放（`HOST=127.0.0.1`，只监听回环）；
6. 原文档网站的访问控制已启用；`PI_ALLOWED_CLIENT_CIDRS` 已覆盖真实用户所在内网网段（nginx 经 XFF 传入的用户 IP 必须能通过 CIDR 准入），并已接受“同一内网 IP 背后的多人共享同一身份、没有终端用户级认证”的边界。

同源路径由本机 nginx 反代接入 agent-server，不再是“由原文档网站既有部署入口负责”。若实际部署只能使用不同端口，必须回到跨 Origin 方案并显式配置 `CORS_ORIGINS`，不能只凭“域名相同”判断为同源。

### 5.1 nginx 同源反代配置示例

生产拓扑是 `浏览器 --HTTPS--> 裸机 nginx --http--> 127.0.0.1:8080`（见 [ADR 0003](decisions/0003-loopback-proxy-client-ip.md)）：**TLS 在 nginx 终止**，agent-server 侧仍是明文 `proxy_pass http://127.0.0.1:8080`（不需要 TLS，也不要 `https://`）。

把文档站静态目录与 `/v1`、`/health`、`/readyz` 放在**同一个 TLS `server` 块**（同一协议/主机/端口，否则浏览器会判为跨 Origin）。若文档站已有承载 HTTPS 的 `server` 块，**应把这些 `location` 合并进该现有块，而不是新建一个 80 端口块**：

```nginx
# 建议：HTTP 仅做跳转，绝不承载文档站或 /v1（否则浏览器拿到 http:// Origin）。
server {
    listen 80;
    server_name onev.internal;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;                              # nginx ≥ 1.25.1；旧版本用 `listen 443 ssl http2;`
    server_name onev.internal;

    # 证书：占位路径，必须替换为现场实际证书（内网亦要求 TLS）。
    ssl_certificate     /etc/nginx/tls/onev.internal.crt;
    ssl_certificate_key /etc/nginx/tls/onev.internal.key;
    # TLS 参数：按现场基线调整（示例值，不是强制要求）。
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    # 文档站静态产物（由 §4 构建得到）
    root /srv/onev/examples/onev-ui;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # /v1 与探针：同源反代到 agent-server（仅监听 127.0.0.1，明文 http）。
    location /v1/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # SSE（/v1/sessions/:id/events）必需：不要缓冲，不要复用连接池 keep-alive。
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection "";
        proxy_read_timeout 1h;

        # 客户端 IP：追加语义（把 $remote_addr 追加到客户端自带 header 之后），
        # agent-server 只取最后一段作为真实用户身份。必须保留该头。
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location = /v1 {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }

    location = /health {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }

    location = /readyz {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }
}
```

说明：

- **必须走 HTTPS**：文档站与 `/v1` 都在 `listen 443 ssl` 的 `server` 块内。若照抄成 `listen 80;`，浏览器会以 `http://` Origin 访问，`/v1` 既可能因混合内容被拦，也可能根本不进入 agent-server；`CORS_ORIGINS` 也应按实际 HTTPS Origin 配置（同源方案下无需设置）。
- **TLS 只终止在 nginx**：`proxy_pass` 保持 `http://127.0.0.1:8080`，不要改成 `https://`（agent-server 不提供 TLS）。
- **`proxy_http_version 1.1` + `proxy_set_header Connection ""`**：HTTP/1.1 与显式空 `Connection` 头是 SSE（`/v1/sessions/:id/events`）必需的；否则 nginx 会用 HTTP/1.0 或保持连接头，导致事件流被缓冲或立即断开。
- **`proxy_buffering off`**：关闭响应缓冲，事件才能实时到达浏览器。
- **`X-Forwarded-For $proxy_add_x_forwarded_for`**：这是**追加**语义（把 `$remote_addr` 追加到客户端自带 header 之后）。agent-server 仅在 TCP 对端为回环（此处为 `127.0.0.1`）时采用 XFF，且**只取最后一段**，因此真实用户 IP 取自 nginx 写入的 `$remote_addr`。必须传该头且保持追加语义；**不要省略该头**（否则所有用户塌缩为 `127.0.0.1` 一个身份）。在本 ADR 的单跳模型下，`$remote_addr` 本身就是真实客户端地址，即使覆盖 XFF 也不会「丢失真实客户端信息」，被丢弃的只是客户端自带、本就不可信的 XFF 链。
- `/health`、`/readyz` 必须与 `/v1` 一样带上 XFF：探针若不带 XFF 会回落到 `127.0.0.1`，只要 `127.0.0.0/8` 在 `PI_ALLOWED_CLIENT_CIDRS` 内仍可正常放行。
- 若 nginx 只监听回环（例如仅通过另一层内网入口访问），务必确保 `$remote_addr` 就是真实用户地址；多跳代理会使最右段变成最后一段代理地址（见 [ADR 0003](decisions/0003-loopback-proxy-client-ip.md) 的单跳限制）。
- `/srv/pi-agent-server`、`/srv/pi-agent-capability-onev`、`/srv/onev` 使用 `0755` 只为让 nginx 能逐级穿越源码目录；数据目录仍保持 `0700`/`0750`。构建后按现场 nginx 用户替换 `www-data` 执行：

  ```bash
  sudo -u www-data test -r /srv/onev/examples/onev-ui/index.html
  ```

  命令成功才表示 nginx 用户能读取入口文件；若现场用户是 `nginx` 等，请替换该用户名。

## 6. 文档站自动重建：最简 HTTP publisher（示例待固化）

§4 的 `build:docs` 每次都会**先清空再重新生成** `examples/onev-ui`。插件在 job 成功后需要一个本机服务来触发重建。本方案选择**最简 HTTP publisher**：不做文件监听，不引入 releases/outbox，不重启宿主、插件或 nginx。

### 6.1 已确认的边界

| 项 | 约定 |
| --- | --- |
| 触发方式 | 插件在 job 成功后 POST `ONEV_PUBLICATION_WEBHOOK_URL`；**不监听文件变化**。该变量由插件侧提供，需以实际交付的插件版本为准 |
| 监听地址 | 仅 `127.0.0.1:9091`，不监听外网 |
| 鉴权 | **无 token**（安全内网，用户明确不要鉴权）；因此必须确保 `9091` 只绑定回环，且宿主防火墙/安全组不转发该端口 |
| 响应语义 | 接收请求后**立即返回 `202`**，构建在后台执行 |
| 构建与并发 | 正常 `spawn` 固定 Volta 命令并等待子进程 `close`；构建期间到达的通知置 `pending=true`，当前构建完成后再构建；非构建期约 1 秒 debounce 合并连续通知 |
| SIGTERM 排空 | 收到 `SIGTERM`/`SIGINT` 后 `server.close()` 停止接收新连接；已接受的 debounce、`pending`、当前 build 和 HTTP 响应全部完成后再退出。systemd 用 `KillMode=mixed` 与 `TimeoutStopSec=75min` 兜底 |
| 请求体上限 | `>64 KiB` 返回 `413` 并带 `Connection: close`。先检查 `Content-Length`；流式超限后**停止收集**（不再缓存），安全排空剩余请求体后再写响应，客户端能稳定读到 `413`，不会先被 `destroy` 成 `ECONNRESET` |
| 文件权限 | unit 用 `UMask=0022`：目录 `755`、文件 `644`，使同机 nginx（通常以 `www-data`/`nginx` 运行）能读取 `examples/onev-ui` 静态产物。**不要**用 `0077`，否则构建产物仅服务账号可读，nginx 会 403/404 |
| 命令安全 | 工作目录、可执行文件、argv 全部硬编码，**从不从请求体拼接 shell**；请求体只做基本 JSON/`event`/`jobId`/`components` 校验，业务字段可忽略 |
| 构建命令 | 固定 `volta run --node 16.20.2 --yarn 1.22.22 -- yarn build:docs`（与 §4 一致） |
| nginx | 不使用 CDN；`root` 仍是 `/srv/onev/examples/onev-ui`；重建只替换磁盘上的静态产物，**不需要 reload/restart nginx、宿主或插件** |
| 可用性 | 接受“构建期间文档站可能短暂不可用”（`build:docs` 先清空 `onev-ui`）。这是内网最简方案的已知取舍，**不引入 releases/outbox 或原子切换** |

> **关键区分**：插件收到的 `2xx` **只表示 publisher 已接受构建请求，不代表 build 已完成**。publisher 的 build 若失败，失败详情写入 journal；**下一次 job 成功通知会再次触发构建**（失败不进入死循环重试，也不阻塞插件）。

### 6.2 publisher 源码（无第三方依赖）

把以下文件保存为 `/srv/onev-publisher/publisher.mjs`，属主设为服务账号（如 `onev`），权限 `0640`：

```javascript
#!/usr/bin/env node
/**
 * ONEV 文档站最简 HTTP publisher（无第三方依赖，只用于内网单机）。
 *
 * 职责：接收 POST /publish，立即返回 202，再在后台串行执行固定构建命令
 *   volta run --node 16.20.2 --yarn 1.22.22 -- yarn build:docs
 *
 * 边界与安全：
 * - 只监听 127.0.0.1:9091，不监听外网；本方案明确不做 token 鉴权。
 * - 构建命令、工作目录、argv 全部硬编码；请求体只用于日志与基本校验，
 *   绝不参与命令拼接，也不经过 shell。
 * - 同一时刻只允许一个 build；构建期间到达的通知记为 pending，
 *   当前 build 结束后再构建，通知不会丢失（1 秒 debounce 合并）。
 * - build 只 spawn 固定 Volta 命令并等待 close；不在脚本内实现构建超时或进程树管理。
 * - SIGTERM 后停止接收新请求，但已接受的 debounce/pending/build 和 HTTP 响应全部排空后才退出。
 * - 本服务只保证“接受构建请求”，不代表构建成功；构建输出写入 journal。
 */
import http from "node:http";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const PORT = 9091;
const PROJECT_DIR = "/srv/onev";
const VOLTA_BIN = "/home/onev/.volta/bin/volta";
const BUILD_ARGV = Object.freeze([
  "run",
  "--node",
  "16.20.2",
  "--yarn",
  "1.22.22",
  "--",
  "yarn",
  "build:docs",
]);
const DEBOUNCE_MS = 1000;
const MAX_BODY_BYTES = 64 * 1024;

let building = false;
let pending = false;
let debounceTimer = null;
let shuttingDown = false;
let inFlightRequests = 0;

function log(event, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`,
  );
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

/** 有 build 在跑就记 pending；否则在 debounce 窗口后触发一次 build。 */
function scheduleBuild(trigger) {
  if (building) {
    pending = true;
    log("publish_coalesced", { trigger, building: true, pending: true });
    return;
  }
  if (debounceTimer !== null) {
    log("publish_debounced", { trigger, debounceMs: DEBOUNCE_MS });
    return;
  }
  log("publish_scheduled", { trigger, debounceMs: DEBOUNCE_MS });
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    startBuild(trigger);
  }, DEBOUNCE_MS);
}

function startBuild(trigger) {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  pending = false; // 本次 build 覆盖此刻之前的所有通知
  const startedAt = Date.now();
  log("build_start", { trigger, cwd: PROJECT_DIR, argv: BUILD_ARGV });

  // 构建环境显式清空 ONEV_COPILOT_BASE_URL（与 §4 的 unset 语义一致），
  // 其余继承 systemd 提供的环境；argv/cwd 均为硬编码常量。
  const buildEnv = { ...process.env };
  delete buildEnv.ONEV_COPILOT_BASE_URL;

  let child;
  try {
    child = spawn(VOLTA_BIN, BUILD_ARGV, {
      cwd: PROJECT_DIR,
      stdio: ["ignore", "inherit", "inherit"],
      env: buildEnv,
    });
  } catch (error) {
    building = false;
    log("build_spawn_error", { trigger, error: String(error?.message ?? error) });
    onBuildFinished();
    return;
  }

  let settled = false;
  const finalize = (code, signal) => {
    if (settled) return;
    settled = true;
    building = false;
    log("build_end", {
      trigger,
      code,
      signal,
      durationMs: Date.now() - startedAt,
    });
    onBuildFinished();
  };

  child.on("error", (error) => {
    log("build_spawn_error", { trigger, error: String(error?.message ?? error) });
    finalize(null, null);
  });
  child.on("close", (code, signal) => finalize(code, signal));
}

/** build 结束后，若构建期间有新通知，再合并触发一次；否则尝试排空退出。 */
function onBuildFinished() {
  if (pending) {
    pending = false;
    log("build_pending_detected", { trigger: "pending-after-build" });
    scheduleBuild("pending-after-build");
    return;
  }
  maybeExitAfterDrain();
}

/** SIGTERM 后，只有所有已接受工作排空且没有在途请求时才退出。 */
function maybeExitAfterDrain() {
  if (!shuttingDown) return;
  if (building || pending || debounceTimer !== null || inFlightRequests > 0) return;
  log("shutdown_complete", {});
  process.exit(0);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    // 必须先接管流错误；即使 Content-Length 预检立即拒绝，随后排空期间的客户端断连
    // 也不能成为未处理的 EventEmitter error 而杀死 publisher。
    req.on("error", fail);

    // 先看 Content-Length：超限直接拒绝，不收集 body、不 destroy，交给上层回 413。
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      fail(Object.assign(new Error("body too large"), { statusCode: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      if (overflow) return; // 超限后停止收集，仅继续排空
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        fail(Object.assign(new Error("body too large"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!overflow && !settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
  });
}

/** 只做基本 JSON/event/jobId/components 校验；返回值仅用于日志。 */
function parseNotification(raw) {
  const text = raw.trim();
  if (text === "") return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { statusCode: 400 });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("body must be a JSON object"), { statusCode: 400 });
  }
  const summary = {};
  if (value.event !== undefined) {
    if (typeof value.event !== "string") {
      throw Object.assign(new Error("event must be a string"), { statusCode: 400 });
    }
    summary.event = value.event;
  }
  if (value.jobId !== undefined) {
    if (typeof value.jobId !== "string") {
      throw Object.assign(new Error("jobId must be a string"), { statusCode: 400 });
    }
    summary.jobId = value.jobId;
  }
  if (value.components !== undefined) {
    const components = Array.isArray(value.components)
      ? value.components
      : [value.components];
    if (components.some((item) => typeof item !== "string")) {
      throw Object.assign(
        new Error("components must be a string or an array of strings"),
        { statusCode: 400 },
      );
    }
    summary.components = components;
  }
  return summary;
}

const server = http.createServer(async (req, res) => {
  inFlightRequests += 1;
  let responseReleased = false;
  const releaseResponse = () => {
    if (responseReleased) return;
    responseReleased = true;
    inFlightRequests -= 1;
    maybeExitAfterDrain();
  };
  // 计数覆盖整个 HTTP 响应生命周期，而不是只覆盖请求处理函数。
  res.once("finish", releaseResponse);
  res.once("close", releaseResponse);

  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { status: "ok", building, pending, shuttingDown });
    return;
  }
  if (url.pathname !== "/publish") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (shuttingDown) {
    // 停止接收新请求；已接受的请求走正常路径排空。
    sendJson(res, 503, { accepted: false, error: "shutting_down" }, { connection: "close" });
    return;
  }

  try {
    const summary = parseNotification(await readBody(req));
    // 先回 202，再安排后台构建；2xx 只表示“已接受构建请求”。
    sendJson(res, 202, { accepted: true, building, queued: !building });
    scheduleBuild(summary.event ?? "webhook");
    // 通知字段嵌在 notification 下，避免覆盖日志自身的 event 键。
    log("publish_accepted", { notification: summary });
  } catch (error) {
    const status = Number(error?.statusCode) || 400;
    log("publish_rejected", { status, error: String(error?.message ?? error) });
    if (status === 413) {
      // 不 destroy：停止收集后安全排空剩余请求体，并用 Connection: close
      // 让客户端稳定读到 413，而不是只看到 ECONNRESET。
      if (!req.complete) req.resume();
      sendJson(res, 413, { accepted: false, error: "body too large" }, { connection: "close" });
    } else {
      sendJson(res, status, { accepted: false, error: String(error?.message ?? error) });
    }
  }
});

server.on("error", (error) => {
  log("server_error", { error: String(error?.message ?? error) });
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log("listening", { host: HOST, port: PORT, projectDir: PROJECT_DIR, argv: BUILD_ARGV });
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", {
    signal,
    building,
    pending,
    debouncePending: debounceTimer !== null,
  });
  // 停止接受新连接；已在途请求继续完成。已接受的 debounce/pending/build 由
  // maybeExitAfterDrain 排空后再退出，不在此处强杀构建。
  server.close();
  if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
  maybeExitAfterDrain();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

设计要点（与上表对应）：

- **通知不丢**：`scheduleBuild` 在 `building` 时只置 `pending=true`；`onBuildFinished` 在 build 结束后检查 `pending` 并再次 `scheduleBuild`。因此两个用户/两个 job 先后到达（即使第二个在第一个 build 期间到达）都会各自触发一次构建。
- **debounce 合并**：非构建期 1 秒内的多次通知只触发一次 build（`debounceTimer` 非空时仅记录日志），避免同一轮同步产生多次冗余构建。
- **无 shell**：只用 `spawn(VOLTA_BIN, BUILD_ARGV, { cwd, env })`，不经过 shell，`argv` 是冻结常量；请求体不会进入命令。
- **SIGTERM 排空**：`shutdown` 只做三件事——置 `shuttingDown`、`server.close()`（不再收新连接）、`maybeExitAfterDrain()`。退出条件为 `!building && !pending && debounceTimer === null && inFlightRequests === 0`，即所有已接受工作排空才 `process.exit(0)`；不会在 debounce/pending 未处理时静默丢弃通知，也不会留下被 systemd 强杀后的空站点。
- **`413` 可观测**：`readBody` 先看 `Content-Length`；流式超限后停止收集并 `req.resume()` 排空剩余数据，再以 `Connection: close` 写 `413`，不调用 `req.destroy()`。
- **`202` 语义**：先 `sendJson(res, 202, ...)` 再 `scheduleBuild(...)`，HTTP 响应与构建解耦；`202` 不承诺构建成功。
- **`/healthz`** 仅用于本机探活，返回 `building`/`pending`/`shuttingDown` 状态。

> **排空与 systemd 的诚实边界**：publisher 自身会等待已接受的 build、pending、debounce 和 HTTP 响应完成才退出。正常 `SIGTERM` 只停止主进程接收新请求并让这些工作排空；`TimeoutStopSec=75min` 到期后，systemd 才发送 `SIGKILL` 到整个 cgroup 兜底。若构建超过这段时间，站点可能停在已清空但未重建的半构建状态，必须重新触发构建。

### 6.3 systemd unit（示例待固化）

把以下内容保存为 `/etc/systemd/system/onev-publisher.service`。`User`/`Group` 必须是能读写 `/srv/onev` 并调用服务账号 Volta 的账号（与 §7 的宿主 unit 保持同一个 `onev`）：

```ini
[Unit]
Description=ONEV docs static-site publisher (loopback HTTP -> build:docs)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=onev
Group=onev
# 工作目录固定为 publisher 脚本所在目录；构建命令内部使用固定 cwd=/srv/onev。
WorkingDirectory=/srv/onev-publisher
# 不加载宿主 `/etc/pi-agent-server/onev.env`：其中包含模型 API key 等宿主凭据，
# publisher 与前端构建都不需要这些变量，避免构建脚本/依赖误读、记录或打包凭据。
ExecStart=/home/onev/.volta/bin/volta run --node 22.19.0 -- node /srv/onev-publisher/publisher.mjs
Restart=on-failure
RestartSec=5
# 正常 TERM 只发给 publisher 主进程；到期后 systemd 再杀整个 cgroup 兜底。
KillMode=mixed
TimeoutStopSec=75min
NoNewPrivileges=true
PrivateTmp=true
# 0022：构建产物目录 755、文件 644，保证同机 nginx 能读取静态站。
UMask=0022

[Install]
WantedBy=multi-user.target
```

说明：

- **运行用户**：`User=onev`、`Group=onev`。不要用 root 运行；该账号必须能访问 `/srv/onev` 与 Volta。
- **Node 版本**：publisher 自身是普通 Node 脚本，用宿主 Node（`22.19.0`）运行即可；`build:docs` 仍由脚本内硬编码的 `volta run --node 16.20.2 --yarn 1.22.22` 执行，不受 publisher 进程的 Node 版本影响。
- **Volta 绝对路径**：`ExecStart` 与脚本内 `VOLTA_BIN` 都要按服务账号实际安装位置修改。
- **不加载宿主 EnvironmentFile**：publisher 只继承 systemd 的最小环境；不要加载含 `MODELSCOPE_API_KEY` 等宿主凭据的 `/etc/pi-agent-server/onev.env`。构建所需 Node/Yarn 版本和工作目录均由固定 argv/cwd 指定。
- **`UMask=0022`（不是 0077）**：构建以服务账号 `onev` 运行，`build:docs` 重新生成 `examples/onev-ui` 时会按 umask 创建目录/文件。`0022` 得到目录 `755`、文件 `644`，同机 nginx（通常以 `www-data`/`nginx` 运行）才能读取静态站。若用 `0077`，产物只有 `onev` 可读，nginx 会返回 403/404——这是本次修复的一个重点。
- **源码与服务账号权限**：`publisher.mjs` 只需服务账号可读（`0640`，属主 `onev`），无需可执行；`/srv/onev-publisher` 目录 `0750`。构建所需的源码（`/srv/onev`）必须由 `onev` 拥有或至少可读写（`build:docs` 会先清空再重建 `examples/onev-ui`）。nginx 与 `onev` **不要**共享登录账号：nginx 只读 `examples/onev-ui`，靠 `0022` 的全局可读位访问，不需要加入 `onev` 组，也不需要放宽 `/srv/onev` 的属主权限。
- **`KillMode=mixed` + `TimeoutStopSec=75min`**：正常 `systemctl stop` 的 TERM 只发给 publisher 主进程，脚本排空已接受的 debounce、pending、当前 build 和 HTTP 响应；75 分钟后 systemd 发送 `SIGKILL` 到整个 cgroup 兜底。兜底可能留下半构建站点，需重新触发 `/publish` 或按 §4 手工重建。

### 6.4 部署、启停与日志

```bash
sudo install -d -o onev -g onev -m 0750 /srv/onev-publisher
# 将 §6.2 的 publisher.mjs 放到该目录，属主 onev，权限 0640
sudo chown onev:onev /srv/onev-publisher/publisher.mjs
sudo chmod 0640 /srv/onev-publisher/publisher.mjs

# 语法自检（用宿主 Node 即可）
volta run --node 22.19.0 -- node --check /srv/onev-publisher/publisher.mjs

sudo systemctl daemon-reload
sudo systemctl enable --now onev-publisher.service
sudo systemctl status onev-publisher.service

# 查看日志（构建输出也走 stdout/stderr -> journal）
sudo journalctl -u onev-publisher.service -n 100 --no-pager
sudo journalctl -u onev-publisher.service -f

# 停止 / 重启
sudo systemctl stop onev-publisher.service
sudo systemctl restart onev-publisher.service
```

**注意**：修改 publisher 源码或 unit 后，只需 `systemctl daemon-reload && systemctl restart onev-publisher.service`；**不要**因此重启宿主、插件或 nginx。

### 6.5 curl 验收

```bash
# 1) 探活：预期 HTTP 200 与 {"status":"ok","building":false,"pending":false}
curl --fail --silent --show-error http://127.0.0.1:9091/healthz

# 2) 触发构建：预期立即返回 HTTP 202，body 含 "accepted":true
curl --silent --show-error -o /dev/null -w 'HTTP %{http_code}\n' \
  -X POST -H 'content-type: application/json' \
  -d '{"event":"sync.succeeded","jobId":"manual-check","components":["button"]}' \
  http://127.0.0.1:9091/publish

# 3) 观察后台构建（等待数分钟后确认 build_end code=0）
sudo journalctl -u onev-publisher.service -n 50 --no-pager | grep -E 'publish_accepted|build_start|build_end'

# 4) 确认产物确实重建（mtime 应刷新）
stat -c '%y %n' /srv/onev/examples/onev-ui/index.html
```

验收要点：

- 第 2 步返回 `202` 只证明 **publisher 接受了构建请求**；必须等 journal 出现 `build_end ... code=0`，并用第 4 步的 `mtime` 或浏览器刷新确认页面已更新。
- 并发/合并验证：连续两次 POST（第二次在第一次 build 期间）后，journal 应出现两次 `build_start`；若两次在同一 debounce 窗口内，则只出现一次。无论哪种，**通知都不会丢失**。
- 请求体上限验证：`curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' --data-binary @<(head -c 70000 /dev/zero) http://127.0.0.1:9091/publish` 应稳定打印 `413`（而不是 `000`/连接重置）；journal 对应 `publish_rejected status=413`。

### 6.6 故障排查

| 现象 | 排查 |
| --- | --- |
| 插件同步成功但页面不更新 | 先确认 `ONEV_PUBLICATION_WEBHOOK_URL` 已在宿主环境文件设置并生效（插件在 job 成功后读取）；再查 `journalctl -u onev-publisher.service` 是否收到 `publish_accepted` |
| `curl /healthz` 连接被拒 | `systemctl status onev-publisher.service`；确认 `listen` 日志为 `127.0.0.1:9091`，端口未被占用（`ss -ltnp 'sport = :9091'`） |
| `build_start` 后无 `build_end` | publisher 正在等待固定 Volta 命令退出；检查 `yarn build:docs` 是否卡在内网 registry `http://10.0.0.205:4873` 不可达。停止服务时由 systemd 的 75 分钟 cgroup 兜底结束 |
| `systemctl stop` 后留下半构建站点 | 这是 75 分钟兜底 `SIGKILL` 可能造成的结果；重新触发 `/publish` 或按 §4 手工重建 |
| `build_end code` 非 0 | **构建失败不代表 publisher 故障**；失败详情在 journal，下一次 job 成功通知会再次触发构建。常见原因：Node/Yarn 版本不对、`yarn.lock` registry 不可达、磁盘满 |
| `build_spawn_error` | `VOLTA_BIN` 路径错误或不可执行；确认 `/home/onev/.volta/bin/volta` 存在且 `onev` 可执行 |
| `publish_rejected` 400/413 | 请求体不是合法 JSON 对象、字段类型不符或超过 64 KiB；这属于**通知方 bug**，正常插件通知不会触发。`413` 会先停止收集、排空剩余体并以 `Connection: close` 写出，客户端能读到响应 |
| 文档站 403/404（构建已成功） | 检查 unit 是否为 `UMask=0022`：若为 `0077`，`examples/onev-ui` 目录/文件仅 `onev` 可读，nginx 无权读取；修正后重建一次 |
| `systemctl stop` 后站点长时间不更新 | publisher 正在排空已接受的 build 和 HTTP 响应（正常）；确认 unit 使用 `KillMode=mixed`、`TimeoutStopSec=75min`，不要手工 `kill -9` 跳过排空 |
| 构建期间页面 404/空白 | `build:docs` 会先清空 `examples/onev-ui`，**这是已接受的短暂不可用**；等 `build_end code=0` 后刷新即可 |
| 需要立即重建 | 可手工执行 §4 的命令，或再次 POST `/publish`；不要用文件监听替代 |

## 7. systemd 托管（示例待固化）

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

## 8. 启动和验收

### 8.1 手动前台启动

在 systemd unit 尚未固化前，可用同一个环境文件前台启动验证。`dist/main.js` 使用已构建的宿主，以及环境文件 `PI_PLUGINS` 指定的已构建插件入口：

```bash
cd /srv/pi-agent-server
set -a
. /etc/pi-agent-server/onev.env
set +a
volta run --node 22.19.0 -- node dist/main.js
```

不要用 `pnpm dev:real` 作为生产托管命令；它是开发启动入口。

### 8.2 基本探针

```bash
curl --fail --silent --show-error http://onev.internal/health
curl --fail --silent --show-error http://onev.internal/readyz
```

预期：`/health` 返回 HTTP 200 和 `{"status":"ok"}`；`/readyz` 返回 HTTP 200 且 `ready` 为 `true`。若 `/readyz` 为 503，先查宿主 migration verify、数据库路径、插件注册错误和 journal，不要反复重启掩盖根因。

### 8.3 绑定和同步 smoke

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
3. 确认项目目录出现 `examples/docs/zh-CN/<组件名>_desc.md`，有图片时确认 `examples/assets/dingtalk/<组件名>/` 下有对应产物；UI 本轮只验收绑定与同步状态。
4. **自动重建验收**：job 成功后，若已按 §6 部署 publisher 并设置 `ONEV_PUBLICATION_WEBHOOK_URL=http://127.0.0.1:9091/publish`，插件会自动 POST 通知 publisher；确认 journal 出现 `publish_accepted` 与 `build_end ... code=0`，并刷新浏览器确认页面内容已更新。插件拿到的 `2xx` **只表示 publisher 已接受构建请求，不代表 build 已完成**；若 publisher 的 build 失败（`build_end` 非 0），详情写入 journal，**下一次 job 成功通知会再次触发构建**。未部署 publisher 时（未设置该变量）页面不会自动更新，需按 §4 手工重建；无论哪种情况，都不要把 job 成功直接等同于页面内容已经发布。
5. 若绑定或同步返回 401/403，检查 IP-RBAC 与 Bearer token；若同步返回 503，检查 `ONEV_DWS_ENABLED`、`ONEV_DWS_BIN`、DWS 凭据和 project/dataDir ownership。不要把 503 当成成功证据。

探针与绑定/同步 smoke 通过后，才可以把本机验收记录连同助手阶段的 P8 最终证据归档。首次空库不要求恢复演练；后续有数据的备份/恢复验收另按运维文档执行。

## 9. 常见误区

- 不要运行 Docker/Podman，也不要把仓库现有的容器演练文档当成裸机部署实现。
- 不要把插件 `onev.db` 与宿主 `pi-agent-server.db` 合并；新机器必须分别初始化宿主 baseline 和插件 v8。
- 不要从 npm registry 安装一个声称已发布的 `pi-agent-capability-onev`；当前正确方式是插件源码构建后用**绝对路径入口**接入（§3.5）。
- 不要把裸机部署的插件接入建立在 `pnpm link` 上：它不写 `package.json`/lockfile，`rm -rf node_modules` 后重装即丢失，服务会拒绝启动。`pnpm link` 只用于开发期本机联调。
- 不要让宿主 `package.json` 声明对插件的依赖：依赖方向是插件 `peerDependencies` → 宿主，反转会破坏公开插件边界。
- 不要用 Node 16 启动宿主/插件，也不要用 Node 22 构建 ONEV `build:docs`。
- 不要把 publisher 监听到 `0.0.0.0` 或转发 `9091`：它无 token 且会执行构建，必须只绑定 `127.0.0.1`（§6.1）。
- 不要把请求体拼进构建命令：publisher 只使用硬编码的 argv/cwd，请求体仅做基本校验（§6.1）。
- 不要因为 publisher 的 `2xx` 就认为 build 已完成或已发布：`2xx` 只表示“已接受构建请求”，成功与否看 journal 的 `build_end`（§6.1、§6.5）。
- 不要为自动重建重启宿主、插件或 nginx：重建只替换 `/srv/onev/examples/onev-ui` 静态产物，nginx 继续使用同一 `root`，无需 reload（§6.1）。
- 不要给 publisher 用 `UMask=0077`：构建产物会变成仅 `onev` 可读，nginx 返回 403/404；应用 `0022`（目录 755、文件 644）（§6.1、§6.3）。
- 不要在 publisher 脚本内添加构建超时、子进程树管理或强杀逻辑：正常构建只 spawn 固定 Volta 并等待 `close`；systemd 的 `KillMode=mixed` 与 `TimeoutStopSec=75min` 是唯一的最终兜底（§6.1、§6.2、§6.3）。
- 不要在 `SIGTERM` 时直接退出或强杀构建：publisher 会停止收新请求并排空已接受的 debounce/pending/build 及 HTTP 响应；75 分钟兜底强杀后若留下半构建站点，必须重新构建（§6.1、§6.3）。
- 不要在超限时先 `req.destroy()` 再声称返回 `413`：应先停止收集、安全排空并带 `Connection: close` 写出 `413`，否则客户端只会看到 `ECONNRESET`（§6.1、§6.2）。
- 不要声称 publisher 或 systemd unit 已经固化；§6 的源码、unit 与 §7 的 unit 都标记为“示例待固化”，需按现场实际路径/账号调整后审核。
- 不要在服务启动时期待自动 migration；两套数据库都应在首次启动前显式迁移并验证。
- 不要声称 systemd unit 或 nginx 配置已经固化；本文件中的 systemd 与 nginx 配置都标记为“示例待固化”，需按现场实际路径/网段调整后审核。
