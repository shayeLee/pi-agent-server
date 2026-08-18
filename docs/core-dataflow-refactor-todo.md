# 核心数据流渐进式重构 TODO

## 目标

将 pi-server 的核心收敛为与模型厂商、传输协议、存储实现和具体能力无关的会话任务编排层；通过明确端口接入外部实现。重构采用渐进式替换，不进行大爆炸迁移。

当前优先动机是支持 DeepSeek V4 Flash/Pro 及 OpenCode-Go 对应模型的文本工具调用协议，同时保持 Pi 原生工具执行与权限边界。

## 核心边界

核心仅拥有：

- 会话任务状态机、排队、并发与取消；
- 规范化的消息、thinking、tool call、tool result、usage 事件；
- 工具授权决策的调用点；
- 会话运行时生命周期与幂等控制。

核心不得包含：

- 厂商专有请求字段、SSE 格式、文本工具标记；
- HTTP/SSE/前端展示逻辑；
- SQLite SQL、JSONL 文件格式；
- 具体能力（知识库、文件、索引等）的业务逻辑；
- 凭证存取、IP/Token/SSO 的实现细节。

## 原则

- **渐进迁移**：每阶段可独立发布、测试和回滚；不改变既有 HTTP API、SQLite schema、SSE 事件或 UI 行为。
- **单向依赖**：`core` 只依赖 ports；adapters 依赖 core 定义的契约，不能反向泄露厂商类型。
- **执行唯一入口**：任何适配器只能产生规范化调用事件，绝不直接执行工具；Pi Agent 的工具白名单、schema 校验、权限钩子和执行生命周期仍是唯一执行路径。
- **按 provider + modelId 匹配**：不能只按模型名称匹配；不同网关即使模型 id 相同，也可能有不同协议。
- **fixture 驱动**：所有厂商响应流适配在编码前必须有脱敏原始流 fixture，并覆盖任意 chunk 切分。

## 阶段 0：冻结现状与契约

- [ ] 抓取并脱敏保存以下原始响应流 fixture：
  - [ ] `deepseek/deepseek-v4-flash`
  - [ ] `deepseek/deepseek-v4-pro`
  - [ ] `opencode-go/deepseek-v4-flash`
  - [ ] `opencode-go/deepseek-v4-pro`
- [ ] 每个 fixture 至少覆盖：无工具请求、允许工具、请求未授权工具、thinking、usage、正常文本、错误结束。
- [x] 已保存四个目标 provider/model 的脱敏实际会话文本帧及有限工具验证矩阵：`tests/provider-adapters/fixtures/deepseek-v4/`。在已测试的 `read` 白名单中，四个模型都会拒绝未授权 bash，并将授权 read 作为 Pi 原生 tool call；仅 `deepseek/deepseek-v4-flash` 曾在无工具场景观察到 `<use_tool>`。这些是 Pi 持久化后的助手文本/工具结果，不是原始 SSE，不能替代上述四组完整 fixture。

**验收：**现有根测试、web 测试与 E2E 均不回归；fixture 不含 token、用户隐私、完整业务内容或敏感路径。

## 阶段 1：Provider Adapter 最小骨架

目标目录：

```text
src/provider-adapters/
  types.ts             # 厂商流与 Pi 原生流的适配契约
  registry.ts          # provider + modelId → adapter
  openai-tool-policy.ts
  fixtures/
```

- [x] 定义最小 `ProviderRequestAdapter` 契约与注册表；原始流归一化接口留待阶段 2 在真实 fixture 驱动下定义。
- [x] 提供严格 pass-through 默认路径：所有未匹配模型保持原始 payload。
- [x] 将现有 OpenAI-compatible `tools` / `tool_choice` 请求策略迁入 `openai-tool-policy.ts`。
- [x] 仅对 OpenAI-compatible API 注入 OpenAI 字段；Anthropic、Google 等协议不得接收不兼容字段。
- [x] `start.ts` 仅负责创建注册表和受控 inline provider extension，不含厂商/模型条件分支。

