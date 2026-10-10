# Web 界面基础规范（Phase 2）

本文档取代此前「阅读优先 / Crossband」等旧版视觉与布局规范。实现与评审以本文为准。

**样式入口**：`web/src/styles/globals.css`（Tailwind 主题层 + `tokens.css` + 内容渲染 `content.css`）。工作区壳层用 Tailwind 工具类。遗留 `styles.css` 与 `workspace.css` 已删除。

---

## 1. 技术栈（`web/`）

| 层级 | 选型 |
| --- | --- |
| 样式 | **Tailwind CSS v4**（无 preflight）写壳层；`content.css` 只保留 Markdown、代码高亮、diff、思考/工具步骤的像素对齐 |
| 组件 | **shadcn/ui**（Radix），`web/src/components/ui/` |
| 路由 | **react-router-dom**：`/p/:projectId`、`/p/:projectId/s/:sessionId` |
| 文案 | **i18n** `web/src/i18n/messages.ts`（zh 默认，en 结构对齐） |
| 字体 | 自托管 **DM Sans**、**JetBrains Mono** |

业务状态与 API 编排经 `useWebAppController`（state/actions 拆分）；**不修改** `src/client/*`、`src/shared/*` 数据契约。

---

## 2. 主题令牌（Pinguo）

语义角色见 `web/src/styles/tokens.css`，与 shadcn 对齐。

- **品牌蓝**：`primary` ≈ `#007aff`（亮色）/ `#2e8dff`（暗色 `brand-400`）。
- **明暗**：`html.dark` 与 `:root[data-theme]` 同时生效（视觉夹具只设 `data-theme`）。页面背景亮色 `#ffffff`、暗色 `#000000`（`background-900`）。侧栏、卡片、Composer 比页面高一档：亮色侧栏 `#f2f2f7`，暗色侧栏/卡片 `#1c1c1e`（`background-800`），暗色边框 `background-700`。当前会话与用户气泡亮色 `#e8f2ff`（`brand-50`）；暗色选中与气泡为 `#1a2740`，不用浅蓝铺底。默认跟随系统直至用户切换。
- **密度**：控件 ~13px UI，正文 ~15px；工具卡片圆角 12px，Composer 圆角 16px。`--radius` 仍是密工作区尺度，不采用设计系统默认 1.2rem。
- **工具输出**：JetBrains Mono（`.code-block`、`.tool-readable-value`）。

`tokens.css` 内 `--bg-page` 等别名映射到 shadcn 语义色，供 `content.css` 复用。

---

## 3. 信息架构：Agent 工作区

```
┌──────────────┬────────────────────────────┬─────────────┐
│ 左侧边栏      │  居中对话列 (~760px)        │ Run 面板     │
│ 项目 + 会话   │  标题 / 时间线 / Composer   │ （可折叠）   │
└──────────────┴────────────────────────────┴─────────────┘
```

| 区域 | 组件 | 说明 |
| --- | --- | --- |
| 侧栏 | `App` + `ProjectSwitcher` + `SessionList` | 可拖拽宽度；`<1180px` 抽屉；rail 折叠 |
| 对话列 | `Chat` + `ChatHeader` + `Timeline` + `Composer` + `StatsBar` | `--reading-max: 760px` |
| Run 面板 | `Inspector` + `EventLog` / 工具摘要 / `SystemPromptPanel` | `<1440px` 覆盖层；轨迹 Tab 与侧栏按钮联动 |

---

## 4. 屏幕级规格（屏幕重建）

### 4.1 侧栏

- **表面**：浅灰侧栏（`sidebar`）。品牌行：π 标记 + `app.brand`。
- **新建会话**：全宽描边按钮（`new-session`），文案「新建会话」。无会话时仅起始态。
- **项目**：标签「工作区 / 项目」+ 带箭头的项目下拉。新建/删除（默认项目不可删）。
- **会话**：分区标题是「会话」，右侧搜索图标。分组「今天 / 昨天 / 近 7 天 / 更早」与会话标题共用同一左缘；选中项是浅蓝圆角块，标题下为相对时间（如「8 分钟前」）。搜索时扁平列表。行内仍有共享标记、重命名/导出/删除。
- **主题**：侧栏底部带文字的切换（`theme-toggle`），亮色下文案为「深色模式」。
- **加载**：`SessionListSkeleton`（`data-testid="sessions-loading"`）。

### 4.2 对话列

