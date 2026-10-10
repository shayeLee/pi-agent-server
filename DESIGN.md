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
- **明暗**：`html.dark` 与 `:root[data-theme]` 同时生效（视觉夹具只设 `data-theme`）。页面背景亮色 `#ffffff`、暗色 `#000000`。当前会话行 `--session-active`：亮色 `rgb(233, 238, 251)`，暗色 `rgb(35, 44, 59)`（不用 `accent-soft`，避免暗色仍是浅蓝）。默认跟随系统直至用户切换。
- **密度**：控件 ~13px UI，正文 ~15px；`--radius` ≈ 6px，卡片 `--radius-card` ≈ 8–10px。
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

- **品牌行**：π 标记 + `app.brand`；折叠/主题切换。
- **新建会话**：`data-testid="new-session"`；无会话时仅起始态。
- **项目**：`SelectMenu` 下拉；新建/删除（默认项目不可删）。
- **会话列表**：搜索（可展开）；**按时间分组**（今天 / 昨天 / 近 7 天 / 更早）；搜索时扁平列表。行内：相对时间、共享标记、重命名/导出/删除。
- **加载**：`SessionListSkeleton`（`data-testid="sessions-loading"`）。

### 4.2 对话列

- **无会话**：`no-session-hint` + 欢迎文案；Composer 可选项目 + 模型/思考。
- **有会话**：`ChatHeader` 标题 + 对话/轨迹 Tab；`toggle-events` 打开 Run 面板。
- **时间线**：用户行右对齐轻底；助手 Markdown ~15px；`ThinkingRow` 紧凑折叠（`thinking-header` + chevron）；`ToolCallCard` 步骤式折叠（非大卡片）；`NotificationItem` 子代理通知。
- **滚动**：`chat-body` 跟随输出；`chat-latest` 回到底部。
- **历史加载**：`ChatHistorySkeleton`。
- **排队/错误**：`phase-queued`、内联 `load-error`；会话级错误另经 **Toast**（`Toaster`）提示。

### 4.3 Composer

- 附件条、pending steer/follow-up、提交 unknown/failed 快照 UI（与 §5 一致）。
- **运行中**：插话 / 追加 + **Stop**（`abort-button`，圆形 `primary` 填充，与 Composer `card` 底色区分；桌面 34px、窄屏 44px，停止方块 10×10）。空闲：模型选择 + 发送。
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
- `StatsBar`：摘要簇 + 详情 Modal；语义不变（见 §5.5）。

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
