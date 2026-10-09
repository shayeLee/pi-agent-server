import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  ArrowLeft, ArrowUp, Brain, Check, ChevronDown, ChevronsUpDown, Ellipsis, FilePenLine, FileText,
  Folder, Languages, Moon, PanelLeft, PanelRight, Paperclip, Pencil, Plus, Search, Sun, Terminal, Trash2,
} from "lucide-react";
import { useI18n, type Locale } from "../i18n/index.js";
import { useColorScheme } from "../ui/theme.js";
import { cn } from "../ui/lib/cn.js";
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger, Input, Kbd, Separator, Spinner, StatusDot, Textarea,
  Tooltip, TooltipProvider, useConfirm, type RunStatus,
} from "../ui/primitives/index.js";

const SURFACES = ["canvas", "sidebar", "surface", "raised", "sunken"] as const;
const TEXT = ["fg", "fg-muted", "fg-subtle", "fg-faint"] as const;
const STATUS = ["accent", "success", "warning", "danger"] as const;
const SURFACE_CLASS: Record<(typeof SURFACES)[number], string> = {
  canvas: "bg-canvas", sidebar: "bg-sidebar", surface: "bg-surface", raised: "bg-raised shadow-popover", sunken: "bg-sunken",
};
const TEXT_CLASS: Record<(typeof TEXT)[number], string> = {
  fg: "text-fg", "fg-muted": "text-fg-muted", "fg-subtle": "text-fg-subtle", "fg-faint": "text-fg-faint",
};
const STATUS_CLASS: Record<(typeof STATUS)[number], [string, string]> = {
  accent: ["bg-accent", "bg-accent-soft text-accent-text"],
  success: ["bg-success", "bg-success-soft text-success"],
  warning: ["bg-warning", "bg-warning-soft text-warning"],
  danger: ["bg-danger", "bg-danger-soft text-danger"],
};
const TYPE_SCALE = [
  ["text-2xl font-semibold tracking-tight", "2xl · 22/30 · 600"],
  ["text-xl font-semibold tracking-tight", "xl · 18/26 · 600"],
  ["text-lg font-medium", "lg · 16/24 · 500"],
  ["text-chat", "chat · 15/26 · 400"],
  ["text-base", "base · 14/20 · 400"],
  ["text-sm text-fg-muted", "sm · 13/18 · 400"],
  ["text-xs text-fg-subtle", "xs · 12/16 · 400"],
  ["font-code text-sm", "code · 13/18 mono"],
] as const;

