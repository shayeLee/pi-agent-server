import { zhCN } from "../i18n/zh-CN.js";
import { formatDateTime } from "../i18n/format.js";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import type { ApiClient, McpConnection, McpExposure, ProjectMcpServer, ProjectMcpSettings } from "pi-agent-server/client";
import { Modal } from "./Modal.js";
import { SelectMenu } from "./SelectMenu.js";
import { SharedMcpPanel } from "./SharedMcpPanel.js";
import { clearMcpOAuthReturn, peekMcpOAuthReturn, rememberMcpOAuthReturnPath, type McpOAuthReturn } from "../mcp-oauth-return.js";

type McpApi = Pick<ApiClient, "getProjectMcp" | "saveProjectMcpServer" | "listMcpConnections" | "startMcpOAuth" | "disconnectMcp"
  | "getSharedMcp" | "saveSharedMcpServer" | "removeSharedMcpServer">;
/** null：调用者不能连接（viewer）或服务没有需要个人授权的 server。 */
type Connections = readonly McpConnection[] | null;

const EXPOSURES: readonly McpExposure[] = ["direct", "codemode", "deferred", "hidden"];
/** 与服务端一致：direct > codemode = deferred > hidden。 */
const rank = (exposure: McpExposure) => exposure === "direct" ? 2 : exposure === "hidden" ? 0 : 1;
const exposureLabel = (exposure: McpExposure | undefined) => exposure ? zhCN.projectMcp.exposures[exposure] ?? exposure : "";

/**
 * 项目的 MCP server 设置，入口在侧栏底部的“设置”菜单里。服务未配置目录、项目不可见或读取失败时
 * `available` 为 false，菜单不显示这一项，这样没接 MCP 的部署看不到任何变化。
 * 从授权页回来时自动打开面板并显示结果。
 */
export function useProjectMcp({ api, projectId, projectName }: { api: McpApi; projectId: string | null; projectName: string }): {
  available: boolean; openPanel: () => void; dialog: ReactNode;
  /** 重新读取本项目的 MCP 设置（例如项目信任改了之后）。 */
  refresh: () => void;
} {
  const [settings, setSettings] = useState<ProjectMcpSettings | null>(null);
  const [connections, setConnections] = useState<Connections>(null);
  const [open, setOpen] = useState(false);
  const [returned, setReturned] = useState<McpOAuthReturn | null>(null);
  /** admin 能管理共享 MCP，面板顶部多一个“共享 MCP”标签。 */
  const [canManageShared, setCanManageShared] = useState(false);
  const [tab, setTab] = useState<"project" | "shared">("project");
  useEffect(() => {
    let current = true;
    api.getSharedMcp().then(result => { if (current) setCanManageShared(result.canEdit); }, () => {});
    return () => { current = false; };
  }, [api]);
  // 带上项目：项目自己的 .pi/mcp.json 里也可能有需要个人授权的 server，授权按项目分开。
  const refreshConnections = useCallback(() => api.listMcpConnections(projectId ?? undefined).then(
    result => setConnections(result.servers), () => setConnections(null)), [api, projectId]);
  useEffect(() => {
    let current = true;
    setSettings(null);
    setOpen(false);
    if (projectId === null) return;
    api.getProjectMcp(projectId).then(result => {
      if (!current) return;
      setSettings(result);
      const back = peekMcpOAuthReturn();
      if (result.configured && back) { setReturned(back); setTab("project"); setOpen(true); }
    }, () => {});
    return () => { current = false; };
  }, [api, projectId]);
  /** 共享 MCP 改了之后，本项目的列表跟着变。 */
  const refreshSettings = useCallback(() => {
    if (projectId !== null) api.getProjectMcp(projectId).then(setSettings, () => {});
  }, [api, projectId]);
  const personal = settings?.servers.some(server => server.oauthLabel) ?? false;
  useEffect(() => { if (personal) void refreshConnections(); }, [personal, refreshConnections]);
  const openPanel = useCallback(() => setOpen(true), []);
  if (!settings?.configured || projectId === null) return { available: false, openPanel, dialog: null, refresh: refreshSettings };
  const close = () => { setOpen(false); setReturned(null); setTab("project"); clearMcpOAuthReturn(); };
  const showShared = canManageShared && tab === "shared";
  return { available: true, openPanel, refresh: refreshSettings, dialog: <Modal open={open} onClose={close} title={zhCN.projectMcp.title(projectName)} className="project-mcp-dialog">
    {canManageShared && <div className="project-mcp-tabs" role="tablist">
      {(["project", "shared"] as const).map(id => <button key={id} type="button" role="tab" aria-selected={tab === id} data-testid={`project-mcp-tab-${id}`}
        className={`project-mcp-tab${tab === id ? " is-active" : ""}`} onClick={() => setTab(id)}>{zhCN.projectMcp.tabs[id]}</button>)}
    </div>}
    {showShared
      ? <SharedMcpPanel api={api} onChanged={refreshSettings} />
      : <>
        {returned && <ReturnNotice returned={returned} settings={settings} onDismiss={() => { setReturned(null); clearMcpOAuthReturn(); }} />}
        <ProjectMcpPanel api={api} projectId={projectId} settings={settings} connections={connections} onConnectionsChanged={refreshConnections}
          onSaved={server => setSettings(previous => previous && { ...previous, servers: previous.servers.map(row => row.name === server.name ? server : row) })} />
      </>}
  </Modal> };
}

