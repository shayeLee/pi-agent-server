/**
 * Source-of-truth string table. Keys are flat and dot-scoped by surface;
 * `{name}` placeholders are filled by `t()`. Other locales must provide the same keys.
 */
export const zhCN = {
  "app.name": "pi-agent-server",

  "common.cancel": "取消",
  "common.confirm": "确定",
  "common.delete": "删除",
  "common.rename": "重命名",
  "common.retry": "重试",
  "common.close": "关闭",
  "common.loading": "加载中…",
  "common.more": "更多操作",

  "theme.toLight": "切换为亮色主题",
  "theme.toDark": "切换为暗色主题",
  "theme.light": "亮色",
  "theme.dark": "暗色",

  "sidebar.newSession": "新建会话",
  "sidebar.search": "搜索会话",
  "sidebar.collapse": "折叠侧边栏",
  "sidebar.expand": "展开侧边栏",
  "sidebar.projects": "项目",
  "sidebar.switchProject": "切换项目",
  "sidebar.addProject": "添加项目",
  "sidebar.empty": "暂无会话",

  "date.today": "今天",
  "date.yesterday": "昨天",
  "date.last7Days": "最近 7 天",
  "date.earlier": "更早",

  "status.running": "运行中",
  "status.queued": "排队中",
  "status.idle": "空闲",
  "status.error": "出错",
  "status.aborted": "已中止",
  "status.done": "已完成",

  "turn.thinking": "思考",
  "turn.thought": "已思考 {seconds} 秒",
  "turn.steps": "{count} 个步骤",
  "turn.toolRunning": "正在运行 {tool}",

  "composer.placeholder": "描述任务，Enter 发送，Shift+Enter 换行",
  "composer.send": "发送",
  "composer.stop": "停止",
  "composer.attach": "添加附件",

  "run.panel": "运行详情",
  "run.events": "事件",
  "run.usage": "用量",

  "session.deleteTitle": "删除会话？",
  "session.deleteBody": "“{title}”及其历史记录将被永久删除，此操作无法撤销。",

  "design.title": "设计基础",
  "design.subtitle": "Phase 1 · 设计令牌、主题与基础组件预览",
  "design.colors": "颜色",
  "design.surfaces": "表面",
  "design.text": "文本",
  "design.status": "状态",
  "design.typography": "字体与字号",
  "design.radius": "圆角与阴影",
  "design.buttons": "按钮",
  "design.inputs": "输入",
  "design.overlays": "浮层",
  "design.preview": "工作区预览",
  "design.openMenu": "打开菜单",
  "design.openDialog": "打开对话框",
  "design.openConfirm": "删除确认",
  "design.dialogTitle": "重命名会话",
  "design.dialogBody": "新的名称会显示在侧边栏和会话标题中。",
  "design.confirmed": "已确认",
  "design.cancelled": "已取消",
  "design.sampleTitle": "修复登录页的表单校验",
  "design.backToApp": "返回应用",
  "design.locale": "语言",
} as const;

export type MessageKey = keyof typeof zhCN;
export type Messages = Record<MessageKey, string>;