**验收：**未注册模型的请求、流式响应、工具调用和 SSE 输出与迁移前一致；请求策略单测覆盖无工具、有限工具、已有 `tool_choice`、非 OpenAI 协议。

## 阶段 2：DeepSeek V4 文本工具协议适配

- [x] 以 provider + modelId 建立 DeepSeek V4 适配 profile；直连 DeepSeek 与 OpenCode-Go profile 分开维护（`isDirectDeepSeekV4Flash` / `isOpenCodeDeepSeekV4FlashFree` 精确匹配，非目标模型严格 pass-through）。
- [x] 实现增量状态机，识别经 fixture 确认的 DSML 与 `<use_tool>` 格式：
  - [x] 已完成 `<use_tool>` 最小安全解析器和任意 chunk 切分回归测试，并接入 Provider 流（`DeepSeekV4TextToolParser` + `DeepSeekV4DsmlTextToolParser`）。
  - [x] `TEXT`、前缀候选（`longestPrefixSuffix` 跨 chunk）、调用帧、参数、结束、失败状态（`push`/`finish`）。
  - [x] 支持任意 chunk 切分、混合文本、多调用与 Unicode。
  - [x] 限制：帧长度（`MAX_FRAME_BYTES`=64KB）、参数数量（`MAX_PARAMS`=32）已实现；单轮工具错误预算上限已实现（`SessionRuntime.MAX_TOOL_ERRORS_PER_TURN`=8，超限自动 abort）；嵌套深度不适用（use_tool 协议扁平无嵌套）。
  - [x] 拒绝重复参数、原型污染键（`name in arguments` 拒绝原型链键）、非法工具名（`NAME_PATTERN`）与不完整帧。
- [x] 已接入 `deepseek/deepseek-v4-flash` 与 `opencode/deepseek-v4-flash-free` 的 Provider 流包装器；后者使用实际捕获的 `｜｜DSML｜｜` 帧 fixture。未匹配 provider/model 严格 pass-through。
- [x] 对已识别的**未授权**名称转换为 Pi 原生 `toolcall_start/delta/end`，而不是在适配器内直接执行；Pi 随后生成 `Tool <name> not found` / error toolResult。
- [x] 已授权名称的文本标记绝不触发执行（它可能只是模型复述的 XML）；标记被隐藏并替换为“未执行”文本。已授权调用必须使用模型原生 tool-call 协议。
- [x] 保留模型原生 text、thinking、usage、取消、错误与 finish reason；文本标记生成的 tool call 将终态规范为 `toolUse`。
- [x] 当协议帧不完整或无法安全解析时，进入受控失败路径：不得泄露原始工具标记，不得执行工具。

**验收：**

- [x] 授权工具恰好执行一次（`tool-matrix` fixture + `deepseek-v4-fixtures` 测试）；
- [x] 未授权工具零执行、产生 error toolResult，后续模型请求可见该结果；
- [x] SSE/UI/导出/恢复历史中不出现已识别的 DSML 或 `<use_tool>` 原文（`translate`/导出测试）；
- [x] 非目标模型完全走 pass-through（精确 `provider+modelId` 匹配）；
- [x] 连续未授权调用达到预算上限后安全终止，避免无限循环（`MAX_TOOL_ERRORS_PER_TURN`=8，超限自动 abort 并结算为 error）。

## 阶段 3：核心 Ports 与应用服务