function ReturnNotice({ returned, settings, onDismiss }: { returned: McpOAuthReturn; settings: ProjectMcpSettings; onDismiss: () => void }) {
  const label = settings.servers.find(server => server.name === returned.server)?.oauthLabel ?? returned.server ?? "";
  const ok = returned.result === "connected";
  const text = ok ? zhCN.projectMcp.returned.connected(label) : zhCN.projectMcp.returned.failed[returned.result] ?? zhCN.projectMcp.returned.unknown;
  return <div className={`project-mcp-returned${ok ? "" : " project-mcp-error"}`} role={ok ? "status" : "alert"} data-testid="project-mcp-returned">
    <span>{text}</span>
    <button type="button" className="project-mcp-action" onClick={onDismiss}>{zhCN.projectMcp.dismiss}</button>
  </div>;
}

export function ProjectMcpPanel({ api, projectId, settings, connections = null, onConnectionsChanged = async () => {}, onSaved }: {
  api: McpApi; projectId: string; settings: ProjectMcpSettings; connections?: Connections;
  onConnectionsChanged?: () => Promise<void>; onSaved: (server: ProjectMcpServer) => void;
}) {
  const available = settings.servers.filter(server => server.status === "available");
  const missing = settings.servers.filter(server => server.status !== "available");
  return <div className="project-mcp" data-testid="project-mcp-panel">
    <p className="project-mcp-intro">{zhCN.projectMcp.intro}</p>
    {!settings.canEdit && <p className="project-mcp-intro" role="note"><span className="project-mcp-tag">{zhCN.projectMcp.readOnlyTag}</span>{zhCN.projectMcp.readOnly}</p>}
    {settings.projectConfig && <ProjectConfigNotice config={settings.projectConfig} />}
    {available.length === 0
      ? <p className="project-mcp-empty">{zhCN.projectMcp.empty}</p>
      : <ul className="project-mcp-list">
        {available.map(server => <ServerRow key={server.name} api={api} projectId={projectId} server={server} canEdit={settings.canEdit} onSaved={onSaved}
          connections={connections} onConnectionsChanged={onConnectionsChanged} />)}
      </ul>}
    {missing.length > 0 && <section className="project-mcp-removed" aria-label={zhCN.projectMcp.removed}>
      <h3 className="project-mcp-tag">{zhCN.projectMcp.removed}</h3>
      <ul className="project-mcp-list">
        {missing.map(server => <li key={server.name} className="project-mcp-row" data-testid="project-mcp-server" data-server={server.name}>
          <div className="project-mcp-head"><span className="project-mcp-name">{server.name}</span></div>
          <p className="project-mcp-desc">{zhCN.projectMcp.missing}</p>
        </li>)}
      </ul>
    </section>}
  </div>;
}

/** 项目里的 .pi/mcp.json：信任的项目才加载；没加载、读坏了或有项没用上时说明原因。 */
function ProjectConfigNotice({ config }: { config: NonNullable<ProjectMcpSettings["projectConfig"]> }) {
  const text = zhCN.projectMcp.projectFile;
  return <section className="project-mcp-project-file" data-testid="project-mcp-project-file" aria-label={text.label}>
    <p className="project-mcp-intro" role="note">
      {config.trusted ? text.loaded(config.path) : text.untrusted(config.path)}
    </p>
    {config.error && <p className="project-mcp-error" role="alert">{text.error(config.error)}</p>}
    {config.unavailable.length > 0 && <ul className="project-mcp-project-file-unused" aria-label={text.unavailable}>
      {config.unavailable.map(item => <li key={item.name} className="project-mcp-desc"><span className="project-mcp-tools">{item.name}</span>：{item.reason}</li>)}
    </ul>}
  </section>;
}

