import { expect, it } from "vitest";
import { ApiClient, type SessionSystemPrompt } from "../../src/client/index.js";
import { openapiV1 } from "../../src/public-api/openapi-v1.js";

it.each<SessionSystemPrompt>([
  { source: "live_effective", prompt: "dynamic" }, { source: "live_effective", prompt: "" },
  { source: "creation_snapshot", prompt: "" },
  { source: "unavailable", prompt: null },
])("client preserves source and prompt: $source/$prompt", async snapshot => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const api = new ApiClient({ fetch: async (url, init) => {
    calls.push([String(url), init]); return new Response(JSON.stringify(snapshot));
  } });
  expect(await api.getSystemPrompt("s/id")).toEqual(snapshot);
  expect(calls[0]?.[0]).toBe("/v1/sessions/s%2Fid/system-prompt");
  expect(calls[0]?.[1]?.method).toBe("GET");
  expect(calls[0]?.[1]?.body).toBeUndefined();
});
it("client propagates missing/unauthorized without inventing a snapshot", async () => {
  const api = new ApiClient({ fetch: async () => new Response("not found", { status: 404 }) });
  await expect(api.getSystemPrompt("s")).rejects.toMatchObject({ status: 404 });
});
it("OpenAPI declares the independent authorized route and provenance union", () => {
  const doc = openapiV1 as any;
  const route = doc.paths["/v1/sessions/{id}/system-prompt"];
  expect(route.get.operationId).toBe("getSystemPrompt");
  expect(route.get["x-pi-rbac"].permission).toBe("sessions:export");
  expect(route.get.responses[200].content["application/json"].schema.$ref).toBe("#/components/schemas/SessionSystemPrompt");
  expect(doc.components.schemas.SessionSystemPrompt.oneOf).toHaveLength(2);
});
