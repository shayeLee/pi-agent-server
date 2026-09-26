# ADR 0003：同机代理场景下的客户端 IP 解析（回环 + X-Forwarded-For 最右）

- **状态**：已接受（当前适用）
- **日期**：2026-09-19
- **取代**：部分取代 [ip-rbac-design.md](../ip-rbac-design.md) §2 冻结决策第 1 条（原文为「身份以直接 socket IP 为准，不使用 `X-Forwarded-For`」）；该设计文档其余章节不变。

## 背景

生产拓扑已确定为：浏览器 `--HTTPS-->` 裸机 nginx `--http-->` `127.0.0.1:8080`（pi-agent-server）。agent-server 看到的 TCP 对端恒为 `127.0.0.1`，于是「身份 = 直接 socket 对端 IP」把全部用户塌缩为同一个身份（同一个 `owner_key = ip:127.0.0.1`），会话归属与 per-IP 画像全部失效。

原文冻结决策是在「浏览器直连 agent-server」的假设下写的。该假设不再成立，需要在不引入账号体系的前提下恢复 per-用户身份。

## 决策

### 1. 仅当 TCP 对端为回环时才采用 X-Forwarded-For

- 对端为回环（`127.0.0.0/8` 或 `::1`）且请求带 `X-Forwarded-For`：只取**最后一条**（最右段），经 `parseIpStrict` canonical 化后作为客户端 IP。
- 末段为空字符串、纯空白或不可解析时**整体回落** socket 对端 IP，**不向左搜索**可解析段。理由：在 nginx `$proxy_add_x_forwarded_for` 的追加语义下，最右段恒为 nginx 写入的合法 `$remote_addr`；末段不可解析说明请求未正常经过同机代理，此时左侧任意条目都是客户端可控值，采用它会破坏身份边界。
- 其余情况（对端非回环、XFF 缺失、XFF 空白/仅逗号）同样回落到 socket 对端 IP，行为与变更前完全一致。
- 回落而非 fail-closed：本机直连 `curl 127.0.0.1:8080/health` 与存活/就绪探针不带 XFF，fail-closed 会打断它们；回落到 socket IP 不会比现状更差。

「仅回环」不需要任何新配置即成立：生产 `HOST=127.0.0.1`，只有同机进程能连。这条边界同时防止将来有人把 `HOST` 改成 `0.0.0.0` 时，内网任意机器直连并伪造 XFF 冒充他人。**这不是防伪造机制**，只是「同机代理」的边界；内网场景不考虑 XFF 伪造（见「限制」）。

### 2. 取最右一条是正确解析，不是防伪造机制

nginx 的 `$proxy_add_x_forwarded_for`（以及 http-proxy-middleware）是**追加**语义：把直连对端地址追加到客户端自带 header 之后。因此：

- **最左段**是客户端可控的原值（`curl -H 'X-Forwarded-For: <任意IP>'`）；
- **最右段**才是直连代理写入的真实地址。

取最左是解析错误：同事用一行 curl 就能冒充任意内网 IP 读走别人的会话。这与「是否内网」无关，因此即使明确不做防伪造，也必须取最右。

### 3. 不新增环境变量、不引入可信代理网段配置

不在本 ADR 中引入 `PI_TRUSTED_PROXY_CIDRS` 之类的可配置信任列表，也不做 CIDR 一致性校验、威胁模型论证或防伪造机制。回环判定是唯一规则，无需配置。

## 影响与后果

- **恢复 per-用户身份**：同机 nginx 反代下，`X-Forwarded-For` 最右段成为身份与 `owner_key`，per-IP 画像（role/disabled/tokenRequired）重新可用。
- **回环对端的既有语义变更**：`127.0.0.1` 直连若**带** XFF，身份不再是对端 IP 而是 XFF 最右段。本机直连/探针不带 XFF，行为不变；但同机脚本若主动设置 XFF 会改变自身身份，这是预期行为。
- **非回环对端行为完全不变**：既有测试断言（对端 `10.0.0.1` 携带 XFF 仍按对端 IP）继续成立。
- **单跳限制**：该解析假设 **agent-server 前面只有一跳可信代理**（同机 nginx）。若未来出现多跳代理、CDN 或代理链，最右段将变成「最后一段代理」而不是真实客户端，需要重新设计（例如可配置信任链长度或网段）。当前拓扑下不构成问题。
- **不做伪造防护**：内网场景不考虑 XFF 伪造；将来公网暴露时由账号体系（OIDC/IAM，见 [identity-access-plan.md](../archive/identity-access-plan.md)）取代 IP 身份，而不是在本层加固。公网暴露仍然禁止。

## 关联文档

- [IP Access Policy 设计](../ip-rbac-design.md)：§2 冻结决策第 1 条已按本 ADR 改写；§4 解析流程图含该分支。
- [当前生产反向代理运维说明](../operations.md)。
- [身份与访问管理规划（未来公网方案）](../archive/identity-access-plan.md)
- [ADR 0002：Canonical baseline bootstrap 与 migration 启动门禁](0002-canonical-baseline-and-migration-gate.md)
