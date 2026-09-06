import { describe, expect, it } from "vitest";
import {
  FAULT_KINDS,
  FAULT_SCENARIOS,
  guardStepId,
  isAlertCycle,
  isValidFault,
  recoveryStepId,
} from "../../src/drill/drill-faults.js";

describe("故障矩阵定义", () => {
  it("覆盖 SOP §4 的至少 12 个故障场景", () => {
    expect(FAULT_SCENARIOS.length).toBeGreaterThanOrEqual(12);
  });

  it("每个场景都有 guard/recovery 且 id 唯一", () => {
    for (const scenario of FAULT_SCENARIOS) {
      expect(scenario.guardStep).toContain("guard");
      expect(scenario.recoveryStep).toContain("recovery");
      expect(scenario.guardStep).not.toBe(scenario.recoveryStep);
    }
  });

  it("guardStepId/recoveryStepId 稳定且可逆", () => {
    const fault = "stale-alert";
    const guard = guardStepId(fault);
    const recovery = recoveryStepId(fault);
    expect(guard).toBe("fault:guard:stale-alert");
    expect(recovery).toBe("fault:recovery:stale-alert");
    const spec = FAULT_SCENARIOS.find((s) => s.fault === fault)!;
    expect(spec.guardStep).toBe(guard);
    expect(spec.recoveryStep).toBe(recovery);
  });

  it("监控类故障标记 alertCycle", () => {
    expect(isAlertCycle("missing-alert")).toBe(true);
    expect(isAlertCycle("exporter-down")).toBe(true);
    expect(isAlertCycle("textfile-scrape-error")).toBe(true);
    expect(isAlertCycle("age-failure")).toBe(false);
  });

  it("isValidFault 只放行授权枚举", () => {
    expect(isValidFault("age-failure")).toBe(true);
    expect(isValidFault("stale-alert")).toBe(true);
    expect(isValidFault("drop-database")).toBe(false);
  });

  it("FAULT_KINDS 与场景一一对应", () => {
    expect(FAULT_KINDS.length).toBe(FAULT_SCENARIOS.length);
  });
});
