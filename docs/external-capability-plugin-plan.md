# 外部能力插件架构与实施计划

> **状态：P1–P7d 已实现并通过跨仓验收；P8 自动化隔离演练、Copilot 人工浏览器验收以及 Tag 组件→钉钉文档真实绑定/同步/本地图片渲染验收均已完成；真实生产数据变更仍待受控环境执行。** 本文定义 `pi-agent-capability-onev` 作为 `pi-agent-server` 外部插件包的工程边界。onev 业务需求见 [capabilities/knowledge-qa.md](capabilities/knowledge-qa.md)。
>
> **需求原型增量：** 实施已完成，自动化验证与跨仓真实 onev Vue runtime 浏览器验收通过；真实生产模型端到端验收（包括所有组件规范遵循）待执行。当前 light 主题动作仅为 `navigate`/`back`，原型不连接真实业务后端，详见[需求原型模式增量实施计划](capabilities/interactive-prototype-implementation-plan.md)。

## 决策

```text
pi-agent-server              通用能力宿主
pi-agent-capability-onev     onev 知识库能力外部插件包
onev                         组件库、文档与同步产物工作目录
```

- 插件工程目录已确定为 `/Users/mz/workspace/pi-agent-capability-onev`；P2 在该目录初始化独立的 `pi-agent-capability-onev` pnpm 工程。开发阶段不发布包，通过 `pnpm link` 链接到 `pi-agent-server`；链接操作仅由操作人手动执行。
- 开发宿主由操作人手动在 `pi-agent-server` 目录运行 `pnpm dev:real` 启动；插件不自动拉起或停止宿主服务。
- 插件包不是独立服务进程；由 `pi-agent-server` 显式加载并在其进程内运行。
- `pi-agent-capability-onev` 是受信任代码；外部插件是工程边界，不是进程级安全隔离。
- 插件拥有自己的数据库及其迁移、备份、恢复，HTTP 接口、同步 Worker、Pi 工具和需求原型 HTML 产物实现。
- `pi-agent-server` 不包含 onev 业务表、业务路由、同步逻辑或工具实现。
- `onev` 不包含插件业务代码，只提供源码、组件文档及 `npm run codegraph` 脚本。

## 工程职责

### pi-agent-server（宿主）

宿主需要提供稳定的外部插件 API，并负责：

- 仅按显式配置加载已安装插件，不扫描用户目录或项目目录；
- 校验插件标识、版本和工具名冲突；
- 将插件能力声明纳入会话能力快照、工具白名单和系统提示词；
- 挂载插件路由，并沿用宿主鉴权与 RBAC；
- 管理插件启动、停止和健康状态。

外部插件加载能力已在 P1 实现：宿主只按显式 `PI_PLUGINS` 配置加载受信 ESM 插件，并在加载期校验 manifest、工具与 mode profile。

### pi-agent-capability-onev（插件）

插件项目建议包含：

```text
src/plugin.ts       插件入口
src/http/           绑定与同步接口
src/storage/        插件数据库访问与迁移
src/sync/           钉钉同步 Worker
src/tools/          vue2-index、gitnexus Pi 工具
src/config/         插件配置
```

插件负责：

- `name ↔ documentId` 绑定与同步元数据；
- 单组件和全量钉钉同步；
- 写入 onev 的 `_desc.md` 与设计说明图片；
- 注册 `vue2-index`、`gitnexus` 两个只读 Pi 工具；
- 为每个 Copilot 模式按其独立配置的模型和系统提示词创建独立 session，并维护独立历史记录；模型配置允许相同，恢复会话时使用原 mode profile；
- 使用 pi-agent-server 既有会话消息图片通道接收参考图片，不建立插件图片上传接口或图片数据库；
- 提供组件绑定/改绑、绑定列表、单组件同步、同步任务状态、同步元数据和需求原型读取接口。

插件接口的能力范围为：

```text
POST  文档绑定或改绑
GET   绑定列表
POST  单组件同步
GET   同步任务状态
GET   绑定同步元数据
POST  需求原型生成（write，仅 interactive-prototype）
GET   需求原型列表（安全元数据 + 相对 preview URL）
GET   需求原型 HTML（严格预览响应头）
```

