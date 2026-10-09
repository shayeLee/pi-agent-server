// Offline provider only: real SDK session/factory, persistence and runtime remain in use.
export const providerFixture = `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  pi.registerProvider("native-fixture", {
    baseUrl: "https://fixture.invalid", apiKey: "offline-synthetic-key", api: "native-fixture-api",
    models: [{ id: "offline", name: "Offline fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 100 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: "离线模型继续完成" }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }], stopReason: "pending" } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "离线模型继续完成", partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: "离线模型继续完成", partial: message });
      stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
    }
  });
}
`;
