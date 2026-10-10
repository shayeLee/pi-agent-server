import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildGroups, discoverSpecs, groupEnvironment } from "../web/e2e-groups.js";

interface TestResult { status: string }
interface ReportTest { projectId?: string; projectName: string; expectedStatus: string; status: string; results: TestResult[] }
interface ReportSpec { id: string; file: string; line: number; column: number; title: string; tests: ReportTest[] }
interface ReportSuite { suites?: ReportSuite[]; specs?: ReportSpec[] }
interface Report extends ReportSuite { config?: { rootDir: string }; errors?: unknown[] }
const testDir = resolve(dirname(fileURLToPath(import.meta.url)), "../web/e2e");
export function reportTests(report: Report) {
  const tests: { id: string; file: string; test: ReportTest }[] = [];
  function visit(suite: ReportSuite) {
    for (const spec of suite.specs ?? []) for (const test of spec.tests) {
      const file = relative(testDir, isAbsolute(spec.file) ? spec.file : resolve(report.config?.rootDir ?? testDir, spec.file)).replaceAll("\\", "/");
      tests.push({ id: JSON.stringify([spec.id, test.projectId ?? test.projectName]), file, test });
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  visit(report);
  return tests;
}
export function aggregate(discovered: number, reports: { code: number | null; report?: Report }[], interrupted = false) {
  const totals = { passed: 0, failed: 0, skipped: 0, unexecuted: discovered, exitCode: 0 };
  for (const entry of reports) {
    if (entry.code !== 0 || !entry.report || entry.report.errors?.length) totals.exitCode = 1;
    if (!entry.report) continue;
    for (const { test } of reportTests(entry.report)) {
      const last = test.results.at(-1);
      if (!last || last.status === "interrupted") continue;
      if (last.status === "skipped") {
        if (test.expectedStatus !== "skipped") continue;
        totals.skipped++;
      } else if (test.status === "unexpected") totals.failed++;
      else if (["expected", "flaky"].includes(test.status) && ["passed", "failed", "timedOut"].includes(last.status)) totals.passed++;
      else continue;
      totals.unexecuted--;
    }
  }
  if (interrupted || totals.failed || totals.unexecuted !== 0) totals.exitCode = 1;
  return totals;
}

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== "--");
  if (args.some(arg => arg !== "--list")) throw new Error("Supported arguments: --list (discovery only)");
  const listOnly = args.includes("--list");
  const web = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
  const groups = buildGroups(discoverSpecs(testDir));
  const output = mkdtempSync(resolve(tmpdir(), "pi-e2e-"));
  console.log(`E2E results: ${output}`);
  let child: ChildProcess | undefined;
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    // Only the current Playwright process: its signal handler cleans its own web servers.
    child?.kill("SIGINT");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const run = async (name: string, discovery: boolean, all = false) => {
    const dir = resolve(output, discovery ? "discovery" : "execution", name);
    mkdirSync(dir, { recursive: true });
    const code = await new Promise<number | null>(resolveCode => {
      child = spawn(process.execPath, [resolve(web, "node_modules/@playwright/test/cli.js"), "test", "--config", "playwright.e2e-group.config.ts", ...(discovery ? ["--list"] : [])], {
        cwd: web, stdio: "inherit", env: { ...groupEnvironment(all ? "general" : name, process.env), PI_E2E_GROUP: all ? "general" : name,
          PI_E2E_GROUP_OUTPUT: dir, PI_E2E_DISCOVERY_ALL: all ? "1" : "" },
      });
      child.once("error", error => { console.error(error); resolveCode(1); });
      child.once("close", resolveCode);
    });
    child = undefined;
    let report: Report | undefined;
    try { report = JSON.parse(readFileSync(resolve(dir, "report.json"), "utf8")) as Report; }
    catch (error) { console.error(`${name}: missing/invalid report`, error); }
    return { code, report };
  };
  let discovered = 0;
  const executions: { name: string; code: number | null; report?: Report }[] = [];
  try {
    const baseline = await run("all", true, true);
    if (baseline.code !== 0 || !baseline.report || baseline.report.errors?.length || interrupted) throw new Error("Baseline discovery failed/interrupted");
    const expected = new Set(reportTests(baseline.report).map(test => test.id));
    if (expected.size !== reportTests(baseline.report).length) throw new Error("Duplicate baseline discovery");
    discovered = expected.size;
    const seen = new Set<string>();
    const specs = new Set<string>();
    for (const group of groups) {
      if (interrupted) throw new Error("Discovery interrupted");
      const result = await run(group.name, true);
      if (result.code !== 0 || !result.report || result.report.errors?.length) throw new Error(`${group.name}: discovery failed`);
      const found = reportTests(result.report);
      const files = new Set(found.map(test => test.file));
      if (group.specs.some(spec => !files.has(spec)) || [...files].some(file => !group.specs.includes(file))) throw new Error(`${group.name}: missing/unexpected discovered spec`);
      for (const test of found) {
        if (seen.has(test.id) || !expected.has(test.id)) throw new Error(`${group.name}: duplicate/unexpected test ${test.id}`);
        seen.add(test.id); specs.add(test.file);
      }
      console.log(`Discovery ${group.name}: ${files.size} specs / ${found.length} tests`);
    }
    if (seen.size !== expected.size) throw new Error("Grouped discovery missing tests");
    console.log(`Verified discovery: ${specs.size} specs / ${seen.size} tests, no duplicates or omissions`);
    writeFileSync(resolve(output, "discovery.json"), JSON.stringify({ specs: [...specs], tests: [...seen], groups }, null, 2));
    if (!listOnly && !interrupted) {
      for (const group of groups) {
        if (interrupted) break;
        const result = await run(group.name, false);
        // Invalid/incomplete reports must not turn missing tests into a successful run.
        if (result.report) {
          const actual = reportTests(result.report).map(test => test.id);
          const expectedGroup = JSON.parse(readFileSync(resolve(output, "discovery", group.name, "report.json"), "utf8")) as Report;
          const ids = new Set(reportTests(expectedGroup).map(test => test.id));
          if (actual.length !== ids.size || new Set(actual).size !== ids.size || actual.some(id => !ids.has(id))) result.code = 1;
        }
        executions.push({ name: group.name, ...result });
      }
    }
    if (listOnly) { process.exitCode = interrupted ? 1 : 0; return; }
    const totals = aggregate(discovered, executions, interrupted);
    writeFileSync(resolve(output, "summary.json"), JSON.stringify({ ...totals, interrupted, groups: executions.map(({ name, code, report }) => ({ name, code, reportPresent: !!report })) }, null, 2));
    console.log(`Total: ${totals.passed} passed / ${totals.failed} failed / ${totals.skipped} skipped / ${totals.unexecuted} unexecuted`);
    process.exitCode = totals.exitCode;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
