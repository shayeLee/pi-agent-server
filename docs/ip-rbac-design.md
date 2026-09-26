# IP 访问控制

服务按**客户端 IP**识别用户：只有来源 IP 落在管理员允许的网段内才能连接；通过网段检查后，
角色决定该 IP 能访问哪些功能。未单独配置的 IP 默认是 `user`。同一 IP 共用一个身份；IP 改变就会
成为新身份，权限画像和资源归属也随之改变。

## 管理员配置

1. 必须设置 `PI_ALLOWED_CLIENT_CIDRS`，以逗号分隔规范 CIDR 网段；无默认值，缺失或格式错误会阻止
   启动。CIDR 必须使用规范网络地址和前缀，例如 `192.0.2.0/24` 或 `2001:db8:1::/64`；不能写带
   主机位的网段或重复项。IPv4-mapped IPv6 地址会归一为 IPv4。
2. `PI_IP_ACCESS_POLICY_FILE` 可选；需要为特定 IP 设置角色、禁用访问或要求 token 时，指定绝对路径的
   JSON 文件。策略中的 `ip` 是精确 IP 地址（不是 CIDR），且每个地址必须包含在允许网段中。
3. 以下是格式示例，`203.0.113.7` 和 `198.51.100.8` 均为文档示例地址；token hash 仅示范格式，
   部署时应替换成真实 Bearer token 的 SHA-256：

```dotenv
PI_ALLOWED_CLIENT_CIDRS=198.51.100.0/24,203.0.113.0/24
PI_IP_ACCESS_POLICY_FILE=/etc/pi-agent-server/ip-access-policy.json
```

```json
{
  "version": 1,
  "ips": [
    {
      "ip": "203.0.113.7",
      "role": "admin",
      "tokenRequired": true,
      "tokens": ["sha256:8e8a5519b6fef23f5c0149e37c6242a3785179a27658a959d72081650b7d9be2"]
    },
    {
      "ip": "198.51.100.8",
      "disabled": true
    }
  ]
}
```

策略文件是严格 JSON：顶层为 `version: 1` 和非空 `ips`；每条策略只接受 `ip`、`role`、`disabled`、
`tokenRequired`、`tokens`。角色为 `admin`、`user`、`viewer`、`operator` 之一，省略时为 `user`。
`disabled: true` 条目只能包含 `ip` 和 `disabled`，不能同时设置角色或 token。启用 `tokenRequired`
必须提供非空 `tokens`；每项必须是 `sha256:` 加 64 位小写十六进制，且全文件唯一（一个 hash 只绑定
一个 IP）。未启用 token 时不得提供 `tokens`。错误配置会阻止启动，不会部分加载。

策略文件必须是普通文件、非符号链接且只有一个硬链接；属主必须是当前有效用户（euid）或 root。
权限位不得授予 group/world（`mode & 077 == 0`，建议 `0600` 或 `0400`；`0640` 不合格），文件最大
1 MiB。文件还必须能被运行服务的账号读取：服务以非 root 账号运行时，可设为该账号所有、`0600`。
保存配置后**重启服务**生效；策略不会热更新。

## 请求如何通过认证

- 通常使用 TCP 连接的直接对端 IP。只有直接对端是回环地址（`127.0.0.0/8` 或 `::1`）时才信任
  `X-Forwarded-For`，并且只取最右一项；缺失或无效时回退到对端 IP。非回环连接一律忽略该请求头。
- 回环反向代理必须把实际客户端 IP 写入可信的最右一项，不能让客户端伪造的值成为末项。该规则只
  适用于同机代理，不会信任任意远端发送的转发头。
- IP 不在允许 CIDR 中、被策略禁用或无法解析时返回 `403`；Bearer token 缺失或不匹配时返回 `401`。
  token 只以 `sha256:<hex>` 形式存于策略，不保存明文；哈希和明文都不得写入日志或请求上下文。
  token 不会改变 IP 的角色。
- 未登记且位于允许网段内的 IP 默认 `user`、无需 token。策略启用 token 后，`/v1` 和 `/metrics` 的
  实际请求需要该 IP 绑定的 Bearer token；CORS 预检免 token。仅插件明确登记的公开静态资源 GET 有有限的免 token 例外，仍需通过 IP 准入和只读权限检查。
- `/health`、`/readyz` 是探针：任何通过 IP 准入的来源都可访问，不要求 token 或特定角色。
  修改允许网段或策略文件后需重启服务；客户端 IP 变化不需要重启，但会被当成新身份。

## 角色权限

| 角色 | `/health`、`/readyz` | `/metrics` | `/v1` | 插件路由档位 |
| --- | --- | --- | --- | --- |
| `viewer` | 允许 | 拒绝 | 只读 GET（含会话事件/SSE、导出和访问能力） | `read` |
| `user` | 允许 | 拒绝 | 常规读写 | `read`、`write` |
| `operator` | 允许 | 允许 | 拒绝 | 拒绝 |
| `admin` | 允许 | 允许 | 常规读写 | `read`、`write`、`admin` |

`admin` 仍只能访问自己的项目和会话，不能跨 IP/owner 访问他人资源。每条真实路由都按显式权限检查；
未声明或不允许的操作默认拒绝。

插件路由声明的 `access` 是单一档位 `read`、`write` 或 `admin`；插件 handler 使用
`context.capabilities: { read, write, admin }` 获取本次调用的档位布尔值。

`GET /v1/access` 返回本服务的读写权限，响应只有 `{ "canRead": boolean, "canWrite": boolean }`：
`canRead` 对 `viewer`、`user`、`admin` 为真，`canWrite` 对 `user`、`admin` 为真。它不同于插件路由的
`access` 档位；插件自己的 `/v1/capabilities/<plugin-id>/access`（如已声明）则投影该插件声明的能力标记。

## 安全边界

IP-RBAC 只控制网络准入和 HTTP 路由权限，**不是沙箱**：不会限制 Agent 的工作目录、文件路径、工具或
进程的 OS 权限；这些仍由运行服务的操作系统账号和部署隔离措施决定。此服务禁止直接暴露到公网。

实现依据：[CIDR 配置](../src/core/ip-access-config.ts)、[策略解析](../src/core/ip-access-policy.ts)、
[策略文件安全加载](../src/core/ip-access-policy-file.ts)、[HTTP 准入](../src/server/network-admission.ts)、
[路由权限矩阵](../src/server/route-rbac.ts)。
