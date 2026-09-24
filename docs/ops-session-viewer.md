# 运维会话查看器（独立、只读）

`src/ops-viewer-main.ts` 提供一个不需要应用层鉴权的独立 Web 界面：按 IP 列出会话，点击查看用户、助手消息和可展开的系统提示词。消息使用现有 `web/src/components/Markdown.tsx` 的 ReactMarkdown + GFM 渲染（不解释用户输入里的原始 HTML）。不展示思考块、工具调用/结果、图片或无文本的失败重试。会话正文使用宿主现有的 Pi JSONL 只读导出投影（当前分支）；SQLite 存索引和创建时冻结的系统提示词。它不挂载在 `/v1` 公共 API，也不改变原有按 owner 隔离的行为。

**安全边界：任何能连接监听端口的人都能读取所有 IP 的会话正文。** 默认仅监听 `127.0.0.1:18082`；运维人员通过 SSH 隧道访问。如果一定要直接向内网开放，必须先在主机防火墙/反向代理中将来源限制为运维网段，不能仅因“内网”就绑定 `0.0.0.0`。界面只有 GET 路由，数据库以只读连接打开，既不写数据库也不写 JSONL。

## 运行

使用与服务一致的 Node 22.22.3。编译后单独启动（**无需重启 pi-agent-server**）：

```sh
cd /srv/pi-agent-server
volta run --node 22.22.3 -- pnpm exec tsc -p tsconfig.build.json
cd web && volta run --node 22.22.3 -- pnpm run build:ops-viewer && cd ..
OPS_VIEWER_DB_PATH=/data/onev/pi-agent-server/pi-agent-server.db \
OPS_VIEWER_DATA_DIR=/data/onev/pi-agent-server \
  volta run --node 22.22.3 -- node dist/ops-viewer-main.js
```

可选 `OPS_VIEWER_HOST`、`OPS_VIEWER_PORT`（默认 `127.0.0.1`、`18082`）。使用 `onev` 账户运行，以确保对 JSONL 的读取权限和最小权限；请勿以 root 运行。浏览器通过 SSH 隧道访问：

```sh
ssh -L 18082:127.0.0.1:18082 onev@<服务器地址>
# 本机打开 http://127.0.0.1:18082/
```

systemd 独立服务示例（不接触原服务）：

```ini
[Unit]
Description=Read-only ops session viewer
After=pi-agent-server.service
[Service]
User=onev
Group=onev
WorkingDirectory=/srv/pi-agent-server
Environment=HOME=/home/onev
Environment=VOLTA_HOME=/home/onev/.volta
Environment=PATH=/home/onev/.volta/bin:/usr/local/bin:/usr/bin:/bin
Environment=OPS_VIEWER_DB_PATH=/data/onev/pi-agent-server/pi-agent-server.db
Environment=OPS_VIEWER_DATA_DIR=/data/onev/pi-agent-server
ExecStart=/home/onev/.volta/bin/volta run --node 22.22.3 -- node /srv/pi-agent-server/dist/ops-viewer-main.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
UMask=0077
[Install]
WantedBy=multi-user.target
```

## 路由与限制

- `/`：按 IP、会话浏览 Markdown 聊天文本，系统提示词默认折叠、按需展开；静态资源来自独立的 `web/dist-ops-viewer`。
- `GET /api/ips`：IP 与会话数。
- `GET /api/sessions?ip=<IP>&offset=0`：按更新时刻倒序，每页 50 条。
- `GET /api/sessions/<uuid>`：用户/助手原始 Markdown 文本与创建时冻结的 `systemPrompt`；不输出工具、图片二进制与上游错误正文。
- 非 GET 返回 405。所有响应禁缓存；内容错误只返回通用提示，不回显磁盘路径。
- 暂仅支持当前 SQLite 部署的 Pi JSONL v3；PostgreSQL 部署需另加只读数据适配器。无会话文件时显示空记录；文件损坏/读取过程中改变时返回 503。

验证：`volta run --node 22.22.3 -- pnpm exec vitest run tests/ops-viewer.test.ts`，以及 `cd web && volta run --node 22.22.3 -- pnpm run test -- src/components/Markdown.test.tsx`。
