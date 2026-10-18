import { zhCN } from "../i18n/zh-CN.js";
import { formatDateTime } from "../i18n/format.js";
import { useCallback, useEffect, useId, useState } from "react";
import type { ApiClient, McpConnection, McpExposure, ProjectMcpServer, ProjectMcpSettings } from "pi-agent-server/client";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";
import { clearMcpOAuthReturn, peekMcpOAuthReturn, rememberMcpOAuthReturnPath, type McpOAuthReturn } from "../mcp-oauth-return.js";

type McpApi = Pick<ApiClient, "getProjectMcp" | "saveProjectMcpServer" | "listMcpConnections" | "startMcpOAuth" | "disconnectMcp">;
/** null：调用者不能连接（viewer）或服务没有需要个人授权的 server。 */
type Connections = readonly McpConnection[] | null;

const EXPOSURES: readonly McpExposure[] = ["direct", "codemode", "deferred", "hidden"];
/** 与服务端一致：direct > codemode = deferred > hidden。 */
const rank = (exposure: McpExposure) => exposure === "direct" ? 2 : exposure === "hidden" ? 0 : 1;
const exposureLabel = (exposure: McpExposure | undefined) => exposure ? zhCN.projectMcp.exposures[exposure] ?? exposure : "";

/**
 * 项目的 MCP server 设置入口。服务未配置目录、项目不可见或读取失败时不显示入口，
 * 这样没接 MCP 的部署看不到任何变化。从授权页回来时自动打开并显示结果。
 */
export function ProjectMcpButton({ api, projectId, projectName }: { api: McpApi; projectId: string; projectName: string }) {
  const [settings, setSettings] = useState<ProjectMcpSettings | null>(null);
  const [connections, setConnections] = useState<Connections>(null);
  const [open, setOpen] = useState(false);
  const [returned, setReturned] = useState<McpOAuthReturn | null>(null);
  const refreshConnections = useCallback(() => api.listMcpConnections().then(
    result => setConnections(result.servers), () => setConnections(null)), [api]);
  useEffect(() => {
    let current = true;
    setSettings(null);
    setOpen(false);
    api.getProjectMcp(projectId).then(result => {
      if (!current) return;
      setSettings(result);
      const back = peekMcpOAuthReturn();
      if (result.configured && back) { setReturned(back); setOpen(true); }
    }, () => {});
    return () => { current = false; };
  }, [api, projectId]);
  const personal = settings?.servers.some(server => server.oauthLabel) ?? false;
  useEffect(() => { if (personal) void refreshConnections(); }, [personal, refreshConnections]);
  if (!settings?.configured) return null;
  const close = () => { setOpen(false); setReturned(null); clearMcpOAuthReturn(); };
  return <>
    <button type="button" className="workbench-search-toggle" data-testid="project-mcp-open"
      aria-label={zhCN.projectMcp.open} title={zhCN.projectMcp.open} onClick={() => setOpen(true)}><Icon name="tool" /></button>
    <Modal open={open} onClose={close} title={zhCN.projectMcp.title(projectName)} className="project-mcp-dialog">
      {returned && <ReturnNotice returned={returned} settings={settings} onDismiss={() => { setReturned(null); clearMcpOAuthReturn(); }} />}
      <ProjectMcpPanel api={api} projectId={projectId} settings={settings} connections={connections} onConnectionsChanged={refreshConnections}
        onSaved={server => setSettings(previous => previous && { ...previous, servers: previous.servers.map(row => row.name === server.name ? server : row) })} />
    </Modal>
  </>;
}

function ReturnNotice({ returned, settings, onDismiss }: { returned: McpOAuthReturn; settings: ProjectMcpSettings; onDismiss: () => void }) {
  const label = settings.servers.find(server => server.name === returned.server)?.oauthLabel ?? returned.server ?? "";
  const ok = returned.result === "connected";
  const text = ok ? zhCN.projectMcp.returned.connected(label) : zhCN.projectMcp.returned.failed[returned.result] ?? zhCN.projectMcp.returned.unknown;
  return <div className={`project-mcp-returned${ok ? "" : " project-mcp-error"}`} role={ok ? "status" : "alert"} data-testid="project-mcp-returned">
    <span>{text}</span>
    <button type="button" className="project-mcp-link" onClick={onDismiss}>{zhCN.projectMcp.dismiss}</button>
  </div>;
}

