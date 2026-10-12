import { useEffect, useId, useRef, useState } from "react";

import { Icon } from "./Icon.js";
import type { ModelInfo } from "pi-agent-server/client";

export type ModelThinkingPickerProps = {
  models: ModelInfo[];
  thinkingLevels: string[];
  defaultModel: ModelInfo | null;
  defaultThinkingLevel: string;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  onConfigChange: (config: { modelProvider?: string; modelId?: string; thinkingLevel?: string }) => void;
};

function modelKey(model: Pick<ModelInfo, "provider" | "id">): string {
  return JSON.stringify([model.provider, model.id]);
}

function handleRadioKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
  const direction = event.key === "ArrowDown" || event.key === "ArrowRight"
    ? 1
    : event.key === "ArrowUp" || event.key === "ArrowLeft"
      ? -1
      : 0;
  if (!direction) return;
  event.preventDefault();
  const options = Array.from(
    event.currentTarget.closest('[role="radiogroup"]')?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [],
  );
  const currentIndex = options.indexOf(event.currentTarget);
  const nextIndex = (currentIndex + direction + options.length) % options.length;
  options[nextIndex]?.focus();
  options[nextIndex]?.click();
}

export function ModelThinkingPicker({
  models,
  thinkingLevels,
  defaultModel,
  defaultThinkingLevel,
  modelProvider,
  modelId,
  thinkingLevel,
  onConfigChange,
}: ModelThinkingPickerProps) {
  const [activeEntry, setActiveEntry] = useState<"model" | "thinking" | null>(null);
  const open = activeEntry !== null;
  const [query, setQuery] = useState("");
  const [panelLayout, setPanelLayout] = useState({ placement: "above" as "above" | "below", maxHeight: 380 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const thinkingTriggerRef = useRef<HTMLButtonElement>(null);
  const activeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const panelId = `${id}-panel`;
  const configuredModel = modelProvider && modelId ? modelKey({ provider: modelProvider, id: modelId }) : undefined;
  const selectedModel = configuredModel ?? (defaultModel ? modelKey(defaultModel) : "");
  const selectedThinking = thinkingLevel ?? defaultThinkingLevel;

  const availableModels: ModelInfo[] = [];
  const seenModels = new Set<string>();
  if (defaultModel) {
    availableModels.push(defaultModel);
    seenModels.add(modelKey(defaultModel));
  }
  for (const model of models) {
    const key = modelKey(model);
    if (!seenModels.has(key)) {
      availableModels.push(model);
      seenModels.add(key);
    }
  }
  if (configuredModel && !seenModels.has(configuredModel)) {
    availableModels.push({
      provider: modelProvider!,
      id: modelId!,
      name: `${modelProvider} / ${modelId}`,
    });
  }

  const selectedModelInfo = availableModels.find((model) => modelKey(model) === selectedModel);
  const modelLabel = selectedModelInfo?.id ?? "默认模型";
  const filteredModels = availableModels.filter((model) =>
    `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const availableThinkingLevels = [
    ...(defaultThinkingLevel ? [defaultThinkingLevel] : []),
    ...thinkingLevels.filter((level) => level !== defaultThinkingLevel),
  ];

  function updatePanelLayout() {
    const trigger = activeTriggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const spaceAbove = Math.max(0, trigger.top - 16);
    const spaceBelow = Math.max(0, window.innerHeight - trigger.bottom - 16);
    const placement = spaceAbove >= spaceBelow ? "above" : "below";
    const maxHeight = Math.min(380, placement === "above" ? spaceAbove : spaceBelow);
    setPanelLayout((current) => current.placement === placement && current.maxHeight === maxHeight
      ? current
      : { placement, maxHeight });
  }

  function toggleEntry(entry: "model" | "thinking") {
    activeTriggerRef.current = entry === "model" ? triggerRef.current : thinkingTriggerRef.current;
    if (activeEntry === entry) {
      setActiveEntry(null);
    } else {
      setQuery("");
      updatePanelLayout();
      setActiveEntry(entry);
    }
  }

  useEffect(() => {
    if (!activeEntry) return;
    if (activeEntry === "model") {
      rootRef.current?.querySelector<HTMLInputElement>(".model-thinking-search")?.focus();
    } else {
      const section = rootRef.current?.querySelector(".model-thinking-level-section");
      const selected = section?.querySelector<HTMLElement>('[aria-checked="true"]');
      (selected ?? section?.querySelector<HTMLElement>('button'))?.focus();
    }
  }, [activeEntry]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setActiveEntry(null);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setActiveEntry(null);
        (activeTriggerRef.current ?? triggerRef.current)?.focus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePanelLayout);
    window.addEventListener("scroll", updatePanelLayout, true);
    updatePanelLayout();
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePanelLayout);
      window.removeEventListener("scroll", updatePanelLayout, true);
    };
  }, [open]);

  return (
    <div className="model-thinking-picker" data-open={open} data-panel-placement={panelLayout.placement} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="model-thinking-trigger chevron-trigger"
        data-testid="model-thinking-trigger"
        aria-label={`模型：${modelLabel}，思考深度：${selectedThinking || "未设置"}`}
        aria-haspopup="dialog"
        aria-expanded={activeEntry === "model"}
        aria-controls={panelId}
        onClick={() => toggleEntry("model")}
      >
        <span className="model-thinking-model">{modelLabel}</span>
        <Icon name="down" className="disclosure-chevron" />
      </button>
      <button ref={thinkingTriggerRef} type="button" className="model-thinking-trigger thinking-trigger chevron-trigger"
        data-testid="thinking-trigger" aria-label={`思考深度：${selectedThinking || "未设置"}`}
        aria-haspopup="dialog" aria-expanded={activeEntry === "thinking"} aria-controls={panelId}
        onClick={() => toggleEntry("thinking")}>
        <span>{selectedThinking || "未设置"}</span><Icon name="down" className="disclosure-chevron" />
      </button>
      {open && (
        <div id={panelId} className="model-thinking-panel" style={{ maxHeight: panelLayout.maxHeight }} role="dialog" aria-label="模型与思考深度">
          <section className="model-thinking-section model-thinking-model-section" aria-labelledby={`${id}-models-label`}>
            <h2 id={`${id}-models-label`}>模型</h2>
            <input
              className="model-thinking-search"
              type="search"
              aria-label="搜索模型"
              placeholder="搜索 provider / model"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {filteredModels.length ? (
              <div className="model-thinking-options model-thinking-model-options" role="radiogroup" aria-labelledby={`${id}-models-label`}>
                {filteredModels.map((model) => {
                  const key = modelKey(model);
                  return (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={selectedModel === key}
                      aria-label={`${model.provider}/${model.id} (${model.name})`}
                      className="model-thinking-option"
                      data-testid="model-thinking-model-option"
                      tabIndex={selectedModel === key || (!filteredModels.some((item) => modelKey(item) === selectedModel) && filteredModels[0] === model) ? 0 : -1}
                      onKeyDown={handleRadioKeyDown}
                      onClick={() => onConfigChange({ modelProvider: model.provider, modelId: model.id })}
                    >
                      <span title={`${model.provider}/${model.id}`}>{model.provider}/{model.id}</span>
                      <small title={model.name}>{model.name}</small>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="model-thinking-empty">{query ? "没有匹配的模型" : "暂无可用模型"}</p>
            )}
          </section>
          <section className="model-thinking-section model-thinking-level-section" aria-labelledby={`${id}-thinking-label`}>
            <h2 id={`${id}-thinking-label`}>思考深度</h2>
            <div className="model-thinking-options model-thinking-level-options" role="radiogroup" aria-labelledby={`${id}-thinking-label`}>
              {availableThinkingLevels.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={selectedThinking === level}
                  className="model-thinking-option"
                  data-testid="model-thinking-level-option"
                  tabIndex={selectedThinking === level ? 0 : -1}
                  onKeyDown={handleRadioKeyDown}
                  onClick={() => onConfigChange({ thinkingLevel: level })}
                >
                  {level}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
