import { zhCN } from "../i18n/zh-CN.js";
import { useCallback, useEffect, useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { ApiError, SHARED_MCP_MASK, type ApiClient, type McpExposure, type SharedMcpList, type SharedMcpServer, type SharedMcpServerConfig } from "pi-agent-server/client";
import { IconSelect } from "./IconSelect.js";
import { errorMessage } from "./ProjectMcpPanel.js";

type SharedApi = Pick<ApiClient, "getSharedMcp" | "saveSharedMcpServer" | "removeSharedMcpServer">;

const EXPOSURES: readonly McpExposure[] = ["direct", "codemode", "deferred", "hidden"];
const exposureLabel = (exposure: McpExposure) => zhCN.projectMcp.exposures[exposure] ?? exposure;
const text = zhCN.sharedMcp;

type Pair = { key: string; value: string };
interface Draft {
  name: string;
  transport: "http" | "stdio";
  url: string;
  headers: Pair[];
  command: string;
  args: string;
  env: Pair[];
  cwd: string;
  description: string;
  exposure: McpExposure;
  maxExposure: McpExposure | "";
  timeout: string;
  adminOnly: boolean;
  defaultEnabled: boolean;
  disabled: boolean;
  oauth: boolean;
  scope: string;
}

const pairsOf = (record: Readonly<Record<string, string>> | undefined): Pair[] => Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
const recordOf = (pairs: readonly Pair[]) => Object.fromEntries(pairs.filter(pair => pair.key.trim() !== "").map(pair => [pair.key.trim(), pair.value]));

function draftOf(name: string, config: SharedMcpServerConfig | undefined): Draft {
  return {
    name, transport: config?.transport ?? "http", url: config?.url ?? "", headers: pairsOf(config?.headers),
    command: config?.command ?? "", args: (config?.args ?? []).join("\n"), env: pairsOf(config?.env), cwd: config?.cwd ?? "",
    description: config?.description ?? "", exposure: config?.exposure ?? "codemode", maxExposure: config?.maxExposure ?? "",
    timeout: config?.timeout !== undefined ? String(config.timeout) : "",
    adminOnly: config?.adminOnly ?? false, defaultEnabled: config?.defaultEnabled ?? false, disabled: config?.enabled === false,
    oauth: config?.oauth != null, scope: config?.oauth?.scope ?? "",
  };
}

function configOf(draft: Draft): SharedMcpServerConfig {
  const timeout = Number(draft.timeout);
  return {
    transport: draft.transport,
    ...(draft.transport === "http"
      ? { url: draft.url, headers: recordOf(draft.headers), oauth: draft.oauth ? { scope: draft.scope } : null }
      : { command: draft.command, args: draft.args.split("\n").map(arg => arg.trim()).filter(Boolean), env: recordOf(draft.env), cwd: draft.cwd }),
    description: draft.description, exposure: draft.exposure,
    ...(draft.maxExposure ? { maxExposure: draft.maxExposure } : {}),
    ...(draft.timeout.trim() && timeout > 0 ? { timeout } : {}),
    adminOnly: draft.adminOnly, defaultEnabled: draft.defaultEnabled, enabled: !draft.disabled,
  };
}

/**
 * 共享 MCP 的管理（只给 admin）：就是 Pi 的全局 mcp.json。列表按文件顺序；编辑在行内展开表单。
 * 保存带上读取时的文件 hash，文件在别处改过时提示刷新，不覆盖别人的修改。
 */
export function SharedMcpPanel({ api, onChanged }: { api: SharedApi; onChanged: () => void }) {
  const [list, setList] = useState<SharedMcpList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** undefined：没在编辑；null：新增。 */
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const load = useCallback(() => api.getSharedMcp().then(
    result => { setList(result); setLoadError(null); },
    error => setLoadError(errorMessage(error))), [api]);
  useEffect(() => { void load(); }, [load]);
  const applied = (next: SharedMcpList) => {
    setList(next);
    setEditing(undefined);
    onChanged();
  };
  const reload = () => { setEditing(undefined); void load(); };

  if (!list) {
    return <div className="project-mcp shared-mcp" data-testid="shared-mcp-panel">
      {loadError && <p className="project-mcp-error" role="alert">{text.loadFailed(loadError)}</p>}
    </div>;
  }
  const hash = list.file?.hash ?? "";
  const names = list.servers.map(server => server.name);
  return <div className="project-mcp shared-mcp" data-testid="shared-mcp-panel">
    <p className="project-mcp-intro">{text.intro}</p>
    {list.file && <div className="project-mcp-line shared-mcp-file">
      <span className="project-mcp-key">{text.file}</span>
      <span className="project-mcp-value project-mcp-tools">{list.file.path}</span>
      {editing === undefined && <button type="button" className="project-mcp-action project-mcp-primary" data-testid="shared-mcp-add" onClick={() => setEditing(null)}>{text.add}</button>}
    </div>}
    {list.file?.error && <p className="project-mcp-error" role="alert">{text.fileError(list.file.error)}</p>}
    {editing === null && <ServerForm api={api} hash={hash} name={null} names={names} onSaved={applied} onCancel={() => setEditing(undefined)} onReload={reload} />}
    {list.servers.length === 0
      ? <p className="project-mcp-empty">{text.empty}</p>
      : <ul className="project-mcp-list">
        {list.servers.map(server => editing === server.name
          ? <li key={server.name} className="project-mcp-row" data-testid="shared-mcp-server" data-server={server.name}>
            <ServerForm api={api} hash={hash} name={server.name} server={server} names={names} onSaved={applied} onCancel={() => setEditing(undefined)} onReload={reload} />
          </li>
          : <ServerRow key={server.name} api={api} hash={hash} server={server} canEdit={list.canEdit && editing === undefined}
            onEdit={() => setEditing(server.name)} onRemoved={applied} onReload={reload} />)}
      </ul>}
  </div>;
}

function ServerRow({ api, hash, server, canEdit, onEdit, onRemoved, onReload }: {
  api: SharedApi; hash: string; server: SharedMcpServer; canEdit: boolean;
  onEdit: () => void; onRemoved: (list: SharedMcpList) => void; onReload: () => void;
}) {
  const [state, setState] = useState<{ kind: "idle" | "confirm" | "removing" } | { kind: "error"; message: string; conflict: boolean }>({ kind: "idle" });
  async function remove() {
    setState({ kind: "removing" });
    try {
      onRemoved(await api.removeSharedMcpServer(server.name, hash));
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error), conflict: error instanceof ApiError && error.status === 409 });
    }
  }
  const disabled = server.config?.enabled === false;
  const status = server.status === "available" ? text.available : disabled ? text.disabled : text.unavailable;
  return <li className="project-mcp-row" data-testid="shared-mcp-server" data-server={server.name}>
    <div className="project-mcp-head">
      <span className="project-mcp-name shared-mcp-name">{server.name}</span>
      <span className="project-mcp-meta">
        {server.transport ?? "?"}
        <span className={server.status === "available" ? "" : "shared-mcp-unavailable"}> · {status}</span>
        {server.exposure && <> · {exposureLabel(server.exposure)}</>}
        {server.oauth && <> · {text.personal}</>}
        {server.adminOnly && <> · {text.adminOnly}</>}
        {server.config?.defaultEnabled && <> · {text.defaultEnabled}</>}
      </span>
    </div>
    {server.description && <p className="project-mcp-desc">{server.description}</p>}
    {server.status === "unavailable" && server.reason && !disabled && <p className="project-mcp-desc shared-mcp-reason">{server.reason}</p>}
    <div className="project-mcp-line">
      {state.kind === "confirm" || state.kind === "removing"
        ? <>
          <button type="button" className="project-mcp-action shared-mcp-danger" disabled={state.kind === "removing"} onClick={() => void remove()}>
            {state.kind === "removing" ? text.removing : text.confirmRemove}</button>
          <button type="button" className="project-mcp-action" disabled={state.kind === "removing"} onClick={() => setState({ kind: "idle" })}>{text.cancel}</button>
        </>
        : <>
          {server.config && <button type="button" className="project-mcp-action" disabled={!canEdit} onClick={onEdit}>{text.edit}</button>}
          <button type="button" className="project-mcp-action" disabled={!canEdit} onClick={() => setState({ kind: "confirm" })}>{text.remove}</button>
        </>}
      {state.kind === "error" && <span className="project-mcp-error" role="alert">
        {text.saveFailed(state.message)}
        {state.conflict && <> <button type="button" className="project-mcp-action" onClick={onReload}>{text.reload}</button></>}
      </span>}
    </div>
  </li>;
}