问答仍使用 pi-agent-server 既有会话与消息接口；插件通过 Pi 工具参与回答。插件接口统一挂载在 `/v1/capabilities/onev`。查询接口允许 `viewer`、`user`、`admin`；需求原型生成等常规变更接口允许 `user`、`admin`；**绑定/改绑与同步（`capability:admin`）仅允许 `admin`**（改绑后同步会以服务自身的 DWS 凭据读取该文档并写入共享项目目录，不能对所有 `user` 开放）。

插件只能依赖宿主公开的插件 API，不能引用 `pi-agent-server/src/*` 内部模块。`pi-agent-server` 应作为插件的 `peerDependency`。开发阶段使用 `pnpm link` 建立本地链接，不发布包。

### Agent 查询命令白名单

插件仅可向 Agent 暴露下列查询命令；不得开放通用 Bash，也不得编造额外子命令或参数。

```text
vue2-index search <关键词...>
vue2-index component <组件名>
vue2-index field <字段名> <组件名>
vue2-index event <事件名> <组件名>
vue2-index usages <组件名>
vue2-index slot <槽名> [组件名]
vue2-index provide <key>
vue2-index inject <key>
gitnexus context --repo onev --uid "<gnId>"
ls [路径]
```

- `vue2-index search` 用于未知组件名时检索候选组件，覆盖组件名、props、emits、slots、项目导航中的文档标题与描述、demo 标题与描述及 demo keywords，支持中文和多关键词。
- `vue2-index component` 返回组件全貌，包括 `file`、成员、成员 `gnId`、`docs`、`usedBy` 和 `includedBy`；任意 Vue 组件均可能被 mixin，专用 mixin 文件的 `name` 可为 `null`，可按文件名查询。
- `gitnexus context` 仅按组件成员的 `gnId` 查询 callers、callees 与 processes。
- 插件查询命令在 pi-agent-server 默认项目目录执行；当前开发目录为 `/Users/mz/workspace/onev`。pi-agent-server 既有内置工具继续可用，不开放通用 Bash 或写工具。

### onev（组件库）

- 保持源码、用例、API 文档和本地设计说明产物。
- Copilot UI 与数据流解耦：Vue 组件只负责渲染与用户事件，不直接调用 HTTP、数据库、同步 Worker 或图片传输；数据层通过可替换接口向 UI 提供会话、绑定和同步状态。真实适配器与 mock 均在组合层注入。
- 组件文档页面在数据流接通后调用插件的绑定与单组件同步接口；无写权限时不显示绑定、改绑和同步按钮，服务端仍以 RBAC 为准。
- 操作人手动执行 `npm run codegraph`：先调用插件 CLI 全量同步，完成后执行 `gitnexus analyze --index-only && vue2-index build`。
- onev 默认项目目录与宿主进程必须位于同一主机，或通过共享挂载提供同一工作目录。

## 插件接入契约

插件应导出一个由宿主加载的入口，其中包含：

```text
能力声明     标识、版本、Agent 可见工具、提示词片段
Pi 工具       工具定义及其受控执行实现
HTTP 路由     插件接口
可选生命周期  插件初始化与关闭钩子；具体资源由插件自行管理
```

宿主向插件提供受限上下文，用于注册上述内容；生命周期钩子为可选项，插件不直接修改宿主的 Fastify 实例、会话存储或内部数据库。