/** 个人账号 server 的连接状态与“连接 / 断开”。连接会整页跳到对方授权页。 */
function ConnectionLine({ api, projectId, server, connections, onChanged }: {
  api: McpApi; projectId: string; server: ProjectMcpServer & { oauthLabel: string }; connections: Connections; onChanged: () => Promise<void>;
}) {
  const [state, setState] = useState<{ kind: "idle" | "connecting" | "disconnecting" } | { kind: "error"; message: string }>({ kind: "idle" });
  const connection = connections?.find(row => row.name === server.name);
  const label = server.oauthLabel;
  async function connect() {
    setState({ kind: "connecting" });
    try {
      const { authorizationUrl } = await api.startMcpOAuth(server.name, projectId);
      rememberMcpOAuthReturnPath();
      window.location.assign(authorizationUrl);
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  }
  async function disconnect() {
    setState({ kind: "disconnecting" });
    try {
      await api.disconnectMcp(server.name, projectId);
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
  return <div className="project-mcp-line" data-testid="project-mcp-connection">
    <span className="project-mcp-key">{zhCN.projectMcp.account}</span>
    <span className={`project-mcp-value${connection?.connected ? "" : " project-mcp-muted"}`}>{status}</span>
    {connections !== null && (connection?.connected
      ? <button type="button" className="project-mcp-action" disabled={state.kind === "disconnecting"} onClick={() => void disconnect()}>
        {state.kind === "disconnecting" ? zhCN.projectMcp.connection.disconnecting : zhCN.projectMcp.connection.disconnect}</button>
      : <button type="button" className="project-mcp-action project-mcp-primary" disabled={state.kind === "connecting"} onClick={() => void connect()}>
        {state.kind === "connecting" ? zhCN.projectMcp.connection.connecting : zhCN.projectMcp.connection.connect(label)}</button>)}
    {state.kind === "error" && <span className="project-mcp-error" role="alert">{zhCN.projectMcp.connection.failed(state.message)}</span>}
  </div>;
}

type Setting = { enabled: boolean; exposure: McpExposure | ""; hiddenTools: readonly string[] };
const settingOf = (server: ProjectMcpServer): Setting => ({
  enabled: server.enabled,
  exposure: server.updatedAt !== null && server.exposure && server.exposure !== server.defaultExposure ? server.exposure : "",
  hiddenTools: server.hiddenTools,
});
const parseTools = (text: string) => [...new Set(text.split(/[\s,，]+/).filter(Boolean))];

/** 每项改动立即保存；失败时回到服务端的值并说明原因。 */
function ServerRow({ api, projectId, server, canEdit, onSaved, connections, onConnectionsChanged }: {
  api: McpApi; projectId: string; server: ProjectMcpServer; canEdit: boolean; onSaved: (server: ProjectMcpServer) => void;
  connections: Connections; onConnectionsChanged: () => Promise<void>;
}) {
  const id = useId();
  const saved = settingOf(server);
  const [pending, setPending] = useState<Setting | null>(null);
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string }>({ kind: "idle" });
  const [editingTools, setEditingTools] = useState<string | null>(null);
  const current = pending ?? saved;
  const busy = state.kind === "saving";
  const options = EXPOSURES.filter(exposure => !server.maxExposure || rank(exposure) <= rank(server.maxExposure));

  async function save(patch: Partial<Setting>) {
    const next = { ...current, ...patch };
    setPending(next);
    setState({ kind: "saving" });
    try {
      const { server: result } = await api.saveProjectMcpServer(projectId, server.name, {
        enabled: next.enabled, exposure: next.exposure === "" ? null : next.exposure, hiddenTools: [...next.hiddenTools],
      });
      onSaved(result);
      setState({ kind: "saved" });
      return true;
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      setPending(null);
    }
  }
  async function saveTools() {
    if (editingTools === null) return;
    const tools = parseTools(editingTools);
    if (tools.join(",") === current.hiddenTools.join(",") || await save({ hiddenTools: tools })) setEditingTools(null);
  }

  // 项目文件定义的 server 不能引用服务端凭证，不算“共享身份”。
  const identity = server.oauthLabel ? zhCN.projectMcp.personal : server.projectFile === "defined" ? null : zhCN.projectMcp.shared;
  return <li className={`project-mcp-row${current.enabled ? " is-enabled" : ""}`} data-testid="project-mcp-server" data-server={server.name}>
    <div className="project-mcp-head">
      <input id={`${id}-on`} type="checkbox" className="project-mcp-check" checked={current.enabled} aria-describedby={`${id}-desc`}
        disabled={!canEdit || busy || (!current.enabled && !server.canEnable)} onChange={event => void save({ enabled: event.target.checked })} />
      <label htmlFor={`${id}-on`} className="project-mcp-name">{server.name}</label>
      <span className="project-mcp-meta">
        {server.transport}
        {identity && <span title={server.oauthLabel ? zhCN.projectMcp.personalIdentity : zhCN.projectMcp.sharedIdentity}> · {identity}</span>}
        {server.adminOnly && <> · {zhCN.projectMcp.adminOnly}</>}
        {server.projectFile && <span title={zhCN.projectMcp.projectFile.titles[server.projectFile]}> · {zhCN.projectMcp.projectFile.tags[server.projectFile]}</span>}
      </span>
    </div>
    <p id={`${id}-desc`} className="project-mcp-desc">{server.description}</p>
    {server.changed && !current.enabled && <p className="project-mcp-desc project-mcp-changed" role="note">{zhCN.projectMcp.changed}</p>}
    {current.enabled && <div className="project-mcp-line">
      <label className="project-mcp-key" htmlFor={`${id}-exposure`} title={zhCN.projectMcp.exposureHint}>{zhCN.projectMcp.exposure}</label>
      {canEdit
        ? <SelectMenu id={`${id}-exposure`} ariaLabel={zhCN.projectMcp.exposure} value={current.exposure} disabled={busy} title={zhCN.projectMcp.exposureHint}
          options={[
            { value: "", label: zhCN.projectMcp.defaultExposure(exposureLabel(server.defaultExposure)) },
            ...options.map(exposure => ({ value: exposure, label: exposureLabel(exposure) })),
          ]}
          onChange={value => void save({ exposure: value as Setting["exposure"] })} />
        : <span className="project-mcp-value">{current.exposure ? exposureLabel(current.exposure) : zhCN.projectMcp.defaultExposure(exposureLabel(server.defaultExposure))}</span>}
    </div>}
    {current.enabled && <div className="project-mcp-line">
      <label className="project-mcp-key" htmlFor={`${id}-tools`} title={zhCN.projectMcp.hiddenToolsTitle}>{zhCN.projectMcp.hiddenTools}</label>
      {editingTools !== null
        ? <>
          <input id={`${id}-tools`} className="project-mcp-input" value={editingTools} autoFocus disabled={busy} placeholder={zhCN.projectMcp.hiddenToolsHint}
            onChange={event => setEditingTools(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter") { event.preventDefault(); void saveTools(); }
              // Esc 只取消编辑，不关闭整个面板。
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditingTools(null); }
            }} />
          <button type="button" className="project-mcp-action project-mcp-primary" disabled={busy} onClick={() => void saveTools()}>{zhCN.projectMcp.save}</button>
          <button type="button" className="project-mcp-action" disabled={busy} onClick={() => setEditingTools(null)}>{zhCN.projectMcp.cancel}</button>
        </>
        : <>
          <span className={`project-mcp-value project-mcp-tools${current.hiddenTools.length ? "" : " project-mcp-muted"}`}>
            {current.hiddenTools.length ? current.hiddenTools.join(", ") : zhCN.projectMcp.noHiddenTools}
          </span>
          {canEdit && <button type="button" className="project-mcp-action" disabled={busy} onClick={() => setEditingTools(current.hiddenTools.join(", "))}>{zhCN.projectMcp.edit}</button>}
        </>}
    </div>}
    {server.oauthLabel && <ConnectionLine api={api} projectId={projectId} server={{ ...server, oauthLabel: server.oauthLabel }} connections={connections} onChanged={onConnectionsChanged} />}
    <p className={`project-mcp-status${state.kind === "error" ? " project-mcp-error" : ""}`} role="status">
      {state.kind === "saving" ? zhCN.projectMcp.saving : state.kind === "saved" ? zhCN.projectMcp.saved : state.kind === "error" ? zhCN.projectMcp.saveFailed(state.message) : ""}
    </p>
  </li>;
}

/** ApiError 的 message 是 `HTTP 403: {json}`；优先取服务端给出的说明。 */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const body = text.replace(/^HTTP \d+: /, "");
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch { /* 不是 JSON，原样显示 */ }
  return text;
}