function PairsEditor({ id, label, pairs, onChange }: { id: string; label: string; pairs: Pair[]; onChange: (pairs: Pair[]) => void }) {
  const set = (index: number, patch: Partial<Pair>) => onChange(pairs.map((pair, i) => i === index ? { ...pair, ...patch } : pair));
  return <div className="shared-mcp-field">
    <span className="project-mcp-key" id={id}>{label}</span>
    <div className="shared-mcp-pairs" role="group" aria-labelledby={id}>
      {pairs.map((pair, index) => <div key={index} className="shared-mcp-pair">
        <input className="project-mcp-input" aria-label={`${label} ${text.fields.key}`} value={pair.key} placeholder={text.fields.key}
          onChange={event => set(index, { key: event.target.value })} />
        <input className="project-mcp-input" aria-label={`${label} ${text.fields.value}`} value={pair.value} placeholder={text.fields.value}
          onFocus={event => { if (pair.value === SHARED_MCP_MASK) event.target.select(); }}
          onChange={event => set(index, { value: event.target.value })} />
        <button type="button" className="project-mcp-action" onClick={() => onChange(pairs.filter((_, i) => i !== index))}>{text.fields.removeRow}</button>
      </div>)}
      <button type="button" className="project-mcp-action shared-mcp-add-row" onClick={() => onChange([...pairs, { key: "", value: "" }])}>{text.fields.addRow}</button>
    </div>
  </div>;
}

