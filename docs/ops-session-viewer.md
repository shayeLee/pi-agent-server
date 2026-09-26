# 运维会话查看器（独立、只读）

`src/ops-viewer-main.ts` 提供一个独立 Web 界面：按 IP 列出会话，点击查看用户、助手消息和可展开的系统提示词。消息使用现有 `web/src/components/Markdown.tsx` 的 ReactMarkdown + GFM 渲染（不解释用户输入里的原始 HTML）。不展示思考块、工具调用/结果、图片或无文本的失败重试。会话正文使用 Pi JSONL 只读导出投影；SQLite 存索引和创建时冻结的系统提示词。它不挂载在 `/v1` 公共 API，也不改变原有按 owner 隔离的行为。

**安全边界：查看器没有应用层鉴权，任何能连接监听端口的人都能读取所有 IP 的会话正文。** 仅监听 `127.0.0.1:18082`，运维人员只能通过 SSH 隧道访问；不得向内网或公网开放，也不要配置其他监听地址。界面只有 GET 路由，数据库以只读连接打开，既不写数据库也不写 JSONL。使用专用低权限服务账号运行，不要以 root 运行。

## 运行

使用与服务一致的 Node.js 22.22.3 及以上版本。以下示例沿用 [operations.md](operations.md) 的服务账号、源码目录和数据目录；编译后单独启动（**无需重启 pi-agent-server**）：

```sh
cd /srv/pi-agent-server
pnpm exec tsc -p tsconfig.build.json
cd web && pnpm run build:ops-viewer && cd ..
OPS_VIEWER_DB_PATH=/var/lib/pi-agent-server/pi-agent-server.db \
OPS_VIEWER_DATA_DIR=/var/lib/pi-agent-server \
  <NODE_BIN_ABSOLUTE> dist/ops-viewer-main.js
```

将 `<NODE_BIN_ABSOLUTE>` 替换为目标主机上实际 Node.js 二进制的绝对路径；可用 `node -p 'process.execPath'` 查询，并确认 `agent-server` 账号可穿越该路径且可执行。不要把占位符原样运行。`OPS_VIEWER_DB_PATH` 与 `OPS_VIEWER_DATA_DIR` 是查看器必需配置，分别对应数据库文件及服务的 `DATA_DIR`。实现支持 `OPS_VIEWER_HOST`、`OPS_VIEWER_PORT`（默认 `127.0.0.1`、`18082`）；保持默认值，不要设置 `OPS_VIEWER_HOST`，以确保仅供 SSH 隧道访问。

浏览器通过 SSH 隧道访问：

```sh
ssh -L 18082:127.0.0.1:18082 <运维账号>@<服务器地址>
# 本机打开 http://127.0.0.1:18082/
```

systemd 独立服务示例（不接触原服务；Node 路径须替换为实际绝对路径）：

```ini
[Unit]
Description=Read-only ops session viewer
After=pi-agent-server.service
[Service]
User=agent-server
Group=agent-server
WorkingDirectory=/srv/pi-agent-server
Environment=HOME=/var/lib/pi-agent-server
Environment=OPS_VIEWER_DB_PATH=/var/lib/pi-agent-server/pi-agent-server.db
Environment=OPS_VIEWER_DATA_DIR=/var/lib/pi-agent-server
ExecStart=<NODE_BIN_ABSOLUTE> /srv/pi-agent-server/dist/ops-viewer-main.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
UMask=0077
[Install]
WantedBy=multi-user.target
```

`ExecStart` 直接执行 Node 二进制，不经包装器；将 `<NODE_BIN_ABSOLUTE>` 替换为上文查得、对 `agent-server` 可执行的实际绝对路径。服务启动时不需要额外环境变量；不得添加未由查看器实现支持的配置。

## 路由与限制

- `/`：按 IP、会话浏览 Markdown 聊天文本，系统提示词默认折叠、按需展开；静态资源来自独立的 `web/dist-ops-viewer`。
- `GET /api/ips`：IP 与会话数。
- `GET /api/sessions?ip=<IP>&offset=0`：按更新时刻倒序，每页 50 条。
- `GET /api/sessions/<uuid>`：用户/助手原始 Markdown 文本与创建时冻结的 `systemPrompt`；不输出工具、图片二进制与上游错误正文。
- 非 GET 返回 405。所有响应禁缓存；内容错误只返回通用提示，不回显磁盘路径。
- 暂仅支持当前 SQLite 部署的 Pi JSONL v3；PostgreSQL 部署需另加只读数据适配器。无会话文件时显示空记录；文件损坏/读取过程中改变时返回 503。

## 验证

在仓库根目录运行查看器后端测试；然后运行 Markdown 组件测试：

```sh
pnpm exec vitest run tests/ops-viewer.test.ts
cd web && pnpm run test -- src/components/Markdown.test.tsx
```
