# 核心数据流与 TDD 骨架

> 本文定义 pi-server 的核心数据流、解耦原则与 TDD 纪律，是 README 需求基线到实现的桥梁。实现与测试以本文为准；需求变更先改 README，再同步本文。
>
> 注意：本文**不预先规定**模块划分、目录结构或文件命名——这些在 TDD 的 Red→Green→Refactor 循环中自然涌现。

## 1. 核心数据流

### 1.1 主链路（一次 `messages` 请求）

```text
客户端 POST /v1/sessions/:id/messages
  │  (Bearer Token + requestId)
  ▼
① 鉴权          Token 校验（接入鉴权）
  ▼
② 身份识别      UserIdentity（内网 IP / 公网账号）
  ▼
③ 会话归属      该会话 owner == 该用户？（否则 403/404）
  ▼
④ 幂等去重      requestId 已处理过？→ 返回原结果
  ▼
⑤ 状态机        idle？→ 否则 409
  ▼
⑥ 并发控制      全局/每用户上限 → 放行或排队（queued）
  ▼
⑦ Agent 执行    Pi SDK session.prompt()
  ▼
⑧ 事件翻译      SDK 事件 → SSE（text_delta/tool_start/...）
  ▼
⑨ 持久化        JSONL（Pi 写）+ 服务库（索引/状态/元数据）
```

### 1.2 控制链路（旁路，streaming 期间）

```text
steer      → ⑤ 校验（streaming）→ ⑦ session.steer()
follow-up  → ⑤ 校验（streaming）→ ⑦ session.followUp()
abort      → ⑤ 校验（queued/streaming）→ ⑦ session.abort() → 确认终止/超时隔离 → ⑥ 释放槽位
```

### 1.3 后台链路（独立于 Agent 对话）

```text
同步/构建/部署请求 → Worker Job 持久化队列 → 按 Worker 并发数消费 → 状态机/幂等/重试
```

后台链路与主链路解耦：Agent 对话不直接触发副作用，写仓库（直接推分支）、构建、部署等由 Worker 执行。

## 2. 解耦原则

核心数据流是骨架，外部依赖必须与它解耦：

1. **纯逻辑优先隔离**：①②③④⑤⑥ 是纯逻辑（无 IO），必须先做到零外部依赖，可独立单元测试。
2. **外部依赖经接口接入**：Pi SDK、SQLite、HTTP 这三类外部依赖，通过**可替换的接口**接入核心逻辑；单元测试用 mock 替换，不碰真实 SDK、真实数据库、真实网络。
3. **依赖方向单向**：核心逻辑不得依赖任何外部实现；外部实现通过接口被核心调用（依赖倒置）。
4. **模块边界在重构中涌现**：不预先规划目录和文件，当一段逻辑变得内聚、需要复用、或测试暴露重复时，才提取边界。

## 3. TDD 骨架

### 3.1 迭代顺序（按数据流环节，纯逻辑优先）

1. 状态机（⑤）
2. 并发控制（⑥）
3. 幂等去重（④）
4. 身份识别（②）
5. 存储（③⑨，SQLite 集成测试）
6. 事件翻译（⑧，SDK 事件 → SSE 事件映射）
7. Agent 执行适配（⑦，mock Pi SDK）
8. 鉴权/路由（①③，串起整条主链路）

每一步走完整 Red→Green→Refactor。

### 3.2 测试纪律

- 先写失败测试（Red）→ 最小实现通过（Green）→ 重构（Refactor）。
- 单元测试不碰网络、不碰真实 Pi SDK、不碰真实数据库。
- 真实 Pi SDK 的验证用独立的慢速集成测试（手动触发），不进日常 TDD 循环。
- 覆盖目标：纯逻辑（①②④⑤⑥）与存储层 ≥90%（含分支）；其余核心路径。

### 3.3 技术选型

- 测试框架：Vitest（TS/ESM 原生、零配置）。
- 运行时：Node.js + TypeScript，ESM。

## 4. 与需求基线的对应

| 本文 | README | delivery-plan |
|---|---|---|
| 数据流 ①–⑨ | §4.2 API 与状态机 | 阶段 1 |
| 并发、幂等、身份 | §4.2、§7 | 阶段 1 |
| 存储 | §4.1 | 阶段 1 |
| Agent 执行 | §4.1、pi-sdk-api.md | 阶段 1 |
| Worker Job 队列 | §4.1 后台任务 | 阶段 1（同步能力见 knowledge-qa） |
| 能力 manifest | §1 能力模型 | 阶段 1（最小）/ 阶段 2（完善） |
| 用户自定义模型 | §4.2、§7 | 阶段 3 |
