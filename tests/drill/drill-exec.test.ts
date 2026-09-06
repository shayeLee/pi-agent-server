import { describe, expect, it } from "vitest";
import { defaultDrillPlan, type DrillEnv, type DrillObservation } from "../../src/drill/drill-core.js";
import { assertValidFaultSet, runDrill, type DrillExecutor } from "../../src/drill/drill-exec.js";

/** fixture 执行器：按步骤命中表返回给定观察（不调用 podman / CLI）。 */
function fixtureExecutor(table: Record<string, boolean>): DrillExecutor {
  return {
    name: "fixture",
    versions: { node: "v24.19.0" },
    async step(stepId: string): Promise<DrillObservation> {
      const passed = table[stepId] ?? true;
      return { stepId, passed, detail: passed ? "ok" : "fail", durationMs: 1 };
    },
    async cleanup(): Promise<void> {
      /* no-op */
    },
  };
}

describe("runDrill 编排 + 判定（fixture adapter，不依赖 podman）", () => {
  it("全通过 → PASS，证据记录步骤数与通过计数", async () => {
    const plan = defaultDrillPlan();
    const executor = fixtureExecutor({});
    const result = await runDrill(executor, {} as DrillEnv, plan);
    expect(result.adjudication.outcome).toBe("PASS");
    expect(result.adjudication.passedCount).toBe(plan.steps.length);
    expect(result.evidence.stepCount).toBe(plan.steps.length);
    expect(result.evidence.outcome).toBe("PASS");
  });

  it("先决条件 provision 未过 → DEFERRED", async () => {
    const plan = defaultDrillPlan();
    const executor = fixtureExecutor({ provision: false });
    const result = await runDrill(executor, {} as DrillEnv, plan);
    expect(result.adjudication.outcome).toBe("DEFERRED");
    expect(result.adjudication.deferredBy).toContain("provision");
  });

  it("强制成功路径未过 → FAIL", async () => {
    const plan = defaultDrillPlan();
    const executor = fixtureExecutor({ "monitor-normal": false });
    const result = await runDrill(executor, {} as DrillEnv, plan);
    expect(result.adjudication.outcome).toBe("FAIL");
    expect(result.adjudication.mandatoryFailures.map((o) => o.stepId)).toContain("monitor-normal");
  });

  it("任一故障场景 guard 未过 → FAIL", async () => {
    const plan = defaultDrillPlan();
    const fault = plan.faultScenarios[0]!.fault;
    const executor = fixtureExecutor({ [plan.faultScenarios[0]!.guardStep]: false });
    const result = await runDrill(executor, {} as DrillEnv, plan);
    expect(result.adjudication.outcome).toBe("FAIL");
    expect(result.adjudication.faultFailures.some((f) => f.fault === fault)).toBe(true);
  });

  it("step 抛异常 → 记为 FAIL 观察，不冒泡崩溃", async () => {
    const plan = defaultDrillPlan();
    const executor: DrillExecutor = {
      name: "fixture-crash",
      versions: {},
      async step(stepId: string): Promise<DrillObservation> {
        if (stepId === "backup-sqlite-success") throw new Error("boom");
        return { stepId, passed: true, detail: "ok", durationMs: 0 };
      },
      async cleanup(): Promise<void> { /* no-op */ },
    };
    const result = await runDrill(executor, {} as DrillEnv, plan);
    expect(result.adjudication.outcome).toBe("FAIL");
    expect(result.observations.find((o) => o.stepId === "backup-sqlite-success")?.passed).toBe(false);
  });
});

describe("assertValidFaultSet", () => {
  it("放行授权故障", () => {
    expect(() => assertValidFaultSet(["stale-alert", "exporter-down"])).not.toThrow();
  });
  it("拒绝未知故障", () => {
    expect(() => assertValidFaultSet(["drop-database"])).toThrow(/unknown drill fault/);
  });
});