宿主向插件路由提供按请求认证身份绑定的受限会话 API：`reserve`（宿主预分配安全 session id，插件不可指定 id；预约仅在同一次请求内有效）、`create`（按预约 id 与声明的 mode profile 创建会话）、`restore`（恢复当前 owner 的既有会话）、`getSystemPrompt`（只读当前 owner 会话创建时冻结的完整系统提示词，不存在/越权统一为 `null`）与 `runTurn`（在指定 session 上同步执行一轮并返回助手文本）。会话创建顺序为 reservation → 插件原子写入自身 mode↔session 映射 → 宿主按预约 id 创建会话；宿主创建失败时插件删除该映射，此时不存在孤儿宿主会话。owner 由宿主在路由层绑定，签名不接受 owner 参数，插件无法伪造跨 owner 操作；该 API 不提供任何删除任意用户会话的能力。`runTurn` 同样由宿主绑定 owner、会话与 mode profile：插件不能指定模型/tools/cwd/图片，宿主限制 requestId/prompt 与返回助手文本长度，并强制单轮硬预算（工具调用总次数默认 60、墙钟默认 5 分钟），超限时快速中止并返回带稳定 code（`turn_tool_budget_exceeded` / `turn_duration_budget_exceeded` / `turn_assistant_text_budget_exceeded`）的 error；这些预算仅作用于 `runTurn`，不影响普通聊天轮次。code 的权威定义在宿主 `TURN_ERROR_CODES`：随 `pi-agent-server/contract` 静态导出，并经 `PluginHostContext.turnErrorCodes` 注入插件（插件按绝对路径加载，不能静态 import 宿主包），避免两侧各维护一份副本而静默漂移。结果覆盖 completed/abort/error/busy，且 handler 结束（API revoke）后不可调用；它不建立 HTTP 回调或长期订阅。宿主为每一轮绑定请求取消信号：客户端在响应写出前断开或 handler 返回（revoke）时，只中止该请求对应的 task，不误杀其他 task。

插件路由应使用能力命名空间，避免与宿主或其他插件冲突；统一前缀为 `/v1/capabilities/<plugin-id>`，onev 为 `/v1/capabilities/onev`。

## 数据库与部署

```text
pi-agent-server 进程
  └─ 加载 pi-agent-capability-onev
       ├─ 连接插件专属数据库
       ├─ 知识库插件按需运行同步 Worker
       └─ 读写 onev 工作目录
```

- 插件包携带 schema 定义与迁移脚本，数据库实例由部署环境提供。
- 插件迁移由插件 CLI 或部署流程显式执行，不在插件加载时隐式建表或迁移。
- 插件使用独立数据库或独立 schema，不修改 `pi-agent-server` 的 `schema-manifest.ts`。
- **当前开发环境插件数据目录**：`/Users/mz/.local/share/pi-agent-capability-onev`（`ONEV_DATA_DIR`）；SQLite 文件为 `/Users/mz/.local/share/pi-agent-capability-onev/onev.db`，需求原型 HTML 位于其 `prototypes/` 子目录。该目录独立于宿主开发数据库 `/tmp/pi-agent-server`。
- 数据库连接和钉钉配置属于插件配置；onev 根目录取自 pi-agent-server 默认项目配置。认证沿用 pi-agent-server 已有能力，不定义新的认证方案。

### 数据库生命周期

- **迁移**：创建或升级插件数据库表结构。
- **备份**：备份组件绑定、同步元数据、需求原型元数据和插件数据目录中的需求原型 HTML；本地 desc/图片不进入 Git，可由钉钉在恢复后重新同步。
- **恢复**：恢复插件数据库与需求原型 HTML，随后按需执行全量钉钉同步重建本地 desc/图片产物。
- 迁移、备份与恢复均由插件自己的 CLI 或部署/运维流程显式执行，并提供对应的验证与演练。

## 任务跟踪

> 状态仅反映实际完成的代码或已确认的架构决策。任务开始、完成或受阻时应同步更新本表。