export function ProjectMcpPanel({ api, projectId, settings, connections = null, onConnectionsChanged = async () => {}, onSaved }: {
  api: McpApi; projectId: string; settings: ProjectMcpSettings; connections?: Connections;
  onConnectionsChanged?: () => Promise<void>; onSaved: (server: ProjectMcpServer) => void;
}) {
  const personal = settings.servers.some(server => server.oauthLabel);
  const shared = settings.servers.some(server => server.status === "available" && !server.oauthLabel);
  return <div className="project-mcp" data-testid="project-mcp-panel">
    <p className="project-mcp-note">{zhCN.projectMcp.intro}</p>
    {shared && <p className="project-mcp-note">{zhCN.projectMcp.sharedIdentity}</p>}
    {personal && <p className="project-mcp-note">{zhCN.projectMcp.personalIdentity}</p>}
    {!settings.canEdit && <p className="project-mcp-note project-mcp-readonly" role="note">{zhCN.projectMcp.readOnly}</p>}
    {settings.servers.length === 0
      ? <p className="project-mcp-note">{zhCN.projectMcp.empty}</p>
      : <ul className="project-mcp-servers">
        {settings.servers.map(server => <li key={server.name}>
          <ServerRow api={api} projectId={projectId} server={server} canEdit={settings.canEdit} onSaved={onSaved}
            connections={connections} onConnectionsChanged={onConnectionsChanged} />
        </li>)}
      </ul>}
  </div>;
}

/** 个人授权 server 的连接状态与“连接 / 断开”。连接会整页跳到对方授权页。 */
function ConnectionRow({ api, server, connections, onChanged }: { api: McpApi; server: ProjectMcpServer & { oauthLabel: string }; connections: Connections; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<{ kind: "idle" | "connecting" | "disconnecting" } | { kind: "error"; message: string }>({ kind: "idle" });
  const connection = connections?.find(row => row.name === server.name);
  const label = server.oauthLabel;
  async function connect() {
    setState({ kind: "connecting" });
    try {
      const { authorizationUrl } = await api.startMcpOAuth(server.name);
      rememberMcpOAuthReturnPath();
      window.location.assign(authorizationUrl);
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  }
  async function disconnect() {
    setState({ kind: "disconnecting" });
    try {
      await api.disconnectMcp(server.name);
      await onChanged();
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  }
  const status = connections === null ? zhCN.projectMcp.connection.unavailable
    : connection?.connected
      ? connection.account ? zhCN.projectMcp.connection.connectedAs(connection.account)
        : zhCN.projectMcp.connection.connectedAt(formatDateTime(connection.connectedAt ?? Date.now()))
      : zhCN.projectMcp.connection.notConnected(label);
  return <div className="project-mcp-connection" data-testid="project-mcp-connection">
    <span className="project-mcp-connection-status">{status}</span>
    {connections !== null && (connection?.connected
      ? <button type="button" className="project-mcp-link" disabled={state.kind === "disconnecting"} onClick={() => void disconnect()}>
        {state.kind === "disconnecting" ? zhCN.projectMcp.connection.disconnecting : zhCN.projectMcp.connection.disconnect}</button>
      : <button type="button" className="project-mcp-save" disabled={state.kind === "connecting"} onClick={() => void connect()}>
        {state.kind === "connecting" ? zhCN.projectMcp.connection.connecting : zhCN.projectMcp.connection.connect(label)}</button>)}
    {state.kind === "error" && <span className="project-mcp-status project-mcp-error" role="alert">{zhCN.projectMcp.connection.failed(state.message)}</span>}
  </div>;
}

type Draft = { enabled: boolean; exposure: McpExposure | ""; hiddenTools: string };
const draftOf = (server: ProjectMcpServer): Draft => ({
  enabled: server.enabled,
  exposure: server.updatedAt !== null && server.exposure && server.exposure !== server.defaultExposure ? server.exposure : "",
  hiddenTools: server.hiddenTools.join(", "),
});
const parseTools = (text: string) => [...new Set(text.split(/[\s,，]+/).filter(Boolean))];

function ServerRow({ api, projectId, server, canEdit, onSaved, connections, onConnectionsChanged }: {
  api: McpApi; projectId: string; server: ProjectMcpServer; canEdit: boolean; onSaved: (server: ProjectMcpServer) => void;
  connections: Connections; onConnectionsChanged: () => Promise<void>;
}) {
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
      {server.oauthLabel && <span className="project-mcp-badge">{zhCN.projectMcp.personal}</span>}
    </div>
    <p id={`${id}-desc`} className="project-mcp-server-desc">{available ? server.description : zhCN.projectMcp.missing}</p>
    {available && server.oauthLabel && <ConnectionRow api={api} server={{ ...server, oauthLabel: server.oauthLabel }} connections={connections} onChanged={onConnectionsChanged} />}
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
