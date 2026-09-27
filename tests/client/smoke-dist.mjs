import assert from "node:assert/strict";
import { ApiClient, consumeSse, createChatStore } from "pi-agent-server/client";

const api = new ApiClient({
  resolveUrl: (path) => `smoke://agent${path}`,
  fetch: async () => new Response("[]", { headers: { "content-type": "application/json" } }),
});
assert.deepEqual(await api.listSessions(), []);

const stream = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('id: 9\ndata: {"type":"completed"}\n\n'));
    controller.close();
  },
});
const events = [];
await consumeSse({
  url: "smoke://agent/events",
  fetch: async () => new Response(stream),
  onEvent: (event, id) => events.push([event.type, id]),
});
assert.deepEqual(events, [["completed", 9]]);
assert.equal(createChatStore().getState().phase, "idle");
console.log("client dist smoke passed");