| ID | 任务 |           状态           | 依赖 |
| --- | --- | :----------------------: | --- |
| A1 | 确认三工程边界与外部插件交付模式 | 已&#8288;完&#8288;成 | — |
| A2 | 确认插件包名为 `pi-agent-capability-onev` | 已&#8288;完&#8288;成 | — |
| A3 | 确认插件独立数据库与迁移边界 | 已&#8288;完&#8288;成 | — |
| A4 | 确定并创建插件工程目录 `/Users/mz/workspace/pi-agent-capability-onev` | 已&#8288;完&#8288;成 | — |
| A5 | 确认 `pi-agent-capability-onev` 使用 `pnpm` 管理依赖 | 已&#8288;完&#8288;成 | — |
| A6 | 确认开发阶段不发布包，使用 `pnpm link` 接入宿主（仅操作人手动执行） | 已&#8288;完&#8288;成 | — |
| A7 | 确认开发宿主由操作人手动执行 `pnpm dev:real` 启动 | 已&#8288;完&#8288;成 | — |
| A8 | 确认三个 Copilot mode 维护独立 session 与历史记录，模式之间不复制上下文 | 已&#8288;完&#8288;成 | — |
| A13 | 确认 `pi-agent-capability-onev` 是受信任代码 | 已&#8288;完&#8288;成 | — |
| A14 | 确认接口 RBAC：查询允许 `viewer` / `user` / `admin`；绑定、改绑和同步允许 `user` / `admin` | 已&#8288;完&#8288;成 | — |
| A15 | 确认需求原型 HTML 保存于插件数据目录、元数据保存于插件数据库，并按查询 RBAC 提供读取链接 | 已&#8288;完&#8288;成 | — |
| A16 | 确认 `npm run codegraph` 通过插件 CLI 全量同步；页面仅向有写权限用户显示操作按钮 | 已&#8288;完&#8288;成 | — |
| A9 | 确认 Copilot 输入包含模式、可编辑组件上下文、文本和可选参考图片 | 已&#8288;完&#8288;成 | — |
| A10 | 确认每个 Copilot 模式绑定固定系统提示词与模型，用户不可单独选择模型 | 已&#8288;完&#8288;成 | — |
| A11 | 确认参考图片经 pi-agent-server 既有会话消息通道提交，不上传到 onev 或插件数据库 | 已&#8288;完&#8288;成 | — |
| A12 | 确认参考图片支持本地上传、屏幕截图和系统剪贴板粘贴 | 已&#8288;完&#8288;成 | — |
| P1 | 在 `pi-agent-server` 定义并实现公开的外部插件加载 API：向插件提供默认项目目录；按 mode profile 在宿主会话存储中创建与恢复 session | 已&#8288;完&#8288;成 | A1, A8, A10 |
| P2 | 初始化 `pi-agent-capability-onev` 的 pnpm 包；由操作人手动通过 `pnpm link` 接入宿主 API | 已&#8288;完&#8288;成 | P1, A4–A7 |
| P3 | 实现插件数据库、迁移、备份、恢复、绑定、同步任务、mode ↔ session 历史映射和需求原型元数据存储 | 已&#8288;完&#8288;成 | P2, A15 |
| P4 | 在 `/v1/capabilities/onev` 实现插件 HTTP 接口与宿主 RBAC 挂载（按 A14），包括 mode 独立历史、新建与恢复会话和需求原型读取 | 已&#8288;完&#8288;成 | P2, P3, A14, A15 |
| P5 | 实现钉钉同步 Worker（单组件与全量） | 已&#8288;完&#8288;成 | P3, P4 |
| P6 | 按 Agent 查询命令白名单实现受控 `vue2-index`、`gitnexus` 工具 | 已&#8288;完&#8288;成 | P1, P2 |
| P6a | 实现需求原型 HTML 的生成、持久化与访问链接（查询权限按 A14，纳入插件备份恢复） | 已&#8288;完&#8288;成 | P1, P2, P3, P4, A14 |
| P7 | 开发 onev 组件库页面的 Copilot UI（模式、独立历史记录、新建与恢复会话、组件上下文、文本、参考图片、本地上传、屏幕截图和系统剪贴板粘贴）；无写权限时隐藏操作按钮。组件仅负责渲染和事件，通过可替换数据接口与 mock 获取状态 | 已&#8288;完&#8288;成 | A8–A12, A14, A16 |
| P7a | 验证并修复 pi-agent-server 从会话图片输入到 Pi SDK 的真实图片传递链路，并加入图片压缩与大小校验 | 已完成（跨仓真实验收通过） | A11, A12 |
| P7b | 实现 onev UI 的真实数据适配器并在组合层注入 | 已完成（跨仓真实验收通过） | P4–P7a |
| P7c | 实现 mode APPEND_SYSTEM Markdown、版本化组件上下文信封和三个 mode 的手动组件选择；宿主仅提供通用 `appendSystemPrompt`，不理解 ONEV 上下文 | 已完成（跨仓真实验收通过） | P1, P7b, A10 |
| P7d | 改造 `npm run codegraph`：调用插件 CLI 全 owner 同步后重建索引 | 已完成（跨仓真实验收通过） | P2, P3, P5, A16 |
| P8 | 完成插件加载、迁移、备份恢复、同步、工具访问、UI 数据流及停止流程的集成测试与演练 | 宿主通用插件契约的隔离演练已完成（证据：宿主 `docs/p8-host-integration-drill.md`）；真实插件兼容、迁移、备份恢复、同步与工具证据归插件仓 `docs/p8-integration-evidence.md`；ONEV UI 验收证据保留于 `docs/p8-copilot-evidence.md` | P4–P7d |