function ServerForm({ api, hash, name, server, names, onSaved, onCancel, onReload }: {
  api: SharedApi; hash: string; name: string | null; server?: SharedMcpServer; names: readonly string[];
  onSaved: (list: SharedMcpList) => void; onCancel: () => void; onReload: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(name ?? "", server?.config));
  const [state, setState] = useState<{ kind: "idle" | "saving" } | { kind: "error"; message: string; conflict: boolean }>({ kind: "idle" });
  const set = (patch: Partial<Draft>) => setDraft(previous => ({ ...previous, ...patch }));
  const busy = state.kind === "saving";
  const isNew = name === null;
  const duplicate = isNew && names.includes(draft.name.trim());

  async function save() {
    setState({ kind: "saving" });
    try {
      onSaved(await api.saveSharedMcpServer(isNew ? draft.name.trim() : name, { hash, server: configOf(draft) }));
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error), conflict: error instanceof ApiError && error.status === 409 });
    }
  }
  const field = (key: string, label: string, input: ReactNode, hint?: string) => <div className="shared-mcp-field">
    <label className="project-mcp-key" htmlFor={`${id}-${key}`}>{label}</label>
    <div className="shared-mcp-control">{input}{hint && <span className="shared-mcp-hint">{hint}</span>}</div>
  </div>;
  const textInput = (key: keyof Draft & string, extra: Partial<InputHTMLAttributes<HTMLInputElement>> = {}) =>
    <input id={`${id}-${key}`} className="project-mcp-input" value={draft[key] as string} disabled={busy} onChange={event => set({ [key]: event.target.value } as Partial<Draft>)} {...extra} />;
  const check = (key: "oauth" | "adminOnly" | "defaultEnabled" | "disabled", label: string) => <label className="shared-mcp-check">
    <input type="checkbox" className="project-mcp-check" checked={draft[key]} disabled={busy} onChange={event => set({ [key]: event.target.checked })} />
    <span>{label}</span>
  </label>;

  return <form className="shared-mcp-form" data-testid="shared-mcp-form" aria-label={isNew ? text.newServer : name}
    onSubmit={event => { event.preventDefault(); void save(); }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    {isNew
      ? field("name", text.fields.name, textInput("name", { autoFocus: true, required: true, pattern: "[A-Za-z0-9_\\-]+", maxLength: 64, placeholder: text.fields.nameHint }),
        duplicate ? text.fields.duplicate : undefined)
      : <div className="project-mcp-head"><span className="project-mcp-name shared-mcp-name">{name}</span></div>}
    {field("transport", text.fields.transport, <IconSelect id={`${id}-transport`} value={draft.transport} disabled={busy}
      onChange={event => set({ transport: event.target.value as Draft["transport"] })}>
      <option value="http">{text.transports.http}</option>
      <option value="stdio">{text.transports.stdio}</option>
    </IconSelect>)}
    {draft.transport === "http"
      ? <>
        {field("url", text.fields.url, textInput("url", { required: true, type: "url", placeholder: "https://example.com/mcp" }))}
        <PairsEditor id={`${id}-headers`} label={text.fields.headers} pairs={draft.headers} onChange={headers => set({ headers })} />
        <div className="shared-mcp-field"><span className="project-mcp-key" /><div className="shared-mcp-control">
          {check("oauth", text.fields.oauth)}
          {draft.oauth && textInput("scope", { "aria-label": text.fields.scope, placeholder: text.fields.scope })}
        </div></div>
      </>
      : <>
        {field("command", text.fields.command, textInput("command", { required: true, placeholder: "npx" }), text.stdioWarning)}
        {field("args", text.fields.args, <textarea id={`${id}-args`} className="project-mcp-input shared-mcp-textarea" rows={3} value={draft.args} disabled={busy}
          placeholder={text.fields.argsHint} onChange={event => set({ args: event.target.value })} />)}
        <PairsEditor id={`${id}-env`} label={text.fields.env} pairs={draft.env} onChange={env => set({ env })} />
        {field("cwd", text.fields.cwd, textInput("cwd", { placeholder: "~" }))}
      </>}
    <p className="shared-mcp-hint shared-mcp-indent">{text.valueHint}</p>
    {field("description", text.fields.description, textInput("description", { placeholder: text.fields.descriptionHint }))}
    {field("exposure", text.fields.exposure, <IconSelect id={`${id}-exposure`} value={draft.exposure} disabled={busy} title={zhCN.projectMcp.exposureHint}
      onChange={event => set({ exposure: event.target.value as McpExposure })}>
      {EXPOSURES.map(exposure => <option key={exposure} value={exposure}>{exposureLabel(exposure)}</option>)}
    </IconSelect>)}
    {field("maxExposure", text.fields.maxExposure, <IconSelect id={`${id}-maxExposure`} value={draft.maxExposure} disabled={busy}
      onChange={event => set({ maxExposure: event.target.value as Draft["maxExposure"] })}>
      <option value="">{text.fields.maxExposureAuto}</option>
      {EXPOSURES.map(exposure => <option key={exposure} value={exposure}>{exposureLabel(exposure)}</option>)}
    </IconSelect>)}
    {field("timeout", text.fields.timeout, textInput("timeout", { type: "number", min: 1, step: "any", inputMode: "decimal", className: "project-mcp-input shared-mcp-number" }))}
    <div className="shared-mcp-field"><span className="project-mcp-key" /><div className="shared-mcp-control shared-mcp-checks">
      {check("adminOnly", text.fields.adminOnly)}
      {check("defaultEnabled", text.fields.defaultEnabled)}
      {check("disabled", text.fields.disabled)}
    </div></div>
    {server?.otherFields && server.otherFields.length > 0 && <p className="shared-mcp-hint shared-mcp-indent">{text.otherFields(server.otherFields.join("、"))}</p>}
    <div className="project-mcp-line shared-mcp-indent">
      <button type="submit" className="project-mcp-action project-mcp-primary" disabled={busy || duplicate}>{busy ? text.saving : text.save}</button>
      <button type="button" className="project-mcp-action" disabled={busy} onClick={onCancel}>{text.cancel}</button>
      {state.kind === "error" && <span className="project-mcp-error" role="alert">
        {text.saveFailed(state.message)}
        {state.conflict && <> <button type="button" className="project-mcp-action" onClick={onReload}>{text.reload}</button></>}
      </span>}
    </div>
  </form>;
}
