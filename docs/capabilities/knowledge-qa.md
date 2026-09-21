# 知识库问答与钉钉设计说明同步

> **状态：P1–P7d 已实现。P7a 的图片链路、P7b 的真实 HTTP/SSE dataSource、P7c 的 mode APPEND_SYSTEM 与手动组件上下文，以及 P7d 的全 owner 同步和代码索引编排均已通过跨仓真实验收。Pi 默认系统提示词保持不变，宿主不理解 ONEV 组件上下文。**
> 知识库能力以外部插件包 `pi-agent-capability-onev` 交付，由 pi-agent-server 加载。平台级约束见[平台需求基线](../../needs.md)。
>
> **需求原型增量：** 实施已完成，自动化验证与跨仓真实 onev Vue runtime 浏览器验收通过；真实生产模型端到端验收（包括所有组件规范遵循）待执行。当前 light 主题动作仅为 `navigate`/`back`，原型不连接真实业务后端，详见[需求原型模式增量实施计划](interactive-prototype-implementation-plan.md)。

参考图片的宿主侧契约与已知限制见 [外部能力插件架构与实施计划 §P7a](../external-capability-plugin-plan.md)（宿主只校验与透传，不压缩；压缩由 onev 客户端在提交前完成）。

## 目标

- 为 onev 组件绑定钉钉设计说明，并同步为本地 Markdown 和图片。
- 问答 Agent 查询组件代码、调用关系和组件设计说明。
- 设计说明不纳入 Git，避免同步产物与人工提交产生冲突。

## 项目约定

知识库项目为 pi-agent-server 默认项目目录；当前开发配置为 `/Users/mz/workspace/onev`。`components.json` 的 key 是组件 `name`。

| 内容 | 路径 | 事实来源 |
| --- | --- | --- |
| 组件源码 | `packages/<name>/` | Git |
| UI 示例（用例） | `examples/docs/zh-CN/<name>.md` | Git |
| API 文档 | `examples/docs/zh-CN/<name>_api.md` | Git |
| 组件设计说明 | `examples/docs/zh-CN/<name>_desc.md` | 钉钉 |
| 设计说明图片 | `examples/assets/dingtalk/<name>/` | 钉钉 |

- `_desc.md` 和 `examples/assets/dingtalk/` 均加入 `.gitignore`，不纳入 Git。
- 服务数据库只保存 `name`、`documentId`、`targetPath`、`contentHash`、同步时间等元数据，不保存设计说明全文。
- 未绑定钉钉文档的组件默认有一份 **0 字节** `<name>_desc.md`。
- 绑定只能改绑，不能解绑；改绑后等待下一次同步按新 `documentId` 覆写本地内容。

## 目标架构

```text
onev 组件库文档页面
  ├─ 绑定/改绑钉钉文档
  └─ 单组件「同步」按钮
        │
        ▼
pi-agent-server（能力宿主）
  └─ 加载外部知识库能力插件包
      ├─ 服务数据库：组件绑定与同步元数据
      ├─ 同步 Worker：读取钉钉，写本地 _desc.md 和图片
      ├─ 复用既有内置只读工具：读取本地 _desc.md
      └─ 注册新增 Pi 只读工具：vue2-index / gitnexus

操作人手动 npm run codegraph
  ├─ 全量同步全部已绑定组件
  └─ 重建 gitnexus 调用图和 vue2-index 组件实体（含 docs 关联）
```

## 核心数据流

### 绑定与单组件同步

```text
用户在组件文档页面绑定/改绑 documentId
  → 保存 name ↔ documentId
  → 用户点击「同步」
  → 同步 Worker 同步该组件的 desc、图片和元数据
  → 更新该组件的 vue2-index 文档关联
```

绑定/改绑本身不自动同步。

### 手动全量同步与代码索引构建

```text
操作人在 onev 目录执行 npm run codegraph
  → 全量同步所有已绑定组件
  → gitnexus analyze --index-only
  → vue2-index build
```

`npm run codegraph` 由受控 Node 编排器执行：先调用插件 `sync-full`，成功后才依次执行 `gitnexus analyze --index-only` 和 `vue2-index build`。四个运行入口均通过 `.codegraph.env.local` 显式配置并在首个子进程前校验，不扫描 PATH、不使用 shell。任一步非零、信号退出或绑定快照变化都会阻断后续步骤；不会自动迁移或回退旧流程。数据库无绑定时只创建缺失的零字节 placeholder，不伪造绑定或调用 DWS。

