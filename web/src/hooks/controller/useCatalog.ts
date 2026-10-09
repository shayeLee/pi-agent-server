import { useState } from "react";
import type { AccessCapabilities, ApiClient, ModelInfo } from "pi-agent-server/client";

export function useAccess(api: ApiClient) {
  const [access, setAccess] = useState<AccessCapabilities | null>(null);
  function loadAccess(): void {
    void api.getAccess().then(setAccess).catch(() => setAccess({ canRead: false, canWrite: false }));
  }
  return { access, loadAccess };
}

export function useModelCatalog(api: ApiClient) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<ModelInfo | null>(null);
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState("");

  async function refreshModels(): Promise<void> {
    if (!api) return;
    try {
      const data = await api.listModels();
      setModels(data.models);
      setThinkingLevels(data.thinkingLevels);
      setDefaultModel(data.defaultModel);
      setDefaultThinkingLevel(data.defaultThinkingLevel);
    } catch {
      // 模型列表加载失败不阻塞主流程。
    }
  }

  return { models, thinkingLevels, defaultModel, defaultThinkingLevel, refreshModels };
}
