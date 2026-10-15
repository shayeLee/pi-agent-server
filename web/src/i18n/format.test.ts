import { describe, expect, it } from "vitest";
import { formatCompact, formatDateTime, formatDuration, formatExact, formatPercent, formatSpan, formatSpeed, formatTokens, formatUsd } from "./format.js";
import { zhCN } from "./zh-CN.js";

describe("locale formats (zh-CN)", () => {
  it("abbreviates and groups numbers the locale's way", () => {
    expect(formatCompact(10000)).toBe("1万");
    expect(formatCompact(2345678)).toBe("235万");
    expect(formatCompact(646_070_000)).toBe("6.46亿");
    expect(formatCompact(4403)).toBe("4403");
    expect(formatExact(2345678)).toBe("2,345,678");
  });
  it("uses one style for percentages, money, speeds and token amounts", () => {
    expect(formatPercent(0.44)).toBe("0.44%");
    expect(formatPercent(95.4)).toBe("95%");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatTokens(13000)).toBe(zhCN.units.tokens("1.3万"));
    expect(formatSpeed(123.6)).toBe(zhCN.units.speed("124"));
    expect(formatSpeed(100, true)).toBe(zhCN.units.liveSpeed("100"));
  });
  it("spells durations out for details and keeps ledger spans compact", () => {
    expect(formatDuration(999)).toBe("999 毫秒");
    expect(formatDuration(1234)).toBe("1.2 秒");
    expect(formatSpan(15)).toBe("15ms");
    expect(formatSpan(318_000)).toBe("5m18s");
    expect(formatSpan(3_780_000)).toBe("1h03m");
  });
  it("formats dates in the language object's locale, 24-hour", () => {
    expect(formatDateTime(new Date(2026, 9, 15, 22, 6, 27))).toBe("2026/10/15 22:06:27");
  });
});
