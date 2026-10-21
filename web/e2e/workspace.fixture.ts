import type { Page } from '@playwright/test';
import { isOptionalFeature, notFound } from "./optional-features";
export async function workspaceFixture(page: Page, command = 'printf "fixture output"', resetStorage = true) {
  const unexpected: string[] = [];
  if (resetStorage) await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  const now = Date.now();
  const sessions = ['隔离样例：检查草稿保留', '隔离样例：事件顺序', '隔离样例：附件状态', '隔离样例：历史回放'].map((title, i) => ({
    id: `fixture-${i}`, projectId: 'fixture-project', title, createdAt: now - i * 86400000,
    updatedAt: now - [600000, 86400000, 3 * 86400000, 20 * 86400000][i]!, modelProvider: 'fixture', modelId: 'fixture-model', thinkingLevel: 'off', systemPrompt: null,
  }));
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (isOptionalFeature(path)) return route.fulfill(notFound);
    if (route.request().method() === 'GET') {
      if (path === '/v1/access') return json({ canRead: true, canWrite: true });
      if (path === '/v1/projects') return json([{ id: 'fixture-project', name: '隔离 UI 项目', cwd: '/fixture', isDefault: true }]);
      if (path === '/v1/models') return json({ models: [{ provider: 'fixture', id: 'fixture-model', name: 'Fixture model' }], defaultModel: { provider: 'fixture', id: 'fixture-model' }, thinkingLevels: ['off', 'medium'], defaultThinkingLevel: 'off' });
      if (path === '/v1/sessions') return json(sessions);
      if (/^\/v1\/sessions\/fixture-\d+\/control-queue$/.test(path)) return json({ requestId: null, revision: 0, items: [] });
      const subagentsMatch = /^\/v1\/sessions\/([^/]+)\/subagents$/.exec(path);
      if (subagentsMatch) return json({ sessionId: subagentsMatch[1], runs: [] });
      const stepsMatch = /^\/v1\/sessions\/(fixture-\d+)\/steps$/.exec(path);
      if (stepsMatch) return json({ sessionId: stepsMatch[1], projectionId: 'workspace-fixture', revision: 0, steps: [] });
      if (/^\/v1\/sessions\/fixture-\d+\/system-prompt$/.test(path)) return json({ source: 'unavailable', prompt: null });
      if (path.endsWith('/events')) return route.fulfill({ status: 204, body: '' });
      if (path.endsWith('/export')) return json({ messages: [], lastEventId: 0, timeline: [
        { type: 'message', id: 'user', role: 'user', text: '这是隔离视觉样例，不是实际执行记录。\n请检查提交失败时的草稿保留与工具展示。' },
        { type: 'message', id: 'assistant', role: 'assistant', text: '先检查提交入口，再核对错误处理。以下内容均来自测试 fixture；不会访问真实 API。' },
        ...[
          { toolName: 'read', args: { path: '/fixture/draft.ts' }, result: 'export function keepDraft(text: string) {\n  return text;\n}', durationMs: 12 },
          { toolName: 'grep', args: { pattern: 'keepDraft', path: '/fixture' }, result: '/fixture/draft.ts:1:keepDraft', durationMs: 8 },
          { toolName: 'bash', args: { command }, result: 'fixture output\nThis is a controlled fixture log, not a test verdict.', durationMs: 24 },
          { toolName: 'edit', args: { path: '/fixture/draft.ts', oldText: 'return text;', newText: 'return text.trim();' }, result: 'Fixture edit result', durationMs: 10 },
        ].flatMap((call, i) => [
          { type: 'tool_call', id: `start-${i}`, toolCallId: `tool-${i}`, toolName: call.toolName, args: call.args },
          { type: 'tool_result', id: `end-${i}`, toolCallId: `tool-${i}`, toolName: call.toolName, result: call.result, durationMs: call.durationMs, isError: false },
        ]),
      ] });
    }
    unexpected.push(`${route.request().method()} ${path}`); await route.abort();
  });
  return unexpected;
}
