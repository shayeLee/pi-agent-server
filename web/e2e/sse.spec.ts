import { test, expect } from "@playwright/test";

// mock server 以 MAX_SSE_PER_USER=2 / MAX_SSE_GLOBAL=10 启动，并允许 vite(5173) 跨域。
// 浏览器从 vite 页面直连 8081 测 SSE（vite 代理对 hijack SSE 响应头转发不可靠）。
// 内网（127.0.0.1）免 token，无 authorization 头时为简单 GET（不触发 CORS preflight）。

const API = "http://127.0.0.1:8081";

test("SSE 连接配额：超过每用户上限返回 429，断开后可重连", async ({ page, request }) => {
  // 创建会话（request fixture 跑在 Node，不经浏览器 CORS）
  const created = await request.post(`${API}/v1/sessions`, { data: { title: "SSE 配额" } });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();

  // 浏览器上下文里建立 2 个挂起的 SSE 连接（每用户配额 = 2）
  await page.goto("/");
  await page.evaluate(async ({ api, sessionId }) => {
    const url = `${api}/v1/sessions/${sessionId}/events`;
    const handles: Array<{ abort: () => void }> = [];
    const open = () => {
      const ac = new AbortController();
      const p = fetch(url, { signal: ac.signal }).then((res) => {
        (window as unknown as { __lastStatus?: number }).__lastStatus = res.status;
      });
      handles.push({ abort: () => ac.abort() });
      return p;
    };
    await Promise.all([open(), open()]);
    (window as unknown as { __sseHandles?: typeof handles }).__sseHandles = handles;
  }, { api: API, sessionId: id });

  // 第 3 个连接超过每用户上限 → 429
  const third = await page.evaluate(async ({ api, sessionId }) => {
    const res = await fetch(`${api}/v1/sessions/${sessionId}/events`);
    return res.status;
  }, { api: API, sessionId: id });
  expect(third).toBe(429);

  // 断开一个连接，等服务端收到 close 并释放配额，再开新连接应成功（断线清理）
  await page.evaluate(() => {
    const handles = (window as unknown as { __sseHandles?: Array<{ abort: () => void }> }).__sseHandles;
    handles?.[0]?.abort();
  });
  await page.waitForTimeout(500);

  const fourth = await page.evaluate(async ({ api, sessionId }) => {
    const res = await fetch(`${api}/v1/sessions/${sessionId}/events`);
    return res.status;
  }, { api: API, sessionId: id });
  expect(fourth).toBe(200);
});
