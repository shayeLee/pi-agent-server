import { describe, expect, it } from "vitest";
import { translateSdkEvent } from "../../src/agent/translate.js";

describe("compaction translation", () => {
  it.each(["manual", "threshold", "overflow"] as const)("maps %s start", reason => {
    expect(translateSdkEvent({ type: "compaction_start", reason })).toEqual({ type: "compaction_start", reason });
  });
  it.each([
    [false, undefined, "failed"], [true, undefined, "aborted"],
    [false, { tokensBefore: 12, estimatedTokensAfter: 4, summary: "secret" }, "succeeded"],
    [true, { tokensBefore: 12, estimatedTokensAfter: 4, summary: "secret" }, "aborted"],
  ] as const)("prioritizes aborted=%s over result", (aborted, result, outcome) => {
    const event = translateSdkEvent({ type: "compaction_end", reason: "overflow", aborted, result, willRetry: true, errorMessage: "secret error" });
    expect(event).toEqual({ type: "compaction_end", reason: "overflow", outcome, willRetry: true,
      ...(result ? { tokensBefore: 12, tokensAfter: 4 } : {}) });
    expect(JSON.stringify(event)).not.toContain("secret");
  });
  it.each([NaN, Infinity, -1])("omits invalid numbers %s", value => {
    expect(translateSdkEvent({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false,
      result: { tokensBefore: value, estimatedTokensAfter: value } })).toEqual({
        type: "compaction_end", reason: "manual", outcome: "succeeded", willRetry: false,
      });
  });
  it("preserves measured zero", () => {
    expect(translateSdkEvent({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false,
      result: { tokensBefore: 0, estimatedTokensAfter: 0 } })).toMatchObject({ tokensBefore: 0, tokensAfter: 0 });
  });
});