## P7c mode APPEND_SYSTEM 与手动组件上下文（已完成）

> 状态：宿主通用追加、插件 Markdown 配置、V1 信封规则、ONEV 三 mode 手动组件选择及需求原型传递均已实现，并通过跨仓真实浏览器验收。宿主范围仍严格限定在通用能力。

宿主范围（仅 `pi-agent-server`；不新增插件专属分支）：

1. **契约（`src/plugin/contract.ts`）**：`PluginModeProfile` 新增 `appendSystemPrompt?: string`，保留 `systemPrompt?: string` 作为旧版整体覆盖的兼容路径，两者**必须且只能二选一**且去空白后非空。不新增 `componentNames` / `ONEV_CONTEXT` 或任何 onev 专属字段；宿主不知道追加片段的业务含义。
2. **加载器（`src/application/plugins/loader.ts`）**：mode 校验对二者做存在性互斥判定（都缺失或同时提供均 fail-closed），非空校验按选中项给出固定错误文案；规范化结果只保留选中字段。
3. **插件宿主（`src/server/plugin-host.ts`）**：`create` 按选中项分派——`appendSystemPrompt` 走 `SessionService.createSession` 的新入参 `systemPromptAppend`，`systemPrompt` 仍走既有 `systemPromptOverride`；创建前再次做互斥防御，违反即拒绝且不触达宿主存储。
4. **会话服务（`src/application/session-service.ts`）**：新增 `systemPromptAppend`，与 `systemPromptOverride` 互斥且非空（空串/空白 fail-fast，互斥校验先于任何写入）。追加路径先用既有 `SystemPromptPort`（`systemPromptResolver`）取得该会话所属项目在 Pi 侧的**完整提示词**（Pi 默认提示词或服务端整体提示词，未设置 `PI_SYSTEM_PROMPT` 时为 Pi 默认），再以与 Pi SDK `buildSystemPrompt` 一致的空行分隔追加片段，结果整体冻结进现有 `SessionRecord.systemPrompt`。解析器缺失且无服务端提示词时 **fail-closed**（拒绝创建，绝不静默退化为「只留片段」而丢掉 Pi 默认提示词）。
5. **Pi 默认提示词不变**：追加只作用于**新会话快照**；`DefaultResourceLoader` 的 `systemPrompt` override、`appendSystemPrompt`（能力片段）与默认会话解析路径均不改动，服务端默认提示词与共享资源加载器行为逐字节不变。
6. **恢复继续冻结快照**：`SessionConversationCoordinator.contextOf` 仍只透传 `SessionRecord.systemPrompt`；`PiAgentSessionFactory` 仍用字面量 override 的会话专属 `ResourceLoader`，因此恢复时按快照原文生效，绝不重新解析、绝不重复追加片段。
7. **插件 mode Markdown**：`pi-agent-capability-onev` 的三个 mode 均改用 `appendSystemPrompt`，默认内容位于 `src/prompts/<mode>.md`；三个显式环境变量可分别覆盖为绝对 Markdown 文件。文件必须是非空 UTF-8 普通文件，拒绝 symlink 与超过 64 KiB 的内容；读取失败在插件导入时 fail-closed。固定的 `ONEV_CONTEXT_V1` 解释规则永远位于内置或自定义 mode 内容之前（两者间隔两个换行），不可被覆盖文件删除；宿主最终快照顺序为 Pi 默认提示词 → Envelope → mode 规则。
8. **网站手动组件上下文**：ONEV 不再从路由或当前文档自动选择组件。三个 mode 默认选择为空并在各自草稿中隔离；用户可手动搜索、选择、移除或清空。Working 期间 UI 与方法双重禁止修改。网站对组件名做严格数量、长度、类型、控制字符及保留标记校验，有选择时生成精确 V1 信封，无选择时发送用户原文。
9. **信封与历史**：普通问答把网站生成的完整 prompt 作为宿主既有 `prompt` 发送，宿主不解析；ONEV export 仅对 user 消息剥离完整、规范且位于开头的 V1 信封，assistant/畸形/未知版本保持原文。用户正文自身不得以保留 V1 前缀开头，避免来源歧义。
10. **需求原型**：`prototypes/generate` 接收 `{requestId,prompt,title?}`，网站向 `prompt` 传入同一 V1 信封；插件不解析 `componentNames`，只在需求后追加不可变 Prototype DSL 契约。`title` 只作元数据，原有严格 JSON、CSP、hash 和 sandbox 边界不变。
11. **验证**：宿主完整测试 `1253 passed / 108 skipped`；插件 `392 passed / 1 skipped`；ONEV Karma `457/457`，定向 ESLint 与三仓 `git diff --check` 通过。真实浏览器确认 Table 页面初始选择为空、mode 选择隔离、普通问答模型识别 `Button 按钮`、历史只展示原文、`Table 表格` 原型生成成功及 iframe sandbox/CSP 正常；数据库中新会话提示词以 Pi 默认提示词开头并包含 mode Markdown 与 V1 固定规则。

