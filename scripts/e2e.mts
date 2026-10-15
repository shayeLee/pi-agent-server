import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
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

// Runs fn over items with at most `limit` in flight; results keep the input order.
export async function inPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>, stop = () => false): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export function concurrencyFrom(env: NodeJS.ProcessEnv, cpus = availableParallelism()): number {
  const requested = Number(env.PI_E2E_CONCURRENCY);
  if (Number.isInteger(requested) && requested > 0) return requested;
  // Each group runs its own browser plus mock/Vite servers; leave headroom for timing-sensitive specs.
  return Math.max(1, Math.min(4, Math.floor(cpus / 2)));
}

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== "--");
  if (args.some(arg => arg !== "--list")) throw new Error("Supported arguments: --list (discovery only)");
  const listOnly = args.includes("--list");
  const web = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
  const groups = buildGroups(discoverSpecs(testDir));
  const output = mkdtempSync(resolve(tmpdir(), "pi-e2e-"));
  const concurrency = concurrencyFrom(process.env);
  console.log(`E2E results: ${output} (${concurrency} groups at a time)`);
  const children = new Set<ChildProcess>();
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    // Only our Playwright processes: each signal handler cleans its own web servers.
    for (const child of children) child.kill("SIGINT");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const run = async (name: string, discovery: boolean, all = false) => {
    const dir = resolve(output, discovery ? "discovery" : "execution", name);
    mkdirSync(dir, { recursive: true });
    // Groups run side by side: buffer each one's output and print it whole, never interleaved.
    const chunks: Buffer[] = [];
    const started = Date.now();
    const code = await new Promise<number | null>(resolveCode => {
      const child = spawn(process.execPath, [resolve(web, "node_modules/@playwright/test/cli.js"), "test", "--config", "playwright.e2e-group.config.ts", ...(discovery ? ["--list"] : [])], {
        cwd: web, stdio: ["ignore", "pipe", "pipe"], env: { ...groupEnvironment(all ? "general" : name, process.env), PI_E2E_GROUP: all ? "general" : name,
          PI_E2E_GROUP_OUTPUT: dir, PI_E2E_DISCOVERY_ALL: all ? "1" : "" },
      });
      children.add(child);
      child.stdout.on("data", chunk => chunks.push(chunk));
      child.stderr.on("data", chunk => chunks.push(chunk));
      child.once("error", error => { chunks.push(Buffer.from(String(error))); resolveCode(1); });
      child.once("close", code => { children.delete(child); resolveCode(code); });
    });
    const log = Buffer.concat(chunks).toString("utf8");
    writeFileSync(resolve(dir, "output.log"), log);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (code !== 0) console.log(`\n── ${discovery ? "discovery " : ""}${name} failed (exit ${code}, ${seconds}s) ──\n${log}`);
    else if (!discovery) console.log(`✓ ${name} (${seconds}s)`);
    let report: Report | undefined;
    try { report = JSON.parse(readFileSync(resolve(dir, "report.json"), "utf8")) as Report; }
    catch (error) { console.error(`${name}: missing/invalid report`, error); }
    return { code, report };
  };
  let discovered = 0;
  const executions: { name: string; code: number | null; report?: Report }[] = [];
  try {
    // --list starts no servers, so every discovery can run at once.
    const [baseline, ...discoveries] = await Promise.all([run("all", true, true), ...groups.map(group => run(group.name, true))]);
    if (baseline.code !== 0 || !baseline.report || baseline.report.errors?.length || interrupted) throw new Error("Baseline discovery failed/interrupted");
    const expected = new Set(reportTests(baseline.report).map(test => test.id));
    if (expected.size !== reportTests(baseline.report).length) throw new Error("Duplicate baseline discovery");
    discovered = expected.size;
    const seen = new Set<string>();
    const specs = new Set<string>();
    for (const [index, group] of groups.entries()) {
      if (interrupted) throw new Error("Discovery interrupted");
      const result = discoveries[index];
      if (!result) throw new Error(`${group.name}: discovery missing`);
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
      const results = await inPool(groups, concurrency, group => run(group.name, false), () => interrupted);
      for (const [index, group] of groups.entries()) {
        const result = results[index];
        if (!result) continue; // Never started (interrupted): counted as unexecuted.
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
