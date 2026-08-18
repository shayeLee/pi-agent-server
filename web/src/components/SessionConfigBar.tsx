import type { ModelInfo, SessionRecord } from "../types.js";

export type SessionConfigBarProps = {
  session: SessionRecord;
  models: ModelInfo[];
  thinkingLevels: string[];
  onChange: (config: {
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: string;
  }) => void;
};

/** 会话配置栏：模型选择 + 思考级别选择（切换即生效并持久化）。 */
export function SessionConfigBar({ session, models, thinkingLevels, onChange }: SessionConfigBarProps) {
  const currentModel = `${session.modelProvider ?? ""}/${session.modelId ?? ""}`;

  return (
    <div className="session-config" data-testid="session-config">
      <div className="field">
        <label htmlFor="model-select">模型</label>
        <select
          id="model-select"
          data-testid="model-select"
          aria-label="选择模型"
          value={currentModel}
          onChange={(e) => {
            const [provider, id] = e.target.value.split("/");
            if (provider && id) onChange({ modelProvider: provider, modelId: id });
          }}
        >
          <option value="">服务端默认</option>
          {models.map((m) => (
            <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
              {m.provider} / {m.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="thinking-level-select">思考级别</label>
        <select
          id="thinking-level-select"
          data-testid="thinking-level-select"
          aria-label="选择思考级别"
          value={session.thinkingLevel ?? ""}
          onChange={(e) => onChange({ thinkingLevel: e.target.value || undefined })}
        >
          <option value="">默认</option>
          {thinkingLevels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