### 非目标

- 不引入插件专属上下文注入（如组件名/`ONEV_CONTEXT` 之类），宿主只做通用字符串追加。
- 不改变 Pi 默认 system prompt 的生成方式与内容，也不改变资源加载器的自动发现边界。
- 不新增会话表字段：追加结果仍写入既有 `system_prompt` 列。

## P7d 全 owner 同步与代码索引编排（已完成）

1. 插件新增本地运维命令 `sync-full --project-dir <absolute>`。它只打开已存在且显式迁移到 head 的数据库，不新增跨 owner HTTP 能力，也不隐式迁移。
2. CLI 从同一 binding identity 快照按确定顺序枚举全部 owner，为每个 owner 原子创建自己持有 lease 的 full job，绝不领取既有 pending job；任一失败、superseded、deferred、失租或不完整分类立即返回非零。批次结束复验 binding token、generation 与文档引用，运行中新增、删除或改绑会阻断成功结果。
3. migration v8 为 `document_links` 增加唯一 `binding_token`，封闭删除后以相同字段重建的 ABA；迁移前缺 token 的 single job直接 superseded，绝不读取 DWS 或发布产物。
4. 数据库无绑定时执行一次随机内部 maintenance owner 的受控 full job，只为 114 个未绑定组件创建缺失的零字节 desc；不插入伪绑定、不调用 DWS、不覆盖人工内容，审计结果标记 `placeholderPass`。
5. DWS 复用可信 executable descriptor：配置时校验 canonical 路径、祖先、属主、权限和指纹，每次 spawn 前复验；命令参数固定且 `shell:false`。系统 root-owned sticky 临时目录可作为可信祖先例外，其下实际目录仍须私有。
6. ONEV 的 `codegraph` npm script 读取严格、无变量展开的 `.codegraph.env.local`，在第一个子进程前预检并冻结插件 Node、插件 CLI 和两个索引器入口；ONEV Node 16 与插件 Node 22+ 显式分离。执行顺序固定为 `sync-full` → `gitnexus analyze --index-only` → `vue2-index build`，失败立即短路。
7. 真实验收：v7→v8 显式迁移成功；零绑定同步完整分类 `114/114` 并生成 114 个占位；GitNexus 最终索引当前提交（7153 nodes、11958 edges、406 clusters、300 flows）；vue2-index 扫描 641 个文件并生成 234 components、4674 edges。一次 GitNexus 原生进程瞬态崩溃被编排正确短路，随后相同增量命令成功，未发现缓存损坏。

## P7b 宿主访问能力与 SSE turn 关联（已完成）

> 状态：宿主、插件与 onev UI 数据适配器均已完成，并通过真实跨仓验收：mode/session 创建、消息提交、SSE 增量与终态、export 权威回读、abort、历史恢复及同源原型预览。

范围（仅宿主；不新增插件 SSE、不改 P7a 图片逻辑）：

