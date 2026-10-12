# pi-agent-server · SVG 图标库

参考图：`pi-agent-server-tabs-order-only.png`（用户确认的 1774×887 设计图），并补充同一轮 UI 讨论中涉及的备用状态图标。

**注意：原设计图是 PNG，无法提取原始 SVG 源码。本文件包是根据视觉样式重新绘制的可编辑 SVG，并非源项目中图标的精确原件。**

共 **30** 个独立 SVG。其中「✓」是最终设计图中出现的，标「补充」的是额外复用图标。

| 文件 | 中文名 | 分类 | 来源 |
|---|---|---|---|
| `brand-pi.svg` | π 标志 | 品牌 | ✓ |
| `panel-left.svg` | 收起侧栏 | 导航 | ✓ |
| `plus.svg` | 添加 | 导航 | ✓ |
| `plus-neutral.svg` | 添加（中性） | 导航 | ✓ |
| `folder.svg` | 项目文件夹 | 导航 | ✓ |
| `chevron-right.svg` | 右箭头 | 导航 | ✓ |
| `chevron-down.svg` | 向下展开 | 导航 | ✓ |
| `chevron-up.svg` | 向上收起 | 导航 | ✓ |
| `search.svg` | 搜索 | 导航 | ✓ |
| `moon.svg` | 深色模式 | 导航 | ✓ |
| `sun.svg` | 浅色模式 | 导航 | 补充 |
| `more-horizontal.svg` | 更多操作 | 导航 | ✓ |
| `close.svg` | 关闭 | 导航 | ✓ |
| `sparkles.svg` | 助手思考 | 会话 | ✓ |
| `user.svg` | 用户消息 | 步骤 | ✓ |
| `terminal.svg` | 工具调用 / bash | 步骤 | ✓ |
| `file-text.svg` | 工具结果 | 步骤 | ✓ |
| `hourglass.svg` | 等待子代理 | 步骤 | ✓ |
| `check-circle.svg` | 完成成功 | 状态 | ✓ |
| `check-mini.svg` | 校验通过 | 状态 | ✓ |
| `error-circle.svg` | 运行失败 | 状态 | 补充 |
| `step-number.svg` | 步骤序号 1 | 步骤 | ✓ |
| `steer.svg` | 引导队列 | 队列 | ✓ |
| `clock.svg` | 追加队列 | 队列 | ✓ |
| `trash.svg` | 删除队列消息 | 队列 | ✓ |
| `send.svg` | 发送消息 | 输入 | ✓ |
| `stop.svg` | 停止执行 | 输入 | 补充 |
| `paperclip.svg` | 附件 | 输入 | 补充 |
| `copy.svg` | 复制 | 扩展 | 补充 |
| `edit.svg` | 编辑 | 扩展 | 补充 |

## 使用

所有通用图标按 **24×24** `viewBox` 制作，线条一般为 `stroke-width=1.8`；品牌 Logo 为 64×64。可按需要设置 `width` / `height`，建议实际显示为 16–20px，Logo 为 32–40px。

将 SVG 作为独立文件使用：

```html
<img src="/icons/search.svg" width="18" height="18" alt="搜索" />
<img src="/icons/brand-pi.svg" width="36" height="36" alt="pi-agent-server" />
```

也可以将 SVG 内容内联进 React/JSX 组件，使用 CSS 设置 `color` 改变采用 `currentColor` 的描边颜色。独立 `.svg` 使用 `<img>` 时，外层 CSS `color` 无法改变 SVG 内的 `currentColor`，这时请内联 SVG 或修改文件自身的 `color` 属性。

### 色值
- 蓝色强调 `#0868F9`
- 主要中性色 `#334155`
- 辅助图标 `#64748B`
- 成功 `#0AAF6B`
- 失败 `#E02433`
- 追加队列 `#E98A08`

### 目录
- `svg/*.svg`：所有独立 SVG，便于逐个引用 / 调整
- `icons-sprite.svg`：可选 SVG symbol 集合（使用时先注入文档 DOM）
- `icons-preview.png`：所有图标预览

### 关于步骤数字
- `step-number.svg` 为设计图中的序号「1」示例；实际前端建议用圆形 HTML + 动态文本显示 1、2、3…，避免每个序号都做成单独 SVG 文件。
