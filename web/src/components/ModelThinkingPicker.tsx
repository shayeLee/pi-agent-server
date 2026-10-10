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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [panelLayout, setPanelLayout] = useState({ placement: "above" as "above" | "below", maxHeight: 380 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
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
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const spaceAbove = Math.max(0, trigger.top - 16);
    const spaceBelow = Math.max(0, window.innerHeight - trigger.bottom - 16);
    const placement = spaceAbove >= spaceBelow ? "above" : "below";
    const maxHeight = Math.min(380, placement === "above" ? spaceAbove : spaceBelow);
    setPanelLayout((current) => current.placement === placement && current.maxHeight === maxHeight
      ? current
      : { placement, maxHeight });
  }

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
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
    <div className="model-thinking-picker group relative min-w-0 max-w-full" data-open={open} data-panel-placement={panelLayout.placement} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="model-thinking-trigger chevron-trigger inline-flex min-h-8 max-w-full items-center gap-2 rounded-md border border-transparent bg-muted px-2.5 py-1 text-left text-[13px] text-muted-foreground hover:border-primary hover:text-primary group-data-[open=true]:border-primary group-data-[open=true]:text-primary max-[639px]:min-h-[44px]"
        data-testid="model-thinking-trigger"
        aria-label={`模型：${modelLabel}，思考深度：${selectedThinking || "未设置"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (!open) {
            setQuery("");
            updatePanelLayout();
          }
          setOpen((current) => !current);
        }}
      >
        <span className="model-thinking-model min-w-0 flex-1 font-mono break-all text-left">{modelLabel}</span>
        <span className="model-thinking-level shrink-0 border-l border-border pl-2 font-mono text-[12px] text-muted-foreground">{selectedThinking}</span>
        <Icon name="down" className="disclosure-chevron" />
      </button>
      {open && (
        <div id={panelId} className={`model-thinking-panel absolute z-[60] right-0 flex w-[min(420px,calc(100vw-32px))] flex-col gap-3 overflow-hidden rounded-md border border-border bg-popover p-3 shadow-md ${panelLayout.placement === "below" ? "top-[calc(100%+8px)]" : "bottom-[calc(100%+8px)]"}`} style={{ maxHeight: panelLayout.maxHeight }} role="dialog" aria-label="模型与思考深度">
          <section className="model-thinking-section model-thinking-model-section flex min-h-0 flex-1 flex-col" aria-labelledby={`${id}-models-label`}>
            <h2 id={`${id}-models-label`} className="mb-1.5 text-[12px] font-semibold text-muted-foreground">模型</h2>
            <input
              className="model-thinking-search mb-2 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[13px] outline-none focus:border-primary"
              type="search"
              aria-label="搜索模型"
              placeholder="搜索 provider / model"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {filteredModels.length ? (
              <div className="model-thinking-options model-thinking-model-options flex max-h-60 min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto" role="radiogroup" aria-labelledby={`${id}-models-label`}>
                {filteredModels.map((model) => {
                  const key = modelKey(model);
                  return (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={selectedModel === key}
                      aria-label={`${model.provider}/${model.id} (${model.name})`}
                      className="model-thinking-option block min-h-8 w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent aria-checked:bg-primary/10 aria-checked:text-primary"
                      data-testid="model-thinking-model-option"
                      tabIndex={selectedModel === key || (!filteredModels.some((item) => modelKey(item) === selectedModel) && filteredModels[0] === model) ? 0 : -1}
                      onKeyDown={handleRadioKeyDown}
                      onClick={() => onConfigChange({ modelProvider: model.provider, modelId: model.id })}
                    >
                      <span className="block break-all font-mono" title={`${model.provider}/${model.id}`}>{model.provider}/{model.id}</span>
                      <small className="block text-[12px] text-muted-foreground" title={model.name}>{model.name}</small>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="model-thinking-empty my-2 text-[13px] text-muted-foreground">{query ? "没有匹配的模型" : "暂无可用模型"}</p>
            )}
          </section>
          <section className="model-thinking-section model-thinking-level-section shrink-0" aria-labelledby={`${id}-thinking-label`}>
            <h2 id={`${id}-thinking-label`} className="mb-1.5 text-[12px] font-semibold text-muted-foreground">思考深度</h2>
            <div className="model-thinking-options model-thinking-level-options flex flex-wrap gap-1" role="radiogroup" aria-labelledby={`${id}-thinking-label`}>
              {availableThinkingLevels.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={selectedThinking === level}
                  className="model-thinking-option inline-flex min-h-8 items-center justify-center rounded-md px-2 py-1.5 text-center text-[13px] hover:bg-accent aria-checked:bg-primary/10 aria-checked:text-primary"
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
