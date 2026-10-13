import { zhCN } from "../i18n/zh-CN.js";
import { IconSelect } from "./IconSelect.js";
import type { ModelInfo, SessionRecord } from "pi-agent-server/client";

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
        <label htmlFor="model-select">{zhCN.model.model}</label>
        <IconSelect
          id="model-select"
          data-testid="model-select"
          aria-label={zhCN.common.selectModel}
          value={currentModel}
          onChange={(e) => {
            const [provider, id] = e.target.value.split("/");
            if (provider && id) onChange({ modelProvider: provider, modelId: id });
          }}
        >
          <option value="">{zhCN.common.serverDefault}</option>
          {models.map((m) => (
            <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
              {m.provider} / {m.name}
            </option>
          ))}
        </IconSelect>
      </div>
      <div className="field">
        <label htmlFor="thinking-level-select">{zhCN.common.thinkingLevel}</label>
        <IconSelect
          id="thinking-level-select"
          data-testid="thinking-level-select"
          aria-label={zhCN.common.selectThinkingLevel}
          value={session.thinkingLevel ?? ""}
          onChange={(e) => onChange({ thinkingLevel: e.target.value || undefined })}
        >
          <option value="">{zhCN.common.default}</option>
          {thinkingLevels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </IconSelect>
      </div>
    </div>
  );
}
