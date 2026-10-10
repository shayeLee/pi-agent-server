export type Locale = "zh" | "en";

export type MessageKey = keyof typeof zh;

const zh = {
  "app.brand": "pi-agent-server",
  "nav.newSession": "新建会话",
  "nav.projectsSection": "工作区 / 项目",
  "nav.sessionsSection": "会话历史",
  "theme.toggleToLight": "切换为亮色主题",
  "theme.toggleToDark": "切换为暗色主题",
  "loading": "加载中…",
  "projects.retry": "重试加载项目",
  "mobile.openNav": "打开工作区导航",
  "mobile.closeNav": "关闭工作区导航",
  "inspector.close": "关闭审查器",
} as const;

const en: Record<MessageKey, string> = {
  "app.brand": "pi-agent-server",
  "nav.newSession": "New session",
  "nav.projectsSection": "Workspace / Projects",
  "nav.sessionsSection": "Session history",
  "theme.toggleToLight": "Switch to light theme",
  "theme.toggleToDark": "Switch to dark theme",
  "loading": "Loading…",
  "projects.retry": "Retry loading projects",
  "mobile.openNav": "Open workspace navigation",
  "mobile.closeNav": "Close workspace navigation",
  "inspector.close": "Close inspector",
};

export const catalogs: Record<Locale, Record<MessageKey, string>> = { zh, en };

export function t(locale: Locale, key: MessageKey): string {
  return catalogs[locale][key] ?? catalogs.en[key] ?? key;
}

export function detectLocale(): Locale {
  const lang = document.documentElement.lang?.toLowerCase() ?? "";
  if (lang.startsWith("en")) return "en";
  return "zh";
}
