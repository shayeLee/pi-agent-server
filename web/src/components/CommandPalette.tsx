import { FolderOpen, MessageSquare, Moon, PanelLeft, PanelRight, Plus, Sun } from "lucide-react";
import { resolveSessionDisplayTitle, type Project, type SessionRecord } from "pi-agent-server/client";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { useI18n } from "@/i18n/I18nProvider.js";
import { modKey } from "./Kbd.js";

export type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionRecord[] | null;
  projects: Project[] | null;
  activeProjectId: string | null;
  activeSessionId: string | null;
  canCreateSession: boolean;
  hasSession: boolean;
  theme: "light" | "dark";
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onSelectProject: (id: string) => void;
  onToggleSidebar: () => void;
  onToggleRunPanel: () => void;
  onToggleTheme: () => void;
};

/** ⌘K / Ctrl-K palette: navigation and workspace commands only; never sends or mutates server state. */
export function CommandPalette({
  open, onOpenChange, sessions, projects, activeProjectId, activeSessionId, canCreateSession, hasSession, theme,
  onNewSession, onSelectSession, onSelectProject, onToggleSidebar, onToggleRunPanel, onToggleTheme,
}: CommandPaletteProps) {
  const { t } = useI18n();
  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };
  const mod = modKey();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[18%] max-w-[560px] translate-y-0 overflow-hidden p-0"
        data-testid="command-palette"
        hideClose
      >
        <DialogTitle className="sr-only">{t("palette.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("palette.description")}</DialogDescription>
        <Command loop className="rounded-[10px]">
          <CommandInput placeholder={t("palette.placeholder")} aria-label={t("palette.placeholder")} />
          <CommandList className="max-h-[min(380px,60vh)] p-1">
            <CommandEmpty>{t("palette.empty")}</CommandEmpty>
            <CommandGroup heading={t("palette.groupActions")}>
              <CommandItem disabled={!canCreateSession} onSelect={() => run(onNewSession)} value={t("nav.newSession")}>
                <Plus aria-hidden="true" />
                {t("nav.newSession")}
              </CommandItem>
              <CommandItem onSelect={() => run(onToggleSidebar)} value={t("palette.toggleSidebar")}>
                <PanelLeft aria-hidden="true" />
                {t("palette.toggleSidebar")}
                <CommandShortcut>{mod} B</CommandShortcut>
              </CommandItem>
              <CommandItem disabled={!hasSession} onSelect={() => run(onToggleRunPanel)} value={t("palette.toggleRunPanel")}>
                <PanelRight aria-hidden="true" />
                {t("palette.toggleRunPanel")}
                <CommandShortcut>{mod} .</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => run(onToggleTheme)} value={t("palette.toggleTheme")}>
                {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
                {theme === "dark" ? t("theme.toggleToLight") : t("theme.toggleToDark")}
              </CommandItem>
            </CommandGroup>
            {sessions && sessions.length > 0 && (
              <CommandGroup heading={t("palette.groupSessions")}>
                {sessions.map((session) => {
                  const title = resolveSessionDisplayTitle(session);
                  return (
                    <CommandItem
                      key={session.id}
                      value={`${title} ${session.id}`}
                      onSelect={() => run(() => onSelectSession(session.id))}
                      data-active={session.id === activeSessionId || undefined}
                    >
                      <MessageSquare aria-hidden="true" />
                      <span className="truncate">{title}</span>
                      {session.id === activeSessionId && <CommandShortcut>{t("palette.current")}</CommandShortcut>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {projects && projects.length > 1 && (
              <CommandGroup heading={t("palette.groupProjects")}>
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={`${project.name} ${project.cwd} ${project.id}`}
                    onSelect={() => run(() => onSelectProject(project.id))}
                  >
                    <FolderOpen aria-hidden="true" />
                    <span className="truncate">{project.name}</span>
                    {project.id === activeProjectId && <CommandShortcut>{t("palette.current")}</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
