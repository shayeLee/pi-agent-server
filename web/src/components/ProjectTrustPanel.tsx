import { zhCN } from "../i18n/zh-CN.js";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import type { ApiClient, ProjectTrustView } from "pi-agent-server/client";
import { Modal } from "./Modal.js";
import { errorMessage } from "./ProjectMcpPanel.js";

type TrustApi = Pick<ApiClient, "getProjectTrust" | "saveProjectTrust">;

const text = zhCN.projectTrust;

/**
 * 当前项目的信任（Pi 的 trust.json），入口在侧栏底部的“设置”菜单里。所有人能看，只有 admin 能改；
 * 服务没配置或读取失败时 `available` 为 false，菜单不显示这一项。改了之后调用 onChanged，
 * 让依赖信任的 MCP 列表和思考档位重新读取。
 */
export function useProjectTrust({ api, projectId, projectName, onChanged }: {
  api: TrustApi; projectId: string | null; projectName: string; onChanged?: () => void;
}): { available: boolean; openPanel: () => void; dialog: ReactNode } {
  const [trust, setTrust] = useState<ProjectTrustView | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let current = true;
    setTrust(null);
    setOpen(false);
    if (projectId === null) return;
    api.getProjectTrust(projectId).then(result => { if (current) setTrust(result); }, () => {});
    return () => { current = false; };
  }, [api, projectId]);
  const openPanel = useCallback(() => setOpen(true), []);
  if (!trust || projectId === null) return { available: false, openPanel, dialog: null };
  return { available: true, openPanel, dialog: <Modal open={open} onClose={() => setOpen(false)} title={text.title(projectName)} className="project-mcp-dialog">
    <ProjectTrustPanel api={api} projectId={projectId} trust={trust} onSaved={saved => { setTrust(saved); onChanged?.(); }} />
  </Modal> };
}

export function ProjectTrustPanel({ api, projectId, trust, onSaved }: {
  api: TrustApi; projectId: string; trust: ProjectTrustView; onSaved: (trust: ProjectTrustView) => void;
}) {
  const id = useId();
  const [state, setState] = useState<{ kind: "idle" | "saving" } | { kind: "error"; message: string }>({ kind: "idle" });
  async function save(trusted: boolean) {
    setState({ kind: "saving" });
    try {
      onSaved(await api.saveProjectTrust(projectId, trusted));
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  }
  const source = trust.source === "project" ? text.source.project(trust.trusted)
    : trust.source === "parent" ? text.source.parent(trust.trusted, trust.entryPath ?? "")
      : text.source.default(trust.defaultTrust);
  return <div className="project-mcp project-trust" data-testid="project-trust-panel">
    <p className="project-mcp-intro">{text.intro}</p>
    {!trust.canEdit && <p className="project-mcp-intro" role="note"><span className="project-mcp-tag">{zhCN.projectMcp.readOnlyTag}</span>{text.readOnly}</p>}
    <ul className="project-mcp-list">
      <li className={`project-mcp-row${trust.trusted ? " is-enabled" : ""}`}>
        <div className="project-mcp-head">
          <input id={`${id}-trusted`} type="checkbox" className="project-mcp-check" checked={trust.trusted} data-testid="project-trust-toggle"
            disabled={!trust.canEdit || state.kind === "saving"} onChange={event => void save(event.target.checked)} />
          <label htmlFor={`${id}-trusted`} className="project-mcp-name">{text.trusted}</label>
        </div>
        <p className="project-mcp-desc" data-testid="project-trust-source">{source}</p>
        {trust.canEdit && trust.source === "parent" && <p className="project-mcp-desc">{text.parentHint}</p>}
        <p className="project-mcp-status">{text.effect}</p>
      </li>
      <li className="project-mcp-row">
        <div className="project-mcp-head"><span className="project-mcp-name">{text.files}</span></div>
        {trust.files.map(file => <div key={file.name} className="project-mcp-line" data-testid="project-trust-file" data-file={file.name}>
          <span className="project-mcp-key project-trust-file">{file.name}</span>
          <span className={`project-mcp-value${file.exists ? "" : " project-mcp-muted"}`}>
            {file.exists ? text.exists : text.missing} · {text.fileHints[file.name]}
          </span>
        </div>)}
      </li>
    </ul>
    <p className={`project-mcp-status${state.kind === "error" ? " project-mcp-error" : ""}`} role="status">
      {state.kind === "saving" ? text.saving : state.kind === "error" ? text.saveFailed(state.message) : ""}
    </p>
  </div>;
}
