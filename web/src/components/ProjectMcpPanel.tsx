import { zhCN } from "../i18n/zh-CN.js";
import { useEffect, useId, useState } from "react";
import type { ApiClient, McpExposure, ProjectMcpServer, ProjectMcpSettings } from "pi-agent-server/client";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";

type McpApi = Pick<ApiClient, "getProjectMcp" | "saveProjectMcpServer">;

const EXPOSURES: readonly McpExposure[] = ["direct", "codemode", "deferred", "hidden"];
/** 与服务端一致：direct > codemode = deferred > hidden。 */
const rank = (exposure: McpExposure) => exposure === "direct" ? 2 : exposure === "hidden" ? 0 : 1;
const exposureLabel = (exposure: McpExposure | undefined) => exposure ? zhCN.projectMcp.exposures[exposure] ?? exposure : "";

/**
 * 项目的 MCP server 设置入口。服务未配置目录、项目不可见或读取失败时不显示入口，
 * 这样没接 MCP 的部署看不到任何变化。
 */
export function ProjectMcpButton({ api, projectId, projectName }: { api: McpApi; projectId: string; projectName: string }) {
  const [settings, setSettings] = useState<ProjectMcpSettings | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let current = true;
    setSettings(null);
    setOpen(false);
    api.getProjectMcp(projectId).then(result => { if (current) setSettings(result); }, () => {});
    return () => { current = false; };
  }, [api, projectId]);
  if (!settings?.configured) return null;
  return <>
    <button type="button" className="workbench-search-toggle" data-testid="project-mcp-open"
      aria-label={zhCN.projectMcp.open} title={zhCN.projectMcp.open} onClick={() => setOpen(true)}><Icon name="tool" /></button>
    <Modal open={open} onClose={() => setOpen(false)} title={zhCN.projectMcp.title(projectName)} className="project-mcp-dialog">
      <ProjectMcpPanel api={api} projectId={projectId} settings={settings}
        onSaved={server => setSettings(previous => previous && { ...previous, servers: previous.servers.map(row => row.name === server.name ? server : row) })} />
    </Modal>
  </>;
}

export function ProjectMcpPanel({ api, projectId, settings, onSaved }: { api: McpApi; projectId: string; settings: ProjectMcpSettings; onSaved: (server: ProjectMcpServer) => void }) {
  return <div className="project-mcp" data-testid="project-mcp-panel">
    <p className="project-mcp-note">{zhCN.projectMcp.intro}</p>
    <p className="project-mcp-note">{zhCN.projectMcp.sharedIdentity}</p>
    {!settings.canEdit && <p className="project-mcp-note project-mcp-readonly" role="note">{zhCN.projectMcp.readOnly}</p>}
    {settings.servers.length === 0
      ? <p className="project-mcp-note">{zhCN.projectMcp.empty}</p>
      : <ul className="project-mcp-servers">
        {settings.servers.map(server => <li key={server.name}>
          <ServerRow api={api} projectId={projectId} server={server} canEdit={settings.canEdit} onSaved={onSaved} />
        </li>)}
      </ul>}
  </div>;
}

type Draft = { enabled: boolean; exposure: McpExposure | ""; hiddenTools: string };
const draftOf = (server: ProjectMcpServer): Draft => ({
  enabled: server.enabled,
  exposure: server.updatedAt !== null && server.exposure && server.exposure !== server.defaultExposure ? server.exposure : "",
  hiddenTools: server.hiddenTools.join(", "),
});
const parseTools = (text: string) => [...new Set(text.split(/[\s,，]+/).filter(Boolean))];

function ServerRow({ api, projectId, server, canEdit, onSaved }: { api: McpApi; projectId: string; server: ProjectMcpServer; canEdit: boolean; onSaved: (server: ProjectMcpServer) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(server));
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string }>({ kind: "idle" });
  useEffect(() => { setDraft(draftOf(server)); }, [server]);
  const available = server.status === "available";
  const editable = canEdit && available;
  const initial = draftOf(server);
  const dirty = draft.enabled !== initial.enabled || draft.exposure !== initial.exposure || parseTools(draft.hiddenTools).join(",") !== parseTools(initial.hiddenTools).join(",");
  const update = (patch: Partial<Draft>) => { setDraft(previous => ({ ...previous, ...patch })); setState({ kind: "idle" }); };
  const options = EXPOSURES.filter(exposure => !server.maxExposure || rank(exposure) <= rank(server.maxExposure));

  async function save() {
    setState({ kind: "saving" });
    try {
      const { server: saved } = await api.saveProjectMcpServer(projectId, server.name, {
        enabled: draft.enabled, exposure: draft.exposure === "" ? null : draft.exposure, hiddenTools: parseTools(draft.hiddenTools),
      });
      onSaved(saved);
      setState({ kind: "saved" });
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  }

  return <form className={`project-mcp-server${available ? "" : " project-mcp-missing"}`} data-testid="project-mcp-server" data-server={server.name} aria-labelledby={`${id}-name`}
    onSubmit={event => { event.preventDefault(); if (editable && dirty) void save(); }}>
    <div className="project-mcp-server-head">
      <label className="project-mcp-toggle">
        <input type="checkbox" checked={draft.enabled} disabled={!editable || (!draft.enabled && !server.canEnable)}
          onChange={event => update({ enabled: event.target.checked })} aria-describedby={`${id}-desc`} />
        <span id={`${id}-name`} className="project-mcp-server-name">{server.name}</span>
      </label>
      {server.transport && <span className="project-mcp-badge">{server.transport}</span>}
      {server.adminOnly && <span className="project-mcp-badge">{zhCN.projectMcp.adminOnly}</span>}
    </div>
    <p id={`${id}-desc`} className="project-mcp-server-desc">{available ? server.description : zhCN.projectMcp.missing}</p>
    {available && <div className="project-mcp-fields">
      <label>
        <span>{zhCN.projectMcp.exposure}</span>
        <select value={draft.exposure} disabled={!editable} onChange={event => update({ exposure: event.target.value as Draft["exposure"] })}>
          <option value="">{zhCN.projectMcp.defaultExposure(exposureLabel(server.defaultExposure))}</option>
          {options.map(exposure => <option key={exposure} value={exposure}>{exposureLabel(exposure)}</option>)}
        </select>
      </label>
      <label>
        <span>{zhCN.projectMcp.hiddenTools}</span>
        <input value={draft.hiddenTools} disabled={!editable} placeholder={editable ? zhCN.projectMcp.hiddenToolsHint : undefined} title={zhCN.projectMcp.hiddenToolsHint}
          onChange={event => update({ hiddenTools: event.target.value })} />
      </label>
    </div>}
    {editable && <div className="project-mcp-actions">
      <span className={`project-mcp-status${state.kind === "error" ? " project-mcp-error" : ""}`} role="status">
        {state.kind === "saved" ? zhCN.projectMcp.saved : state.kind === "error" ? zhCN.projectMcp.saveFailed(state.message) : ""}
      </span>
      <button type="submit" className="project-mcp-save" disabled={!dirty || state.kind === "saving"}>
        {state.kind === "saving" ? zhCN.projectMcp.saving : zhCN.projectMcp.save}
      </button>
    </div>}
  </form>;
}

/** ApiError 的 message 是 `HTTP 403: {json}`；优先取服务端给出的说明。 */
function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const body = text.replace(/^HTTP \d+: /, "");
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch { /* 不是 JSON，原样显示 */ }
  return text;
}
