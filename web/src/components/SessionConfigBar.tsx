import { zhCN } from "../i18n/zh-CN.js";
import { SelectMenu } from "./SelectMenu.js";
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
  const currentModel = session.modelProvider && session.modelId ? `${session.modelProvider}/${session.modelId}` : "";

  return (
    <div className="session-config" data-testid="session-config">
      <div className="field">
        <label htmlFor="model-select">{zhCN.model.model}</label>
        <SelectMenu
          id="model-select"
          testId="model-select"
          ariaLabel={zhCN.common.selectModel}
          options={[
            { value: "", label: zhCN.common.serverDefault },
            ...models.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider} / ${m.name}` })),
          ]}
          value={currentModel}
          onChange={(value) => {
            const [provider, id] = value.split("/");
            if (provider && id) onChange({ modelProvider: provider, modelId: id });
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="thinking-level-select">{zhCN.common.thinkingLevel}</label>
        <SelectMenu
          id="thinking-level-select"
          testId="thinking-level-select"
          ariaLabel={zhCN.common.selectThinkingLevel}
          options={[{ value: "", label: zhCN.common.default }, ...thinkingLevels.map((l) => ({ value: l, label: l }))]}
          value={session.thinkingLevel ?? ""}
          onChange={(value) => onChange({ thinkingLevel: value || undefined })}
        />
      </div>
    </div>
  );
}
