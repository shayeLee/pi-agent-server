import { useState } from "react";
import type { Project } from "../types.js";

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
    <div className="project-switcher" data-testid="project-switcher">
      <div className="project-row">
        <select
          data-testid="project-select"
          value={active?.id ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          aria-label="选择项目"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="project-actions">
          <button
            className="btn-ghost btn-icon"
            data-testid="new-project"
            onClick={() => setCreating((v) => !v)}
            title="新建项目"
          >
            +
          </button>
          {active && !active.isDefault && (
            <button
              className="btn-danger btn-icon"
              data-testid="delete-project"
              onClick={() => {
                if (window.confirm(`删除项目「${active.name}」及其下全部会话？`)) {
                  onDelete(active.id);
                }
              }}
              title="删除项目"
            >
              删
            </button>
          )}
        </div>
      </div>
      {creating && (
        <div className="project-create" data-testid="project-create-form">
          <input
            data-testid="project-name-input"
            placeholder="项目名"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="项目名"
          />
          <input
            data-testid="project-cwd-input"
            placeholder="工作目录绝对路径（如 /path/to/repo）"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            aria-label="项目工作目录"
          />
          <button data-testid="project-create-submit" onClick={submitCreate}>
            创建
          </button>
        </div>
      )}
    </div>
  );
}
