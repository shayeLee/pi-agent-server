import { expect, it, vi } from "vitest";
import { ApiClient, consumeSse, type ControlQueueSnapshot, type ControlQueueItem } from "../../src/client/index.js";

it.each([202, 204])("followUp supports legacy and correlated empty %s admission without JSON parsing", async status => {
  const response = new Response(null, { status });
  const parse = vi.spyOn(response, "json");
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response);
  const api = new ApiClient({ fetch });
  await api.followUp("s", "legacy");
  await api.followUp("s", "same", { controlId: "a", requestId: "run", acknowledgementId: "ack" });
  expect(parse).not.toHaveBeenCalled();
  expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ text: "same", controlId: "a", requestId: "run", acknowledgementId: "ack" });
});

it("queue API uses public method names, identities and snapshots and preserves 409 for caller refresh", async () => {
  const item: ControlQueueItem = { id: "a", kind: "followUp", text: "same", hasImages: true, status: "queued", acknowledgementId: "ack" };
  const snapshot: ControlQueueSnapshot = { requestId: "run", revision: 2, items: [item] };
  const calls: Array<[string, RequestInit | undefined]> = [];
  const api = new ApiClient({ fetch: async (url, init) => { calls.push([String(url), init]); return new Response(JSON.stringify(snapshot)); } });
  expect(await api.getControlQueue("s")).toEqual(snapshot);
  const identity = { requestId: "run", acknowledgementId: "ack" };
  expect(await api.deleteControl("s", "a/b", identity)).toEqual(snapshot);
  expect(await api.promoteControl("s", "a/b", identity)).toEqual(snapshot);
  expect(calls.map(([url, init]) => [url, init?.method])).toEqual([
    ["/v1/sessions/s/control-queue", "GET"], ["/v1/sessions/s/control-queue/a%2Fb", "DELETE"],
    ["/v1/sessions/s/control-queue/a%2Fb/promote", "POST"] ]);
  expect(JSON.parse(calls[1]![1]!.body as string)).toEqual(identity);
  const conflict = new ApiClient({ fetch: async () => new Response("conflict", { status: 409 }) });
  await expect(conflict.deleteControl("s", "a", identity)).rejects.toMatchObject({ status: 409 });
  const events: unknown[] = [];
  await consumeSse({ url: "/events", fetch: async () => new Response(`data: ${JSON.stringify({ type: "control_queue", ...snapshot })}\n\n`), onEvent: event => { events.push(event); } });
  expect(events).toEqual([{ type: "control_queue", ...snapshot }]);
});
