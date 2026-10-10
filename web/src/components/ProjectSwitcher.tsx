import { useState } from "react";
import { Icon } from "./Icon.js";
import type { Project } from "pi-agent-server/client";
import { SelectMenu } from "./SelectMenu.js";

export type ProjectSwitcherProps = {
  projects: Project[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string, cwd: string) => void;
  onDelete: (id: string) => void;
};

/** 项目切换器：下拉选择 + 新建/删除额外项目（默认项目不可删）。 */
export function ProjectSwitcher({ projects, activeId, onSelect, onCreate, onDelete }: ProjectSwitcherProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");

  const active = projects.find((p) => p.id === activeId) ?? projects[0];

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
    <div className="project-switcher workbench-project-tree px-4" data-testid="project-switcher">
      <div className="project-row workbench-project-row flex min-w-0 items-center gap-1">
        <span className="workbench-project-icon grid size-6 shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
          <Icon name="folder" />
        </span>
        <SelectMenu
          className="workbench-project-select min-w-0 flex-1"
          options={projects.map((project) => ({ value: project.id, label: project.name, title: project.cwd }))}
          value={active?.id ?? ""}
          onChange={onSelect}
          ariaLabel="选择项目"
          testId="project-select"
        />
        <div className="project-actions workbench-project-actions flex shrink-0">
          <button
            className="btn-ghost btn-icon grid h-[44px] w-[44px] place-items-center rounded-md p-0 text-muted-foreground hover:bg-sidebar-accent"
            data-testid="new-project"
            onClick={() => setCreating((v) => !v)}
            title="新建项目"
            aria-label="新建项目"
          >
            <Icon name="plus" />
          </button>
          {active && !active.isDefault && active.canDelete !== false && (
            <button
              className="btn-danger btn-icon grid size-8 place-items-center rounded-md text-destructive hover:bg-destructive/10"
              data-testid="delete-project"
              onClick={() => {
                if (window.confirm(`删除项目「${active.name}」及其下全部会话？`)) {
                  onDelete(active.id);
                }
              }}
              title="删除项目"
              aria-label="删除项目"
            >
              <Icon name="trash" />
            </button>
          )}
        </div>
      </div>
      {creating && (
        <div className="project-create workbench-project-create mt-2 flex flex-col gap-1.5" data-testid="project-create-form">
          <input
            className="h-8 rounded-md border border-border bg-background px-2 text-[13px] outline-none focus:border-primary"
            data-testid="project-name-input"
            placeholder="项目名"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="项目名"
          />
          <input
            className="h-8 rounded-md border border-border bg-background px-2 text-[13px] outline-none focus:border-primary"
            data-testid="project-cwd-input"
            placeholder="工作目录绝对路径（如 /path/to/repo）"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            aria-label="项目工作目录"
          />
          <button className="h-8 rounded-md bg-primary px-2 text-[13px] font-medium text-primary-foreground" data-testid="project-create-submit" onClick={submitCreate}>
            创建
          </button>
        </div>
      )}
    </div>
  );
}
