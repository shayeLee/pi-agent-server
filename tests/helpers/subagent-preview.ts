/** Isolated browser acceptance fixture. No provider, user data or production server. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TranscriptJournal } from "../../integrations/agent-team/transcript.js";
import { projectSubagents } from "../../src/agent/subagent-transcript.js";
import { projectExportSnapshot } from "../../src/agent/session-export.js";
import { PiJsonlConversationStorage } from "../../src/agent/pi-jsonl-conversation-storage.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { buildApp } from "../../src/server/app.js";
import { ConversationStorageRegistry, DEFAULT_PROJECT_ID } from "../../src/application/ports/index.js";
import { identityKey } from "../../src/core/user-identity.js";
import { makeInitializedMemoryDb } from "./sqlite.js";
import { makeTestIpAccess } from "./ip-access.js";

export async function createSubagentPreview() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-child-preview-"));
  const db = await makeInitializedMemoryDb({ cwd: root, dataDir: root });
  const manager = SessionManager.create(root, path.join(root, "sessions", "preview"));
  manager.appendMessage({ role: "user", content: "请检查子代理记录功能。", timestamp: Date.now() });
  const active = new Set<string>();
  const journal = new TranscriptJournal((type, data) => manager.appendCustomEntry(type, data), (_type, data: any) => {
    if (data.kind === "start") active.add(data.id);
    if (data.kind === "end") active.delete(data.id);
  });
  const message = (id: string, value: any) => { journal.event(id, { type: "message_start", message: value }); journal.event(id, { type: "message_end", message: value }); };
  journal.start({ id: "2", agent: "worker", task: "排查会话 404 的原因", startedAt: Date.now() - 138000, model: "fixture/offline" });
  message("2", { role: "user", content: "只读排查会话接口返回 404 的原因，给出具体代码路径和证据。" });
  message("2", { role: "assistant", content: [{ type: "text", text: "我先核对会话记录、访问权限和事件接口的处理链路。" }, { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/application/session-service.ts" } }] });
  message("2", { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "async findOwned(ownerKey, id) { return this.sessions.get(id); }" }], isError: false });
  const text = "请优先确认数据库记录是否存在，不要修改文件或重启服务。";
  journal.steer("2", text)(true);
  message("2", { role: "user", content: text });
  message("2", { role: "assistant", content: [{ type: "text", text: "收到，我会保持只读检查，先核对会话记录与运行状态。" }, { type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "rg -n 'onRevoked|registry.delete' src/" } }] });
  message("2", { role: "toolResult", toolCallId: "bash-1", toolName: "bash", content: [{ type: "text", text: "src/application/session-service.ts\nawait registry.delete(sessionId);\n完整结果末行（验收）" }], isError: false });
  message("2", { role: "assistant", content: [{ type: "text", text: "正在检查运行状态失效与会话记录之间的关联。" }] });
  for (const [id, agent, task] of [["1", "worker", "核对接口与权限检查"], ["3", "rescue", "复核历史会话恢复"]]) {
    journal.start({ id: id!, agent: agent!, task: task!, startedAt: Date.now() - 100000 });
    message(id!, { role: "user", content: task });
    message(id!, { role: "assistant", content: [{ type: "text", text: "检查完成。记录已保留。" }] });
    journal.finish(id!, "completed", { endedAt: Date.now() - 1000 });
  }
  await db.sessions.create({ id: "preview", title: "子代理会话验收（模拟数据）", ownerKey: identityKey({ kind: "ip", ip: "127.0.0.1" }), projectId: DEFAULT_PROJECT_ID,
    createdAt: Date.now(), updatedAt: Date.now(), agentKind: "pi", conversationFormat: "pi-jsonl-v3", conversationRef: manager.getSessionFile()!,
    modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null, capabilityVersions: null });
  const storage = new ConversationStorageRegistry(); storage.register(new PiJsonlConversationStorage(root));
  const adapter = new MockAgentAdapter();
  adapter.exportSession = async () => projectExportSnapshot([], manager.getBranch());
  Object.assign(adapter, { getSubagents: (id: string, runId?: string) => projectSubagents(id, manager.getBranch(), { active, partials: new Map() }, runId) });
  const app = buildApp({ sessions: db.sessions, projects: db.projects, conversationStorage: storage, defaultProjectCwd: root,
    ipAccess: makeTestIpAccess(), createAdapter: async () => adapter });
  return { app, db, root, manager, journal };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await createSubagentPreview();
  await fixture.app.listen({ host: "127.0.0.1", port: 5358 });
  console.log("Subagent acceptance fixture: http://127.0.0.1:5358", fixture.root);
  process.on("SIGINT", async () => { await fixture.app.close(); await fixture.db.close(); process.exit(0); });
}
