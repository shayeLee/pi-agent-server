import { describe, expect, it } from "vitest";
import { SessionTitler, cleanTitle } from "../../src/application/session-titler.js";

describe("session titler", () => {
  it("keeps a one-line title and strips quotes, prefixes and trailing stops", () => {
    expect(cleanTitle("「修复登录跳转」。")).toBe("修复登录跳转");
    expect(cleanTitle("标题：迁移到 Vite 8\n解释……")).toBe("迁移到 Vite 8");
    expect(cleanTitle("**Fix flaky e2e**")).toBe("Fix flaky e2e");
    // Width, not characters: ASCII counts half, so mixed titles are not cut short.
    expect(cleanTitle("登录记住我迁移至 httpOnly cookie")).toBe("登录记住我迁移至 httpOnly cookie");
    expect(cleanTitle("x".repeat(41))).toBeNull();
  });

  it("rejects replies that do not look like a title", () => {
    for (const text of ["", "   ", "这".repeat(21), "<b>标题</b>", "[链接](x)"]) expect(cleanTitle(text)).toBeNull();
  });

  it("sends a bounded prompt and skips prompts without text", async () => {
    const seen: string[] = [];
    const titler = new SessionTitler({ complete: async ({ prompt }) => { seen.push(prompt); return "长文本摘要"; } });
    expect(await titler.title("  ")).toBeNull();
    expect(await titler.title("x".repeat(5000))).toBe("长文本摘要");
    expect(seen).toEqual(["x".repeat(1200)]);
  });
});