同步失败不覆盖最近一次成功的本地设计说明；无变化时由 `contentHash` 跳过写入。

### 问答

```text
设计说明
  → vue2-index search/component
  → 组件实体 docs[].desc
  → pi-agent-server 既有内置只读工具读取 _desc.md

代码符号/用法 → vue2-index
调用关系/影响面 → gitnexus
```

- Copilot 的「用法原理」「设计规范」「需求原型」模式各自维护独立 session 与历史记录；每个模式独立配置绑定模型和系统提示词，模型配置允许相同。侧滑面板提供新建会话、历史记录和恢复历史会话入口；恢复时使用原 mode profile，模式之间不复制上下文。
- 用法原理和设计规范回复为 Markdown（包含代码块）；需求原型生成持久化 HTML 链接并展示预览，不提供复制代码片段。
- 设计规范模式的可引用来源**仅限** `examples/docs/zh-CN/<name>.md` 与 `examples/docs/zh-CN/<name>_desc.md`；`<name>_api.md`、导航配置、组件实现源码与索引输出等其他文件不得作为依据或引用来源，某条结论只能由这些文件支持时按“无依据”处理。每条结论必须附 `<仓库相对路径>:<行号>` 证据（插件 `src/prompts/design-guidelines.md`）。输出先给一两句话结论再展开，只保留与问题直接相关的类别。
- 每次提问包含模式、文本、可选的手动组件选择和可选参考图片；当前页面组件不会自动带入。三个 mode 的选择分别隔离，网站以严格 `ONEV_CONTEXT_V1` 信封拼装普通 prompt，宿主不解析 ONEV 专属上下文。参考图片支持本地文件上传、屏幕截图和系统剪贴板粘贴，通过 pi-agent-server 既有会话消息图片通道提交，不上传到 onev 或插件数据库。

`vue2-index` 组件实体已关联 `docs[].usage` 与 `docs[].desc`，例如：

```json
{
  "usage": "examples/docs/zh-CN/button.md",
  "desc": "examples/docs/zh-CN/button_desc.md"
}
```

## 工具与接口

### 问答 Agent 工具

- 复用 pi-agent-server 既有内置只读工具读取本地设计说明。
- 由外部插件注册新增 Pi 自定义只读工具：
  - `vue2-index`：组件实体、代码符号、用法；组件实体提供 `docs[].desc`。
  - `gitnexus`：调用关系与影响面。
- 问答 Agent 不可调用通用 Bash 或写文件。

### 页面与同步接口

```text
POST /v1/capabilities/onev/documents/links              绑定或改绑 name ↔ documentId
GET  /v1/capabilities/onev/documents/links              查询绑定列表
POST /v1/capabilities/onev/sync/dingtalk/:name          同步指定组件（页面「同步」按钮）
GET  /v1/capabilities/onev/jobs/:id                     查询同步任务状态
GET  /v1/capabilities/onev/documents/links/:id/metadata 查询同步元数据
GET  /v1/capabilities/onev/prototypes/:id               读取需求原型 HTML
```

组件库文档站点先读 `GET /v1/capabilities/onev/access`（插件自有能力投影）拿 `{canBind}`，仅在 `canBind === true` 时显示绑定/改绑/同步入口；服务端仍以 RBAC 为准（`POST /documents/links` 与 `POST /sync/dingtalk/:name` 为 `capability:admin`，仅 `admin` 角色可调用）。宿主通用投影 `GET /v1/access`（`{canRead, canWrite}`）不包含插件业务 flag。`npm run codegraph` 通过插件 CLI 触发全量同步，不调用页面接口。

## 交付与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 1 | 注册 `vue2-index`、`gitnexus` 为 Pi 只读工具；复用内置只读工具读取设计说明 | Agent 可查询代码与读取关联的 `_desc.md`，无通用 Bash/写权限 |
| 2 | 页面绑定/改绑与单组件同步；Markdown、图片、空 desc、哈希去重 | 已绑定组件稳定同步；未绑定组件保留空 desc；失败不破坏最近成功内容 |
| 3 | `npm run codegraph` 全量同步并重建代码索引 | 组件实体的 docs 关联、代码查询和调用关系反映最新内容 |

## 非目标

- 不实现钉钉协同编辑或钉钉与 Git Markdown 双向同步。
- 不自动监听 Git commit、push 或发布事件。
- 文档站部署不在本期范围。