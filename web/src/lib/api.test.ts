import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiClient, ApiError } from "pi-agent-server/client";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiClient", () => {
  it("listSessions 携带 Bearer token 并返回会话列表", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([{ id: "s1", ownerKey: "account:u1", title: "t", createdAt: 1, updatedAt: 1 }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = new ApiClient("", "secret");
    const sessions = await api.listSessions();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/sessions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("s1");
  });

  it("未配置 token 时请求不带 Authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const api = new ApiClient({ baseUrl: "" });
    await api.listSessions();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("sendMessage POST 正确路径与 body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "accepted" }, 202));
    vi.stubGlobal("fetch", fetchMock);

    const api = new ApiClient("", "t");
    await api.sendMessage("s1", { requestId: "r1", prompt: "hi", parentId: "p1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/sessions/s1/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      requestId: "r1",
      prompt: "hi",
      parentId: "p1",
    });
  });

  it("abort 无 body 不发送 content-type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = new ApiClient("", "t");
    await api.abort("s1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("非 2xx 抛错并带状态码", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "x" }, 404)));
    const api = new ApiClient("", "t");
    await expect(api.deleteSession("nope")).rejects.toThrow(/404/);
  });

  it("getAccess GET /v1/access 返回 {canRead,canWrite}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ canRead: true, canWrite: false }));
    vi.stubGlobal("fetch", fetchMock);

    const api = new ApiClient("", "t");
    await expect(api.getAccess()).resolves.toEqual({ canRead: true, canWrite: false });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/access");
    expect(init.method).toBe("GET");
  });
  it("auth 接口：路径、方法与 body", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ mode: "accounts", publicOrigin: "http://h:5180" }))
      .mockResolvedValueOnce(jsonResponse({ account: { id: "a1", name: "mz", role: "admin" } }))
      .mockResolvedValueOnce(jsonResponse({ account: { id: "a1", name: "mz", role: "admin" }, via: "cookie" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "" });

    await expect(api.getAuthState()).resolves.toEqual({ mode: "accounts", publicOrigin: "http://h:5180" });
    await expect(api.login("mz", "pw")).resolves.toEqual({ account: { id: "a1", name: "mz", role: "admin" } });
    await expect(api.getAuthMe()).resolves.toMatchObject({ via: "cookie" });
    await api.changePassword("old", "new");
    await api.logout();

    const calls = fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method, (init as RequestInit).body]);
    expect(calls).toEqual([
      ["/v1/auth/state", "GET", undefined],
      ["/v1/auth/login", "POST", JSON.stringify({ name: "mz", password: "pw" })],
      ["/v1/auth/me", "GET", undefined],
      ["/v1/auth/password", "PUT", JSON.stringify({ current: "old", next: "new" })],
      ["/v1/auth/logout", "POST", undefined],
    ]);
  });

  it("错误带上服务端的 code 与 Retry-After", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "login_backoff" }), {
      status: 429, headers: { "content-type": "application/json", "retry-after": "8" },
    })));
    const error = await new ApiClient({ baseUrl: "" }).login("mz", "pw").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: "login_backoff", retryAfter: 8 });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("plain", { status: 500 })));
    expect(await new ApiClient({ baseUrl: "" }).getAuthMe().catch((caught: unknown) => caught)).toMatchObject({ status: 500, code: undefined, retryAfter: undefined });
  });
});
