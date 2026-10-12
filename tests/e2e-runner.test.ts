import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildGroups, discoverSpecs, excludedSpecs, findGroup, groupEnvironment, specMatch } from "../web/e2e-groups.js";
import { aggregate, reportTests } from "../scripts/e2e.mjs";

describe("E2E mapping", () => {
  it("assigns rich specs exactly once and preserves default exclusions", () => {
    const files = discoverSpecs(resolve(dirname(fileURLToPath(import.meta.url)), "../web/e2e"));
    const groups = buildGroups(files);
    expect(findGroup(groups, "rich")).toEqual({ name: "rich", config: "playwright.rich-local.config.ts", specs: ["rich-app.spec.ts", "start-state.spec.ts"] });
    const assigned = groups.flatMap(group => group.specs);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect([...assigned].sort()).toEqual(files.filter(file => !excludedSpecs.includes(file)).sort());
    expect(findGroup(groups, "general").specs).not.toContain("rich-app.spec.ts");
    expect(findGroup(groups, "general").specs).not.toContain("start-state.spec.ts");
  });
  it("routes isolated UI fixtures to their dedicated frontend-only configurations", async () => {
    const groups = buildGroups(discoverSpecs(resolve(dirname(fileURLToPath(import.meta.url)), "../web/e2e")));
    for (const name of ["workspace", "ui-foundation", "control-queue", "steps"]) {
      const specs = name === "workspace" ? ["workspace.spec.ts", "session-search-align.spec.ts", "theme-menu.spec.ts", "composer-geometry.spec.ts", "focus-appearance.spec.ts", "typography.spec.ts"] : name === "steps" ? ["steps.spec.ts", "inspector-app.spec.ts"] : [`${name}.spec.ts`];
      expect(findGroup(groups, name)).toEqual({ name, config: `playwright.${name}.config.ts`, specs });
      for (const spec of specs) expect(findGroup(groups, "general").specs).not.toContain(spec);
      try {
        vi.stubEnv("PI_E2E_GROUP", name);
        vi.stubEnv("PI_E2E_GROUP_OUTPUT", "/tmp/e2e-config-unit");
        vi.stubEnv("PI_E2E_DISCOVERY_ALL", "");
        vi.resetModules();
        const { default: config } = await import("../web/playwright.e2e-group.config.js");
        const servers = Array.isArray(config.webServer) ? config.webServer : [config.webServer];
        expect(servers).toHaveLength(1);
        expect(servers[0]?.command).toContain("VITE_API_TARGET=http://127.0.0.1:1 ");
        expect(servers[0]?.reuseExistingServer).toBe(false);
        const port = name === "control-queue" ? 60174 : name === "steps" ? 60186 : 5190;
        expect(config.use?.baseURL).toBe(`http://127.0.0.1:${port}`);
        expect(servers[0]?.url).toBe(config.use?.baseURL);
        expect(servers[0]?.command).toContain(`--port ${port}`);
        expect(config.testMatch).toEqual(specs.map(spec => specMatch(resolve(dirname(fileURLToPath(import.meta.url)), "../web/e2e"), spec)));
      } finally { vi.unstubAllEnvs(); vi.resetModules(); }
    }
  });
  it("automatically includes new ordinary specs in general", () => {
    const groups = buildGroups(["ordinary.spec.ts", "special.spec.ts", "new.spec.ts"], [
      { name: "special", config: "special.config.ts", specs: ["special.spec.ts"] },
    ]);
    expect(groups[0]?.specs).toEqual(["new.spec.ts", "ordinary.spec.ts"]);
    expect(() => findGroup(groups, "unknown")).toThrow("Unknown E2E group");
  });
  it("rejects duplicate and missing mappings", () => {
    const special = { name: "one", config: "one.ts", specs: ["one.spec.ts"] };
    expect(() => buildGroups(["one.spec.ts"], [special, { ...special, name: "two" }])).toThrow("Duplicate mapped spec");
    expect(() => buildGroups([], [special])).toThrow("Missing mapped spec");
    expect(() => buildGroups(["one.spec.ts"], [special, special])).toThrow("Duplicate group");
  });
  it("discovers nested specs and matches only the exact path, including regex characters", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "e2e-mapping-"));
    try {
      mkdirSync(resolve(dir, "nested/deeper"), { recursive: true });
      for (const file of ["same.spec.ts", "nested/same.spec.ts", "nested/deeper/new[1].spec.ts", "helper.ts"]) {
        writeFileSync(resolve(dir, file), "");
      }
      const files = discoverSpecs(dir);
      expect(files).toEqual(["nested/deeper/new[1].spec.ts", "nested/same.spec.ts", "same.spec.ts"]);
      const groups = buildGroups(files, [{ name: "special", config: "special.ts", specs: ["same.spec.ts"] }]);
      expect(groups[0]?.specs).toEqual(["nested/deeper/new[1].spec.ts", "nested/same.spec.ts"]);
      expect(specMatch(dir, "same.spec.ts").test(resolve(dir, "same.spec.ts"))).toBe(true);
      expect(specMatch(dir, "same.spec.ts").test(resolve(dir, "nested/same.spec.ts"))).toBe(false);
      expect(specMatch(dir, "nested/deeper/new[1].spec.ts").test(resolve(dir, "nested/deeper/new[1].spec.ts"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("E2E scenario isolation", () => {
  it("overrides inherited rich for every non-rich group without mutating the parent", () => {
    const env = { MOCK_SCENARIO: "rich", UNRELATED: "preserved" };
    const groups = buildGroups(discoverSpecs(resolve(dirname(fileURLToPath(import.meta.url)), "../web/e2e")));
    for (const name of ["all", ...groups.map(group => group.name)]) {
      expect(groupEnvironment(name, env)).toEqual({ ...env, MOCK_SCENARIO: name === "rich" ? "rich" : "" });
    }
    expect(env.MOCK_SCENARIO).toBe("rich");
    expect(groupEnvironment("rich", {}).MOCK_SCENARIO).toBe("rich");
  });
  it("isolates discovery workers and mock services even with inherited rich", async () => {
    try {
      for (const [name, all, scenario] of [["general", "", ""], ["rich", "", "rich"], ["rich", "1", ""]]) {
        vi.resetModules();
        vi.stubEnv("PI_E2E_GROUP", name!);
        vi.stubEnv("PI_E2E_DISCOVERY_ALL", all!);
        vi.stubEnv("PI_E2E_GROUP_OUTPUT", "/tmp/e2e-config-unit");
        vi.stubEnv("MOCK_SCENARIO", "rich");
        const { default: config } = await import("../web/playwright.e2e-group.config.js");
        expect(process.env.MOCK_SCENARIO).toBe(scenario);
        const servers = Array.isArray(config.webServer) ? config.webServer : [config.webServer];
        expect(servers).toHaveLength(2);
        for (const server of servers) {
          expect(server?.env?.MOCK_SCENARIO).toBe(scenario);
          expect(server?.reuseExistingServer).toBe(false);
        }
        expect(config.use?.baseURL).toBe("http://127.0.0.1:5189");
        expect(config.use?.channel).toBe("chrome");
      }
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });
});

const report = (status: string, outcome = "expected", expectedStatus = "passed") => ({ suites: [{ specs: [{
  id: "native-spec-id", file: "example.spec.ts", line: 1, column: 1, title: "test",
  tests: [{ projectId: "chrome", projectName: "Chrome", expectedStatus, status: outcome, results: [{ status }] }],
}] }] });
describe("E2E aggregation", () => {
  it("retains later results after child failure and separates skipped/unexecuted", () => {
    expect(aggregate(4, [
      { code: 1, report: report("failed", "unexpected") },
      { code: 0, report: report("passed") },
      { code: 0, report: report("skipped", "skipped", "skipped") },
      { code: 1 },
    ])).toEqual({ passed: 1, failed: 1, skipped: 1, unexecuted: 1, exitCode: 1 });
  });
  it("counts only intentional skips, leaving blocked skips, empty results and interruption unexecuted", () => {
    const empty = report("passed");
    empty.suites[0]!.specs[0]!.tests[0]!.results = [];
    expect(aggregate(4, [
      { code: 0, report: report("skipped", "skipped", "skipped") },
      { code: 0, report: report("skipped", "skipped") },
      { code: 0, report: empty },
      { code: 0, report: report("interrupted") },
    ])).toEqual({ passed: 0, failed: 0, skipped: 1, unexecuted: 3, exitCode: 1 });
  });
  it("uses Playwright outcomes for expected failures, unexpected passes and flaky retries", () => {
    expect(aggregate(1, [{ code: 0, report: report("failed", "expected", "failed") }]))
      .toEqual({ passed: 1, failed: 0, skipped: 0, unexecuted: 0, exitCode: 0 });
    // test.fail() unexpectedly passing must not produce a false green, even with code 0.
    expect(aggregate(1, [{ code: 0, report: report("passed", "unexpected", "failed") }]))
      .toEqual({ passed: 0, failed: 1, skipped: 0, unexecuted: 0, exitCode: 1 });
    const flaky = report("passed", "flaky");
    flaky.suites[0]!.specs[0]!.tests[0]!.results.unshift({ status: "failed" });
    expect(aggregate(1, [{ code: 0, report: flaky }]).passed).toBe(1);
  });
  it("fails on missing report or interruption, even if all recorded tests pass", () => {
    expect(aggregate(1, [{ code: 0, report: report("passed") }, { code: 0 }]).exitCode).toBe(1);
    expect(aggregate(1, [{ code: 0, report: report("interrupted") }], true).unexecuted).toBe(1);
    expect(aggregate(1, [{ code: 0, report: report("passed") }], true).exitCode).toBe(1);
    expect(aggregate(1, [{ code: 0, report: report("passed") }]).exitCode).toBe(0);
  });
});

describe("E2E report identity", () => {
  it("preserves nested paths, normalizes JSON paths and uses native IDs for parameterized describes", () => {
    const testDir = resolve(dirname(fileURLToPath(import.meta.url)), "../web/e2e");
    const first = report("passed").suites[0]!.specs[0]!;
    const input = { config: { rootDir: resolve(testDir, "..") }, suites: [{ specs: [
      { ...first, file: "e2e/nested/example.spec.ts" },
      { ...first, id: "another-native-id", file: resolve(testDir, "nested/example.spec.ts") },
      { ...first, id: "root-native-id", file: "e2e/example.spec.ts" },
      { ...first, tests: [{ ...first.tests[0]!, projectId: "other-project" }], file: "e2e/nested/example.spec.ts" },
    ] }] };
    const tests = reportTests(input);
    expect(tests.map(test => test.file)).toEqual(["nested/example.spec.ts", "nested/example.spec.ts", "example.spec.ts", "nested/example.spec.ts"]);
    expect(new Set(tests.map(test => test.id)).size).toBe(4);
    expect(reportTests({ suites: [{ specs: [{ ...first, file: "nested/example.spec.ts" }] }] })[0]?.id).toBe(tests[0]?.id);
  });
});