1. **访问能力投影 `GET /v1/access`**：返回最小固定响应体 `{canRead, canWrite}`，由中央矩阵 `src/server/route-rbac.ts` 的 `ROUTE_PERMISSIONS` + `evaluateRouteAuthorization` 经 `projectAccessCapabilities` 派生（不硬编码，端点与矩阵不会漂移）。权限走既有 default-deny：`viewer`/`user`/`admin` 可读（`access:read`），`operator` 仍被全局 hook 403 拒。响应体绝不含 role/IP/token。`canWrite` 准确覆盖 sessions send/control 与 `capability:write`；若未来矩阵分项不一致，布尔值只会更保守（少报可写），前端可据此隐藏写操作而无误放行风险。**这是宿主的通用契约，保持闭合（`additionalProperties:false`），绝不加入插件业务 flag**——onev 的 `canBind` 走插件自有投影端点（见下条）。

   **插件业务能力投影 `GET /v1/capabilities/<plugin-id>/access`（onev 为 `/v1/capabilities/onev/access`）**：宿主只拥有 `read`/`write`/`admin` 三个通用档位（`CAPABILITY_TIER_ROLES` 为唯一权威），不理解插件业务语义；插件在 `manifest.capabilities` 声明业务 flag，并在 register 阶段用 `declareCapabilities({ flag: tier })` 绑定档位，宿主据此自动挂载只读投影端点（权限点 `capability:read`）。响应体恰好是声明的 flag 集合，值为由档位矩阵派生的布尔（role 缺失/未知 → false，fail-closed）。onev 当前只声明 `canBind → admin`：前端据此隐藏绑定入口；**新增插件 flag 不需要改动宿主**。`/access` 是宿主保留路径，插件不得声明同名路由。
2. **SSE turn 事件全部携带 `requestId`**：`text_delta`/`thinking_delta`/`tool_start`/`tool_update`/`tool_end`/`status`/`usage`/`queued`/`error`/`completed`/`aborted`。`SseEvent` 类型改为各分支 `& SseRequestId`（`requestId?`），发射逻辑在 `SessionRuntime` 统一附加当前任务 `requestId`。关键语义：事件仅在活动窗口（streaming/aborting）处理，stray 与结算后迟到事件绝不绑到新 request；队列超时用被超时任务自己的 `requestId`；`settle` 在清空 `currentRequestId` 前捕获该值，终态与 `usage` 一律归属本请求。可选 `requestId` 仅供非 turn 遗留场景；正常 turn 测试断言其存在。
3. **继续使用宿主 `/v1/sessions/:id/events`**：不引入新的插件 SSE，不改图片 P7a 逻辑。
4. **前端（web/）**：`types.ts` 的 `SseEvent` 与宿主同步（各分支 `& SseRequestId`）；新增 `ApiClient.getAccess()` 与 `AccessCapabilities` 类型，供 onev 真实数据适配器读取投影、无写权限时隐藏操作。事件按 requestId 过滤 UI 状态属于 onev 数据适配器（P7b onev 侧）职责，宿主 web 不强制。

### 验证

- 宿主：`typecheck`、`build`、完整 `vitest`（access RBAC/矩阵派生/failclosed、SSE 各类关联、abort/error/queue 超时、无跨 request 串扰、补发）；
- Web：`tsc -b`/`vitest`（api `getAccess`、类型编译）。
- onev：真实 HTTP dataSource、fetch SSE、requestId 过滤、客户端图片压缩、JSONL/export 图片恢复、同源原型生成与 iframe 均完成；Karma `457/457`，真实文本、图片和原型链路通过浏览器验收。

### 非目标

- 宿主不新增插件 SSE；onev 继续复用 `/v1/sessions/:id/events`。
- 不新增 ONEV 插件图片数据库或上传路由；图片继续归宿主会话 JSONL 管理。

## P7a 宿主图片输入（已完成）

> 状态：宿主权威校验、onev 客户端压缩、Pi SDK 真实传递和 JSONL/export 历史恢复均已完成，并以 2984×1642 PNG 通过跨仓真实验收。本文记录已交付契约与已知限制。

范围（仅 `pi-agent-server`；不上传、不新增图片路由、不新增图片数据库）：

