import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiClient } from "./api.js";

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
});