- [x] 抽出 `SessionRuntimePort` 与 `ManagedSessionRuntimePort`：HTTP/application 只能看到业务端口，RuntimeRegistry 内部才拥有 dispose/prune 生命周期端口；核心不直接依赖 Pi SDK session 类型。
- [x] 抽出 `IdempotencyStorePort`；SQLite 实现改为 application port adapter。
- [x] 抽出 `SessionStorePort` / `ProjectStorePort` 及 record/patch 合约；SQLite 实现改为 application port adapter。
- [x] 抽出 `ModelCatalogPort`；`PiModelRuntimeCatalog` 仅映射可展示模型描述，Pi SDK 类型不进入 application/server/app/runtime。
- [x] 抽出最小 `CredentialPort`；仅 composition root 通过 `PiModelRuntimeCredentials` 注入运行时 API key/校验 provider 凭证，HTTP/runtime 不可见凭证。
- [x] 抽出 `SystemPromptPort`：server 仅依赖 `resolve(cwd)`，Pi session 解析留在 composition root。
- [x] 抽出 `ToolAuthorizationPolicyPort`（默认全禁/显式白名单，provider 中立）；工具授权决策经策略解析，Pi SDK 形态映射留在 composition root。cwd/模型/配额已分别由项目存储、会话配置、`ConcurrencyController` 承载，不再重复抽象。
- [x] 抽出 `SessionService`：会话/项目 CRUD、归属校验、配置切换、消息提交、导出、级联删除均移入 application 层；`app.ts` 仅保留鉴权、参数校验、状态码/响应映射与 SSE/CORS/优雅关闭。
  - SSE 连接管理、心跳、背压保留在 app.ts（纯 HTTP transport 关注）。

**验收：**核心层不导入 Fastify、SQLite、Pi SDK、厂商 model 类型或前端类型；现有 API 契约测试保持通过。

## 阶段 4：能力与资源组合

- [x] 建立版本化 `CapabilityManifest` 契约（id/version/tools/promptFragments；工具含 category/schema/scope/outputLimit）；HTTP 接口/Worker/数据源字段待首个真实能力实现时补充。
- [x] `CapabilityRegistry` + `composeCapabilities`：工具清单从已启用能力 manifest 并集计算，重复 id/同名工具定义冲突拒绝；版本快照可冻结。
- [x] 工具清单接入 `start.ts`：能力工具并集 ∪ 内置工具白名单；当前无能力，行为不变，机制已就位。
- [x] 能力提示词片段经 `prompt-composer` 映射为 Pi `appendSystemPrompt` 条目（inline 文本 / file 路径），组合进系统提示词；skills/AGENTS/extension 仍禁用自动发现，后续按能力 manifest 受控注入。
- [x] 会话创建时把能力版本快照（id→version）持久化冻结（`SessionRecord.capabilityVersions` + SQLite 列迁移）。
- [ ] 恢复会话时按冻结版本重建工具清单与资源快照（依赖版本化 manifest 查找，待有真实多版本能力时实现）。
- [ ] 能力工具的执行实现（Pi 自定义工具注册）与注册表接通；禁止能力模块绕过注册表直接注入执行路径。

**验收：**新增能力不修改核心任务状态机；禁用能力后其工具、资源和接口均不可达。

## 阶段 5：传输与观测解耦

- [x] HTTP/应用层已分离：`SessionService` 承载业务，`app.ts` 仅 REST/SSE transport（阶段 3 完成）。
- [x] SSE 只转换 `SessionEventBus` 的规范化 `SseEvent`，不感知厂商流格式。
- [x] 建立 `ObservabilityPort` 观测订阅口：SessionRuntime 在 turn/usage/queue/queue_expired/error 关键路径推送脱敏结构化事件。
  - [ ] 成本聚合、协议适配失败、审计事件（有副作用工具/Job）的观测埋点待后续接入。
- [x] 观测事件类型与 logger redact 均不携带凭证/完整系统提示词/原始模型内容/敏感工具结果（后续接入观测后端时保持该约束）。

**验收：**增加一种传输方式或观测后端不修改会话核心；厂商协议失败可按 provider/model 聚合诊断。

## 不在本轮范围

- 不重写现有 HTTP API、SQLite schema 或 web UI；
- 不将所有模型统一为 DeepSeek 协议；
- 不以提示词作为工具授权的安全边界；
- 不在 adapter 内部绕过 Pi 执行工具；
- 不在缺少真实 fixture 时猜测厂商文本协议。

## 迁移顺序

`阶段 0 → 阶段 1 → 阶段 2` 是当前 DeepSeek 工具协议问题的最小闭环。阶段 3–5 按能力扩展和部署需求逐步推进，每阶段独立评审与发布。