export default function DesignSystemPage() {
  const { t, locale, setLocale } = useI18n();
  const { theme, toggleTheme } = useColorScheme();
  return (
    <TooltipProvider>
      <div data-ui="" className="min-h-screen bg-canvas text-fg">
        <header className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-border bg-canvas/85 px-4 backdrop-blur">
          <Button asChild variant="ghost" size="sm">
            <Link to="/"><ArrowLeft />{t("design.backToApp")}</Link>
          </Button>
          <Separator orientation="vertical" className="mx-1 h-4" />
          <h1 className="text-sm font-semibold">{t("design.title")}</h1>
          <span className="hidden text-sm text-fg-subtle sm:inline">{t("design.subtitle")}</span>
          <div className="ml-auto flex items-center gap-1">
            <DropdownMenu>
              <Tooltip content={t("design.locale")}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={t("design.locale")}><Languages /></Button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={locale} onValueChange={(value) => setLocale(value as Locale)}>
                  <DropdownMenuRadioItem value="zh-CN">简体中文</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip content={theme === "dark" ? t("theme.toLight") : t("theme.toDark")}>
              <Button variant="ghost" size="icon-sm" onClick={toggleTheme} data-testid="design-theme-toggle"
                aria-label={theme === "dark" ? t("theme.toLight") : t("theme.toDark")}>
                {theme === "dark" ? <Sun /> : <Moon />}
              </Button>
            </Tooltip>
          </div>
        </header>

        <main className="mx-auto flex max-w-[1080px] flex-col gap-12 px-6 py-10">
          <Section title={t("design.preview")}>
            <WorkspacePreview />
          </Section>

          <Section title={t("design.colors")}>
            <div className="grid gap-6 md:grid-cols-3">
              <Group label={t("design.surfaces")}>
                {SURFACES.map((name) => (
                  <div key={name} className="flex items-center gap-3">
                    <span className={cn("size-8 rounded-md border border-border", SURFACE_CLASS[name])} />
                    <code className="font-code text-xs text-fg-muted">{name}</code>
                  </div>
                ))}
              </Group>
              <Group label={t("design.text")}>
                {TEXT.map((name) => (
                  <div key={name} className="flex items-baseline gap-3">
                    <span className={cn("w-16 text-base font-medium", TEXT_CLASS[name])}>Aa 文本</span>
                    <code className="font-code text-xs text-fg-muted">{name}</code>
                  </div>
                ))}
              </Group>
              <Group label={t("design.status")}>
                {STATUS.map((name) => (
                  <div key={name} className="flex items-center gap-3">
                    <span className={cn("size-8 rounded-md", STATUS_CLASS[name][0])} />
                    <span className={cn("rounded-sm px-1.5 py-0.5 text-xs font-medium", STATUS_CLASS[name][1])}>{name}-soft</span>
                  </div>
                ))}
              </Group>
            </div>
          </Section>

          <Section title={t("design.typography")}>
            <div className="flex flex-col gap-3">
              {TYPE_SCALE.map(([className, label]) => (
                <div key={label} className="flex items-baseline gap-6">
                  <code className="w-40 shrink-0 font-code text-xs text-fg-subtle">{label}</code>
                  <span className={className}>智能体工作区 Agent workspace 0123</span>
                </div>
              ))}
            </div>
          </Section>

          <Section title={t("design.radius")}>
            <div className="flex flex-wrap items-end gap-6">
              {(["rounded-xs", "rounded-sm", "rounded-md", "rounded-lg", "rounded-xl"] as const).map((radius) => (
                <div key={radius} className="flex flex-col items-center gap-2">
                  <span className={cn("size-14 border border-border-strong bg-surface", radius)} />
                  <code className="font-code text-xs text-fg-subtle">{radius.replace("rounded-", "")}</code>
                </div>
              ))}
              {(["shadow-composer", "shadow-popover", "shadow-dialog"] as const).map((shadow) => (
                <div key={shadow} className="flex flex-col items-center gap-2">
                  <span className={cn("size-14 rounded-lg bg-raised", shadow)} />
                  <code className="font-code text-xs text-fg-subtle">{shadow.replace("shadow-", "")}</code>
                </div>
              ))}
            </div>
          </Section>

          <Section title={t("design.buttons")}>
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary"><Plus />{t("sidebar.newSession")}</Button>
                <Button>{t("common.rename")}</Button>
                <Button variant="ghost">{t("common.cancel")}</Button>
                <Button variant="danger"><Trash2 />{t("common.delete")}</Button>
                <Button variant="danger-ghost">{t("common.delete")}</Button>
                <Button variant="link">{t("common.retry")}</Button>
                <Button disabled>{t("common.confirm")}</Button>
                <Button variant="primary" disabled><Spinner className="text-on-accent" />{t("common.loading")}</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="xs">xs</Button>
                <Button size="sm">sm</Button>
                <Button size="md">md</Button>
                <Button size="lg">lg</Button>
                <Separator orientation="vertical" className="mx-2 h-5" />
                {[
                  [PanelLeft, t("sidebar.collapse"), "⌘B"],
                  [Search, t("sidebar.search"), "⌘K"],
                  [PanelRight, t("run.panel"), "⌘J"],
                ].map(([Icon, label, key]) => {
                  const IconComponent = Icon as typeof PanelLeft;
                  return (
                    <Tooltip key={label as string} content={<span className="flex items-center gap-2">{label as string}<span className="opacity-60">{key as string}</span></span>}>
                      <Button variant="ghost" size="icon" aria-label={label as string}><IconComponent /></Button>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          </Section>

          <Section title={t("design.inputs")}>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-3">
                <Input placeholder={t("sidebar.search")} />
                <Input aria-invalid defaultValue="/not/a/directory" />
                <Textarea placeholder={t("composer.placeholder")} />
              </div>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>claude-sonnet</Badge>
                  <Badge tone="outline">thinking: high</Badge>
                  <Badge tone="accent">{t("status.running")}</Badge>
                  <Badge tone="success"><Check />{t("status.done")}</Badge>
                  <Badge tone="warning">{t("status.queued")}</Badge>
                  <Badge tone="danger">{t("status.error")}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-sm text-fg-muted">
                  {(["running", "queued", "done", "error", "aborted", "idle"] as RunStatus[]).map((status) => (
                    <span key={status} className="inline-flex items-center gap-2">
                      <StatusDot status={status} />{t(`status.${status}`)}
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 text-sm text-fg-subtle">
                  <Kbd>⌘</Kbd><Kbd>K</Kbd><span className="ml-1">{t("sidebar.search")}</span>
                </div>
              </div>
            </div>
          </Section>

          <Section title={t("design.overlays")}>
            <OverlayDemo />
          </Section>
        </main>
      </div>
    </TooltipProvider>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{title}</h2>
      {children}
    </section>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border p-4">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}

function OverlayDemo() {
  const { t } = useI18n();
  const { confirm, confirmElement } = useConfirm();
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>{t("design.openMenu")}<ChevronDown className="text-fg-subtle" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>{t("design.sampleTitle")}</DropdownMenuLabel>
          <DropdownMenuItem><Pencil />{t("common.rename")}<DropdownMenuShortcut>F2</DropdownMenuShortcut></DropdownMenuItem>
          <DropdownMenuItem><PanelRight />{t("run.panel")}<DropdownMenuShortcut>⌘J</DropdownMenuShortcut></DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem tone="danger"><Trash2 />{t("common.delete")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog>
        <DialogTrigger asChild><Button>{t("design.openDialog")}</Button></DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("design.dialogTitle")}</DialogTitle>
            <DialogDescription>{t("design.dialogBody")}</DialogDescription>
          </DialogHeader>
          <Input className="mt-4" defaultValue={t("design.sampleTitle")} autoFocus />
          <DialogFooter>
            <Button variant="ghost">{t("common.cancel")}</Button>
            <Button variant="primary">{t("common.confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Button variant="danger-ghost" onClick={async () => {
        const ok = await confirm({
          title: t("session.deleteTitle"),
          description: t("session.deleteBody", { title: t("design.sampleTitle") }),
          confirmLabel: t("common.delete"),
          tone: "danger",
        });
        setResult(ok ? t("design.confirmed") : t("design.cancelled"));
      }}>
        <Trash2 />{t("design.openConfirm")}
      </Button>
      {result && <span className="text-sm text-fg-subtle" role="status">{result}</span>}
      {confirmElement}
    </div>
  );
}

type PreviewSession = { title: string; status: RunStatus; active?: boolean };

const PREVIEW_GROUPS: Array<{ label: "date.today" | "date.yesterday" | "date.last7Days"; sessions: PreviewSession[] }> = [
  { label: "date.today", sessions: [
    { title: "修复登录页的表单校验", status: "running", active: true },
    { title: "为 SSE 客户端补充重连测试", status: "done" },
  ] },
  { label: "date.yesterday", sessions: [
    { title: "迁移脚本在 Postgres 上超时", status: "error" },
    { title: "整理 README 双语内容", status: "idle" },
  ] },
  { label: "date.last7Days", sessions: [
    { title: "调研 Radix 与 Tailwind v4 组合", status: "aborted" },
  ] },
];

type PreviewStep = { icon: typeof Terminal; label: ReactNode; meta?: string; state: "done" | "running" };

function WorkspacePreview() {
  const { t } = useI18n();
  const steps: PreviewStep[] = [
    { icon: Brain, label: t("turn.thought", { seconds: 4 }), state: "done" },
    { icon: FileText, label: <>读取 <code className="font-code text-xs">src/login/form.ts</code></>, meta: "120 行", state: "done" },
    { icon: Terminal, label: <code className="font-code text-xs">pnpm test login</code>, meta: "2.4s", state: "done" },
    { icon: FilePenLine, label: <>编辑 <code className="font-code text-xs">src/login/form.ts</code></>, meta: "+12 −3", state: "running" },
  ];
  return (
    <div className="flex h-[560px] overflow-hidden rounded-xl border border-border bg-canvas shadow-composer">
      <aside className="hidden w-(--ui-sidebar-width) shrink-0 flex-col border-r border-border bg-sidebar md:flex">
        <div className="flex h-12 items-center gap-1 px-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start px-2 text-fg" aria-label={t("sidebar.switchProject")}>
                <span className="grid size-5 place-items-center rounded-sm bg-accent text-2xs font-semibold text-on-accent">π</span>
                <span className="truncate">pi-agent-server</span>
                <ChevronsUpDown className="ml-auto size-3.5! text-fg-faint" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuLabel>{t("sidebar.projects")}</DropdownMenuLabel>
              <DropdownMenuItem><Folder />pi-agent-server<Check className="ml-auto text-accent-text!" /></DropdownMenuItem>
              <DropdownMenuItem><Folder />mock-project</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem><Plus />{t("sidebar.addProject")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip content={t("sidebar.collapse")}>
            <Button variant="ghost" size="icon-sm" aria-label={t("sidebar.collapse")}><PanelLeft /></Button>
          </Tooltip>
        </div>
        <div className="flex gap-1 px-2 pb-2">
          <Button variant="secondary" size="sm" className="flex-1 justify-start"><Plus />{t("sidebar.newSession")}</Button>
          <Tooltip content={t("sidebar.search")}>
            <Button variant="ghost" size="icon-sm" aria-label={t("sidebar.search")}><Search /></Button>
          </Tooltip>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {PREVIEW_GROUPS.map((group) => (
            <div key={group.label} className="mt-3 first:mt-1">
              <div className="px-2 pb-1 text-2xs font-medium text-fg-subtle">{t(group.label)}</div>
              {group.sessions.map((session) => (
                <div key={session.title} className={cn(
                  "group flex h-8 items-center gap-2 rounded-md px-2 text-sm",
                  session.active ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
                )}>
                  <StatusDot status={session.status} label={t(`status.${session.status}`)} />
                  <span className="truncate">{session.title}</span>
                  <Ellipsis className="ml-auto size-3.5! text-fg-faint opacity-0 group-hover:opacity-100" />
                </div>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="truncate text-sm font-medium">{t("design.sampleTitle")}</span>
          <Badge tone="accent" className="gap-1.5"><StatusDot status="running" />{t("status.running")}</Badge>
          <Tooltip content={t("run.panel")}>
            <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={t("run.panel")}><PanelRight /></Button>
          </Tooltip>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-conversation flex-col gap-6 px-6 py-6">
            <div className="ml-auto max-w-[80%] rounded-lg bg-sunken px-3.5 py-2 text-chat">
              登录页提交空邮箱时没有任何提示，帮我修一下，并补上测试。
            </div>
            <article className="flex flex-col gap-3">
              <div className="flex flex-col rounded-lg border border-border">
                <div className="flex h-8 items-center gap-2 px-3 text-xs text-fg-subtle">
                  <Spinner className="size-3.5 text-accent-text" />
                  <span>{t("turn.toolRunning", { tool: "edit" })}</span>
                  <span className="ml-auto">{t("turn.steps", { count: steps.length })}</span>
                </div>
                <ol className="border-t border-border py-1">
                  {steps.map((step, index) => (
                    <li key={index} className="flex h-7 items-center gap-2.5 px-3 text-sm text-fg-muted">
                      <step.icon className="size-3.5! text-fg-subtle" />
                      <span className="min-w-0 truncate">{step.label}</span>
                      {step.meta && <span className="ml-auto shrink-0 text-xs text-fg-faint tabular-nums">{step.meta}</span>}
                      {step.state === "running"
                        ? <Spinner className={cn("size-3.5", !step.meta && "ml-auto")} />
                        : <Check className={cn("size-3.5! text-success", !step.meta && "ml-auto")} />}
                    </li>
                  ))}
                </ol>
              </div>
              <p className="text-chat">
                问题在于 <code className="rounded-xs bg-sunken px-1 py-0.5 font-code text-[13px]">validateEmail</code> 对空字符串直接返回了
                <code className="rounded-xs bg-sunken px-1 py-0.5 font-code text-[13px]">true</code>。我已改为先判断必填，再校验格式，并在表单下方显示错误提示。
              </p>
            </article>
          </div>
        </div>
        <div className="mx-auto w-full max-w-conversation px-6 pb-5">
          <div className="rounded-lg border border-border bg-surface shadow-composer focus-within:border-border-strong">
            <div className="px-3.5 pt-3 text-chat text-fg-faint">{t("composer.placeholder")}</div>
            <div className="flex items-center gap-1 p-2">
              <Tooltip content={t("composer.attach")}>
                <Button variant="ghost" size="icon-sm" aria-label={t("composer.attach")}><Paperclip /></Button>
              </Tooltip>
              <Button variant="ghost" size="xs" className="text-fg-subtle">claude-sonnet · high<ChevronDown /></Button>
              <Tooltip content={t("composer.send")}>
                <Button variant="primary" size="icon-sm" className="ml-auto rounded-full" aria-label={t("composer.send")}><ArrowUp /></Button>
              </Tooltip>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
