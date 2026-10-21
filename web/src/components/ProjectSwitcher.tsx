import { zhCN } from "../i18n/zh-CN.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Project } from "pi-agent-server/client";
import { SelectMenu } from "./SelectMenu.js";

export type ProjectSwitcherProps = {
  projects: Project[];
  children?: ReactNode;
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string, cwd: string) => void;
};

/** 项目切换器：下拉选择 + 新建项目（Web UI 不提供项目删除）。 */
export function ProjectSwitcher({ projects, activeId, onSelect, onCreate, children }: ProjectSwitcherProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const active = projects.find((p) => p.id === activeId) ?? projects[0];

  useEffect(() => {
    if (creating) {
      nameInputRef.current?.focus();
    }
  }, [creating]);

  function cancelCreate(): void {
    setName("");
    setCwd("");
    setCreating(false);
    document.querySelector<HTMLElement>('[data-testid="project-select"]')?.focus();
  }

  function submitCreate(): void {
    const n = name.trim();
    const c = cwd.trim();
    if (!n || !c) return;
    onCreate(n, c);
    setName("");
    setCwd("");
    setCreating(false);
  }

  return (
    <div className="project-switcher workbench-project-tree" data-testid="project-switcher">
      <div ref={rowRef} className="project-row workbench-project-row">
        <SelectMenu
          className="workbench-project-select"
          anchorRef={rowRef}
          chevronIcon="project-chevron-down"
          openChevronIcon="project-chevron-up"
          options={projects.map((project) => ({
            value: project.id,
            label: project.name,
            title: project.cwd,
          }))}
          action={{
            label: zhCN.project.newProject,
            testId: "new-project",
            onSelect: () => setCreating(true),
          }}
          checkPosition="left"
          value={active?.id ?? ""}
          onChange={onSelect}
          placeholder={zhCN.project.defaultProject}
          ariaLabel={zhCN.project.select}
          testId="project-select"
        />
        {children}
      </div>
      {creating && (
        <form
          className="project-create workbench-project-create"
          data-testid="project-create-form"
          role="dialog"
          aria-label={zhCN.project.newProject}
          onSubmit={(e) => {
            e.preventDefault();
            submitCreate();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancelCreate();
            }
          }}
        >
          <input
            ref={nameInputRef}
            data-testid="project-name-input"
            placeholder={zhCN.project.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={zhCN.project.name}
          />
          <input
            data-testid="project-cwd-input"
            placeholder={zhCN.project.directoryPlaceholder}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            aria-label={zhCN.project.directory}
          />
          <div className="project-create-actions">
            <button type="submit" data-testid="project-create-submit">
              {zhCN.project.create}</button>
            <button
              type="button"
              data-testid="project-create-cancel"
              onClick={cancelCreate}
            >
              {zhCN.project.cancel}</button>
          </div>
        </form>
      )}
    </div>
  );
}