- **无会话**：阅读列垂直居中。`no-session-hint` 是标题加说明；Composer 与正文同一 760px 列，项目选择是带边框和下拉箭头的控件。菜单向上浮出且不被输入区裁切。
- **有会话**：`ChatHeader` 只显示会话标题。对话/轨迹 Tab 保留在文档中但视觉隐藏（测试仍点击 `chat-tab` / `trace-tab`；轨迹 Tab 上的 `stat-steps` 一并隐藏）。Run / 轨迹面板由右侧图标按钮打开，带 `title` 与 `aria-label`。窄屏标题左侧让出固定菜单按钮，避免重叠。
- **时间线**：用户消息右对齐浅蓝气泡。时间戳不在时间线数据里，因此不编造时钟。助手正文约 15px。思考是工具卡片上方的一行可折叠浅色文字（`thinking-label` / `thinking-summary` / `thinking-chevron`），不改时间线顺序。阅读列最宽 760px。
- **工具卡片**：每条工具是独立圆角描边卡片。左侧实心绿勾或红叉圆标；动作为中文粗体（读取文件、搜索代码、运行测试、编辑文件、写入文件；bash/shell 按命令判断是否为测试，其余回落到工具名）。目标为灰色等宽。右侧先是有意义的结果徽章（通过数绿色胶囊，或 `+N` `−N`），没有计数或 diff 时不显示，不用输出里的任意一行当徽章。失败的测试不显示徽章。然后是耗时。读取短结果默认展开，带行号的代码预览；失败结果默认展开，灰底等宽输出里 `FAIL` 为红色；成功的长输出保持收起。原始数据菜单仍在（收起时屏幕阅读器可达）。生成中用闪烁光标。`NotificationItem` 子代理通知。
- **长输出**：代码在 `.code-block-scroll` 内横向滚动，细滚动条可见，行号不进入 `pre` 的文本。
- **滚动**：`chat-body` 跟随输出；`chat-latest` 回到底部。
- **历史加载**：`ChatHistorySkeleton`。
- **排队/错误**：`phase-queued`、内联 `load-error`；会话级错误另经 **Toast**（`Toaster`）提示。

### 4.3 Composer

- 大圆角描边盒。占位「描述任务…」。左侧「+」，右侧模型与思考档各带下拉箭头（仍是同一个 `model-thinking-trigger`），圆形蓝色发送按钮。
- 思考档按自然顺序：off、none、minimal、low、medium、high、xhigh、max，未知名称排在后面。
- 附件条、pending steer/follow-up、提交 unknown/failed 快照 UI（与 §5 一致）。
- **运行中**：发送变为 **Stop**（`abort-button`，圆形 `primary`，白色方块图标）。插话 / 追加以同一套浅色文字按钮保留，无输入时禁用，但不被全局 disabled 透明度洗成灰块。窄屏触控目标至少 44px。
- **快捷键**：Enter 发送 / Shift+Enter 换行；全局 Esc 在无浮层且 streaming 时中止。

### 4.4 Run / Inspector

- Tab：事件流（过滤/清空）、工具列表摘要、系统提示词只读 `pre`。
- 事件条目：`details` + JetBrains Mono 原始 JSON。

### 4.5 全局命令与反馈

- **命令面板** `CommandPalette`：`Cmd/Ctrl-K`；会话跳转、项目切换、侧栏/Run/主题。
- **快捷键**：`Cmd/Ctrl-B` 侧栏；`Cmd/Ctrl-.` Run 面板（需已选会话）。
- **Toast**：`web/src/lib/toast.ts` + `Toaster`；错误 8s 自动消失。

### 4.6 压缩与统计

- `CompactionBanner`：running/succeeded/failed + token 前后（服务端字段）。
- `StatsBar`：摘要簇 + 详情 Modal；语义不变（见 §5.5）。工具次数不放在摘要条上；详情里仍有「N 次工具调用」。轨迹 Tab 上的次数徽章随 Tab 一起视觉隐藏。

---

## 5. 行为与数据流（必须遵守）

（与 Phase 1 相同，略述要点。）

### 5.1 会话与草稿

新建不预创建；草稿仅内存；未知结果不盲重发；提交成功 ≠ 回复完成。

### 5.2 附件

图片 base64 / 文件 fileId；就绪不自动发送。

### 5.3 Steer / Follow-up

运行中可 steer + follow-up；仅排队时不可 steer；独立 pending 状态。

### 5.4 提交流

create → config → send；failed 快照重试；unknown 核对 createRequestId / requestId。

### 5.5 统计

仅展示服务端/export 快照；见 `docs/usage-measurement.md`。

### 5.6 压缩与消息游标

`CompactionBanner` + timeline 游标指示（SSE 驱动）；断开时 running 显示 unknown。

---

## 6. 响应式断点

| 断点 | 行为 |
| --- | --- |
| `max-width: 1179px` | 侧栏抽屉 + `workbench-mobile-menu` |
| `max-width: 1439px` | Inspector 覆盖层 + 背景点击关闭 |
| 侧栏 rail | `sidebar-collapsed` 或拖拽过窄 |

---

## 7. 阶段说明

| 阶段 | 状态 |
| --- | --- |
| **Phase 1** | Tailwind/shadcn、token、路由、i18n、controller 拆分 |
| **Phase 2** | token 换肤、分组会话、命令面板、Toast、骨架屏 |
| **屏幕重建（本分支）** | 壳层改为 Tailwind；删除 `workspace.css`；保留测试所需的结构类与 `content.css` 像素规则；Stop 使用品牌色 |
| **后续** | 无障碍验收矩阵；在不破坏 listbox/radio 契约的前提下把 `SelectMenu` / `ModelThinkingPicker` 换成 shadcn |

评审：行为以 §5 与代码为准；视觉以 §2–§4 为准。
