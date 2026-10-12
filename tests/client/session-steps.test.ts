import { expect, it } from "vitest";
import { ApiClient, type SessionStepsSnapshot } from "../../src/client/index.js";
import { openapiV1 } from "../../src/public-api/openapi-v1.js";
it("GET steps encodes id and preserves authoritative order, empty/false/null content", async () => {
  const snapshot: SessionStepsSnapshot = { sessionId: "s/id", projectionId: "live", revision: 1101, steps: [
    { id: "b", kind: "tool_result", content: false, status: "completed", source: "observed" },
    { id: "a", kind: "tool_result", content: null, status: "completed", source: "observed" },
    { id: "empty", kind: "assistant_text", content: "", status: "streaming", source: "observed" },
  ] };
  const calls: string[] = [];
  const api = new ApiClient({ fetch: async (url, init) => { calls.push(String(url)); expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined(); return new Response(JSON.stringify(snapshot)); } });
  expect(await api.getSessionSteps("s/id")).toEqual(snapshot);
  expect(calls).toEqual(["/v1/sessions/s%2Fid/steps"]);
});
it("propagates 404 without fabricating a snapshot", async () => {
  const api = new ApiClient({ fetch: async () => new Response("not found", { status: 404 }) });
  await expect(api.getSessionSteps("s")).rejects.toMatchObject({ status: 404 });
});
it("OpenAPI documents full ordered snapshot and export-tier RBAC", () => {
  const doc = openapiV1 as any, route = doc.paths["/v1/sessions/{id}/steps"];
  expect(route.get.operationId).toBe("getSessionSteps");
  expect(route.get["x-pi-rbac"].permission).toBe("sessions:export");
  expect(route.get.responses[200].content["application/json"].schema.$ref).toBe("#/components/schemas/SessionStepsSnapshot");
  expect(doc.components.schemas.SessionStep.properties.kind.enum).toContain("thinking");
});
