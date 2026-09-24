import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readPiJsonlExport } from "../agent/pi-jsonl-conversation-storage.js";
import { classifyPiJsonlReference, requirePiDataDir } from "../agent/pi-jsonl-reference.js";

export type SessionSummary = { id: string; ip: string; title: string; createdAt: number; updatedAt: number };
export type ChatMessage = { role: "user" | "assistant"; text: string };
type SessionRow = {
  id: string; owner_key: string; project_id: string; title: string;
  created_at: number; updated_at: number; conversation_ref: string | null;
  system_prompt: string | null; agent_kind: string; conversation_format: string;
};

// These are UI control envelopes, not user-written chat text. Never strip anything except a
// complete, anchored envelope; malformed/unknown versions remain visible instead of being guessed.
export function presentationText(text: string): string {
  let result = text;
  for (let i = 0; i < 4; i++) {
    const match = result.match(/^\[(ONEV_CONTEXT_V1|ONEV_PROTOTYPE_STATE_V1)\][^\r\n]*?\[\/\1\]\s*/);
    if (!match) break;
    result = result.slice(match[0].length);
  }
  return result;
}

export function createViewerData(dbPath: string, dataDir: string) {
  const root = requirePiDataDir(dataDir);
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 3000 });
  return {
    close: () => db.close(),
    listIps(): Array<{ ip: string; count: number }> {
      const rows = db.prepare("SELECT owner_key, count(*) AS count FROM sessions WHERE owner_key LIKE 'ip:%' GROUP BY owner_key ORDER BY count DESC, owner_key").all() as Array<{ owner_key: string; count: number }>;
      return rows.map(({ owner_key, count }) => ({ ip: owner_key.slice(3), count }));
    },
    listSessions(ip: string, offset: number, limit = 50): { total: number; sessions: SessionSummary[] } {
      const owner = `ip:${ip}`;
      const total = (db.prepare("SELECT count(*) AS n FROM sessions WHERE owner_key = ?").get(owner) as { n: number }).n;
      const rows = db.prepare("SELECT id, owner_key, title, created_at, updated_at FROM sessions WHERE owner_key = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?").all(owner, limit, offset) as Array<Pick<SessionRow, "id" | "owner_key" | "title" | "created_at" | "updated_at">>;
      return { total, sessions: rows.map((row) => ({ id: row.id, ip, title: row.title, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) })) };
    },
    async getSession(id: string): Promise<{ session: SessionSummary; systemPrompt: string | null; messages: ChatMessage[] } | null> {
      const row = db.prepare("SELECT id, owner_key, project_id, title, created_at, updated_at, conversation_ref, system_prompt, agent_kind, conversation_format FROM sessions WHERE id = ? AND owner_key LIKE 'ip:%'").get(id) as SessionRow | undefined;
      if (!row) return null;
      const session = { id: row.id, ip: row.owner_key.slice(3), title: row.title, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
      const systemPrompt = row.system_prompt;
      if (row.conversation_ref === null) return { session, systemPrompt, messages: [] };
      const classification = classifyPiJsonlReference(root, {
        sessionId: row.id, projectId: row.project_id, agentKind: row.agent_kind,
        conversationFormat: row.conversation_format, conversationRef: row.conversation_ref,
      });
      if (classification.kind !== "valid" || !classification.idsMatch) throw new Error("invalid session reference");
      // A DB reference must not escape the data directory through symlinks.
      const realRoot = realpathSync(root);
      const realFile = realpathSync(row.conversation_ref);
      if (!realFile.startsWith(realRoot + path.sep) || !statSync(realFile).isFile()) throw new Error("invalid session reference");
      const exported = await readPiJsonlExport(realFile) as { messages?: Array<{ role?: unknown; text?: unknown }> };
      const messages: ChatMessage[] = [];
      for (const message of exported.messages ?? []) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        if (typeof message.text !== "string") continue;
        const text = message.role === "user" ? presentationText(message.text) : message.text;
        if (text.trim() === "") continue; // no tool calls, errors, thinking or image payloads
        messages.push({ role: message.role, text });
      }
      return { session, systemPrompt, messages };
    },
  };
}
