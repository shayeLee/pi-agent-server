import { zhCN } from "../i18n/zh-CN.js";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import {
  AGENT_THINKING_LEVELS, ApiError, MAX_AGENT_RETRIES,
  type AgentSettings, type AgentSettingsProject, type AgentSettingsValues, type AgentThinkingLevel, type ApiClient, type ModelInfo,
} from "pi-agent-server/client";
import { Modal } from "./Modal.js";
import { errorMessage } from "./ProjectMcpPanel.js";
import { SelectMenu } from "./SelectMenu.js";

type SettingsApi = Pick<ApiClient, "getAgentSettings" | "saveAgentSettings">;

const text = zhCN.agentSettings;

/**
 * Agent 设置（Pi TUI 的 /settings 里服务会用的几项），入口在侧栏底部的“设置”菜单里。
 * 设置保存在 Pi 的全局 settings.json，人人能看，只有 admin 能改；读不到时 `available` 为 false，菜单不显示这一项。
 * 当前项目受信任、又有 .pi/settings.json 时，面板另外列出它覆盖了哪几项。
 */
export function useAgentSettings({ api, models, projectId = null, onSaved }: {
  api: SettingsApi; models: readonly ModelInfo[]; projectId?: string | null; onSaved?: () => void;
}): { available: boolean; openPanel: () => void; dialog: ReactNode } {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let current = true;
    api.getAgentSettings().then(() => { if (current) setAvailable(true); }, () => {});
    return () => { current = false; };
  }, [api]);
  const openPanel = useCallback(() => setOpen(true), []);
  if (!available) return { available, openPanel, dialog: null };
  return { available, openPanel, dialog: <Modal open={open} onClose={() => setOpen(false)} title={text.title} className="project-mcp-dialog">
    {open && <AgentSettingsPanel api={api} models={models} projectId={projectId} onSaved={onSaved} />}
  </Modal> };
}

type SaveState = { kind: "idle" | "saving" } | { kind: "error"; message: string; conflict: boolean };

export function AgentSettingsPanel({ api, models, projectId = null, onSaved }: {
  api: SettingsApi; models: readonly ModelInfo[]; projectId?: string | null; onSaved?: () => void;
}) {
  const id = useId();
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const load = useCallback(() => api.getAgentSettings(projectId ?? undefined).then(
    result => { setSettings(result); setLoadError(null); setState({ kind: "idle" }); },
    error => setLoadError(errorMessage(error))), [api, projectId]);
  useEffect(() => { void load(); }, [load]);

  if (!settings) {
    return <div className="project-mcp agent-settings" data-testid="agent-settings-panel">
      {loadError && <p className="project-mcp-error" role="alert">{text.loadFailed(loadError)}</p>}
    </div>;
  }
  const { values, defaults, canEdit } = settings;
  const busy = state.kind === "saving";
  const disabled = !canEdit || busy;

  async function save(change: Partial<AgentSettingsValues>) {
    setState({ kind: "saving" });
    try {
      const saved = await api.saveAgentSettings({ hash: settings!.file?.hash ?? "", values: change });
      // 保存只改全局文件，项目的覆盖不变。
      setSettings(settings!.project ? { ...saved, project: settings!.project } : saved);
      setState({ kind: "idle" });
      onSaved?.();
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error), conflict: error instanceof ApiError && error.status === 409 });
    }
  }

  return <div className="project-mcp agent-settings" data-testid="agent-settings-panel">
    <p className="project-mcp-intro">{canEdit ? text.intro : text.readOnly}</p>
    {settings.file?.error && <p className="project-mcp-error" role="alert">{text.fileError(settings.file.error)}</p>}
    {settings.project && <ProjectOverrides project={settings.project} />}
    <ul className="project-mcp-list">
      <li className={`project-mcp-row${values.autoCompaction ? " is-enabled" : ""}`} data-testid="agent-settings-compaction">
        <div className="project-mcp-head">
          <input id={`${id}-compaction`} type="checkbox" className="project-mcp-check" checked={values.autoCompaction} disabled={disabled}
            onChange={event => void save({ autoCompaction: event.target.checked })} />
          <label className="project-mcp-name agent-settings-name" htmlFor={`${id}-compaction`}>{text.autoCompaction}</label>
          {values.autoCompaction === defaults.autoCompaction && <span className="project-mcp-meta">{text.isDefault}</span>}
        </div>
        <p className="project-mcp-desc">{text.autoCompactionHint}</p>
      </li>
      <li className={`project-mcp-row${values.autoRetry ? " is-enabled" : ""}`} data-testid="agent-settings-retry">
        <div className="project-mcp-head">
          <input id={`${id}-retry`} type="checkbox" className="project-mcp-check" checked={values.autoRetry} disabled={disabled}
            onChange={event => void save({ autoRetry: event.target.checked })} />
          <label className="project-mcp-name agent-settings-name" htmlFor={`${id}-retry`}>{text.autoRetry}</label>
          {values.autoRetry === defaults.autoRetry && values.maxRetries === defaults.maxRetries && <span className="project-mcp-meta">{text.isDefault}</span>}
        </div>
        <p className="project-mcp-desc">{text.autoRetryHint}</p>
        <div className="project-mcp-line">
          <label className="project-mcp-key" htmlFor={`${id}-max-retries`}>{text.maxRetries}</label>
          <RetryCount key={values.maxRetries} id={`${id}-max-retries`} value={values.maxRetries} disabled={disabled || !values.autoRetry}
            onCommit={maxRetries => void save({ maxRetries })} />
        </div>
      </li>
      <li className="project-mcp-row" data-testid="agent-settings-thinking">
        <div className="project-mcp-head"><span className="project-mcp-name agent-settings-name">{text.modelThinking}</span></div>
        <p className="project-mcp-desc">{text.modelThinkingHint}</p>
        <ModelThinkingLevels id={id} levels={values.modelThinkingLevels} models={models} disabled={disabled}
          onChange={modelThinkingLevels => void save({ modelThinkingLevels })} />
      </li>
    </ul>
    {canEdit && settings.file && <p className="project-mcp-status">{text.file(settings.file.path)}</p>}
    <p className="project-mcp-status" role="status">{busy ? text.saving : ""}</p>
    {state.kind === "error" && <p className="project-mcp-error" role="alert">
      {text.saveFailed(state.message)}
      {state.conflict && <> <button type="button" className="project-mcp-action" onClick={() => void load()}>{text.reload}</button></>}
    </p>}
  </div>;
}