1. **验证与规范化入口**：`src/agent/image-input.ts`。位置在 HTTP body 通过 JSON schema 预检之后、进入 `session service` / `runtime` / SDK 之前。schema 只是预检（`maxItems` / `maxLength` / `mediaType` 枚举，由常量派生）；**业务验证是权威**，任何失败都是固定文案 400，绝不回显内容。
2. **上限常量**（`IMAGE_INPUT_LIMITS`，单一权威来源，schema 同步）：最多 4 张；单图解码 4 MiB；单图 base64 长度 5,592,408；总量解码 6 MiB；单边 8192 px；总像素 40,000,000。
3. **严格校验**：base64 canonical（长度 4 倍数 + 字母表 + padding + round-trip）；真实魔数与头部尺寸解析（PNG IHDR + chunk 边界 + CRC 边界；JPEG SOF/SOS + EOI；WebP RIFF/VP8/VP8L/VP8X）；声明 MIME 必须与真实格式一致；拒绝 SVG/XML/HTML 伪装、截断、0 字节、不可识别类型，以及**能可靠判断**的尾部 polyglot（PNG IEND 后、JPEG EOI 后、WebP RIFF 长度不符）。
4. **不压缩、不转码**：不引入 sharp/任何原生依赖，不在宿主伪造压缩。客户端（onev UI）在提交前压缩；宿主只接受压缩后的安全结果并重新完整验证。
5. **PiAgentAdapter 继续唯一转换点**为 SDK `ImageContent`：`{ type:"image", data, mimeType }`（真实形状，见 [pi-sdk-api.md §3.8](pi-sdk-api.md)），base64 逐字节透传；无图消息行为不变。
6. **会话历史导出**：`projectExportMessages` / `ExportMessage` 把 user 消息里的受支持 image 块安全投影为可选 `images:[{mediaType,base64}]`；assistant 保持文本。只接受严格结构（SDK 实际持久化的 `{type,data,mimeType}`），导出时同样走完整验证并受 `EXPORT_IMAGE_BUDGET`（单消息 4 张、单图长度、整次总量）限制，超出或畸形一律静默省略（fail-closed），避免畸形 JSONL 造成巨型/不安全响应。活会话与只读 JSONL 共用同一投影函数，逐字节一致。
7. **公开 messages 接口**：`requestId`/`prompt` 与插件 `runTurn` 共用 `src/core/text-input.ts` 的长度/控制字符限制（`TURN_TEXT_LIMITS` 与 `PLUGIN_RUN_TURN_LIMITS` 数值一致，由测试断言防漂移）；仅公开 messages 在至少一张图片通过权威校验时显式允许空 `prompt`，保留仅图片消息能力，插件 `runTurn` 仍要求非空文本。
8. **同 requestId 不同 payload**：进程内新增载荷指纹（`src/core/payload-fingerprint.ts` + `IdempotencyStore`/`SessionRuntime`）——同一 `requestId` 以不同 prompt/parentId/图片重放时返回 409（`payload-mismatch`），不再静默返回旧结果。

### 已知限制（未完成事项）

- **跨重启的载荷指纹不可用**：持久化 `idempotency` 表只保存终态 `result`，不保存指纹。新增列属于 schema 变更（canonical baseline 不可变 + 备份/恢复 golden checksum），本任务不做。因此进程重启后，同一 `requestId` 以不同内容重放仍会命中旧终态。要彻底修复需一次受控 schema 迁移。
- **GIF 不支持**：宿主策略只接受静态 `image/png`、`image/jpeg`、`image/webp`；虽然上游嗅探器能识别 `image/gif`，但动态图不接受（`isAnimatedPng` 命中即被上游拒绝，宿主不做更宽的承诺）。
- **客户端压缩已落地**：onev 在浏览器解码前先按头部尺寸拒绝高像素输入，再缩放/压缩为 PNG、JPEG 或 WebP；宿主仍会重新执行权威魔数、尺寸、像素与体积校验。超出安全预算且无法压缩的图片会被拒绝而非强行发送。

### 非目标

- 不在宿主实现压缩/转码/缩略图，不引入原生图像依赖。
- 不新增图片上传路由、图片数据库或图片存储。
- 不修改插件公开契约（`src/plugin/contract.ts`）、不 import 外部插件。

## 非目标

- 不将 onev 业务代码或数据库表合入 `pi-agent-server`。
- 不自动发现或加载任意本地插件。
- 不将插件数据库内容发布到 npm 包。
- 不自动监听 Git commit、push 或发布事件。
