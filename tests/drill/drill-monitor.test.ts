import { describe, expect, it } from "vitest";
import { renderWebhookServer } from "../../src/drill/drill-monitor.js";

describe("drill monitoring receiver", () => {
  it("writes and reads real JSONL newlines", () => {
    const source = renderWebhookServer();
    expect(source).toContain("JSON.stringify(record) + '\\n'");
    expect(source).toContain("data.split('\\n')");
    expect(source).not.toContain("JSON.stringify(record) + '\\\\n'");
    expect(source).not.toContain("data.split('\\\\n')");
  });
});
