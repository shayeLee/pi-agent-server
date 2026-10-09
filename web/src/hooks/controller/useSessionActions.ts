import type { ApiClient } from "pi-agent-server/client";
import type { ChatStores } from "./useChatStores.js";
import type { Selection } from "./useSelection.js";
import type { SessionList } from "./useSessionList.js";
import type { Usage } from "./useUsage.js";

/** Per-session commands whose failures surface as chat errors: config, export, abort. */
export function useSessionActions({ api, selection, chats, sessionList, usage }: {
  api: ApiClient;
  selection: Selection;
  chats: ChatStores;
  sessionList: SessionList;
  usage: Usage;
}) {
  const { activeSessionId } = selection;
  const { getChatStore, reportChatError } = chats;
  const { setSessions } = sessionList;

  async function changeSessionConfig(
    id: string,
    config: { modelProvider?: string; modelId?: string; thinkingLevel?: string },
  ): Promise<void> {
    if (!api) return;
    if (config.modelProvider !== undefined || config.modelId !== undefined) usage.invalidateContext(id);
    try {
      const updated = await api.updateSessionConfig(id, config);
      setSessions((prev) => (prev ?? []).map((session) => (session.id === id ? updated : session)));
    } catch (err) {
      reportChatError(id, err);
    }
  }

  async function exportSession(id: string): Promise<void> {
    if (!api) return;
    try {
      const data = await api.exportSession(id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `session-${id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      reportChatError(id, err);
    }
  }

  function abort(): void {
    if (!api || !activeSessionId) return;
    const sessionId = activeSessionId;
    getChatStore(sessionId).clearModelOutput();
    api.abort(sessionId).catch((err) => reportChatError(sessionId, err));
  }

  return { changeSessionConfig, exportSession, abort };
}