/** 当前项目的 .pi/settings.json：受信任时列出它覆盖的项，否则说明没有加载。 */
function ProjectOverrides({ project }: { project: AgentSettingsProject }) {
  const t = text.project;
  const { values } = project;
  const onOff = (value: boolean) => value ? t.on : t.off;
  const rows: [string, string][] = [
    ...(values.autoCompaction !== undefined ? [[text.autoCompaction, onOff(values.autoCompaction)] as [string, string]] : []),
    ...(values.autoRetry !== undefined ? [[text.autoRetry, onOff(values.autoRetry)] as [string, string]] : []),
    ...(values.maxRetries !== undefined ? [[text.maxRetries, t.retries(values.maxRetries)] as [string, string]] : []),
    ...Object.entries(values.modelThinkingLevels ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([model, level]) => [t.thinking(model), level] as [string, string]),
  ];
  return <section className="project-mcp-project-file" data-testid="agent-settings-project" aria-label={t.label}>
    <p className="project-mcp-intro" role="note">
      {!project.trusted ? t.untrusted(project.path) : rows.length > 0 ? t.overrides(project.path) : t.none(project.path)}
    </p>
    {project.trusted && rows.length > 0 && <ul className="project-mcp-project-file-unused">
      {rows.map(([label, value]) => <li key={label} className="project-mcp-desc">{label}：<span className="project-mcp-tools">{value}</span></li>)}
    </ul>}
    {project.error && <p className="project-mcp-error" role="alert">{t.error(project.error)}</p>}
  </section>;
}

/** 失焦或回车时保存；超出范围的值不保存，恢复成原来的。 */
function RetryCount({ id, value, disabled, onCommit }: { id: string; value: number; disabled: boolean; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  function commit() {
    const next = Number(draft);
    if (draft.trim() === "" || !Number.isInteger(next) || next < 0 || next > MAX_AGENT_RETRIES) return setDraft(String(value));
    if (next !== value) onCommit(next);
  }
  return <input id={id} type="number" min={0} max={MAX_AGENT_RETRIES} step={1} inputMode="numeric"
    className="project-mcp-input agent-settings-number" data-testid="agent-settings-max-retries"
    value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} />;
}

function ModelThinkingLevels({ id, levels, models, disabled, onChange }: {
  id: string; levels: Readonly<Record<string, AgentThinkingLevel>>; models: readonly ModelInfo[]; disabled: boolean;
  onChange: (levels: Record<string, AgentThinkingLevel>) => void;
}) {
  const [newModel, setNewModel] = useState("");
  const [newLevel, setNewLevel] = useState<AgentThinkingLevel>("medium");
  const entries = Object.entries(levels).sort(([a], [b]) => a.localeCompare(b));
  const known = new Set(models.map(model => `${model.provider}/${model.id}`));
  const addable = models.map(model => `${model.provider}/${model.id}`).filter(ref => !(ref in levels));
  const levelOptions = AGENT_THINKING_LEVELS.map(level => ({ value: level, label: level }));
  return <div className="agent-settings-models">
    {entries.length === 0
      ? <p className="project-mcp-status">{text.noModelThinking}</p>
      : entries.map(([ref, level]) => <div key={ref} className="project-mcp-line agent-settings-model" data-testid="agent-settings-model-row" data-model={ref}>
        <span className="project-mcp-value project-mcp-tools agent-settings-model-ref">{ref}</span>
        {!known.has(ref) && <span className="project-mcp-meta">{text.modelUnavailable}</span>}
        <SelectMenu ariaLabel={text.levelFor(ref)} options={levelOptions} value={level} disabled={disabled}
          onChange={value => onChange({ ...levels, [ref]: value as AgentThinkingLevel })} />
        <button type="button" className="project-mcp-action" disabled={disabled}
          onClick={() => { const { [ref]: _removed, ...rest } = levels; onChange(rest); }}>{text.remove}</button>
      </div>)}
    {!disabled && addable.length > 0 && <div className="project-mcp-line agent-settings-add">
      <SelectMenu id={`${id}-new-model`} ariaLabel={text.newModel} testId="agent-settings-new-model"
        options={addable.map(ref => ({ value: ref, label: ref }))} value={newModel} placeholder={text.chooseModel}
        onChange={setNewModel} />
      <SelectMenu ariaLabel={text.newLevel} options={levelOptions} value={newLevel}
        onChange={value => setNewLevel(value as AgentThinkingLevel)} />
      <button type="button" className="project-mcp-action project-mcp-primary" disabled={!newModel} data-testid="agent-settings-add-model"
        onClick={() => { onChange({ ...levels, [newModel]: newLevel }); setNewModel(""); }}>{text.add}</button>
    </div>}
  </div>;
}
