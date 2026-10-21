import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildGroups, discoverSpecs, groupEnvironment, isGeneral, type E2EGroup } from "../web/e2e-groups.js";

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

export interface E2EArgs { listOnly: boolean; maxFailures?: number; groups?: string[]; specs?: string[] }
/**
 * `--list` only discovers. `--max-failures=N` stops early once N tests failed: each group's Playwright
 * stops at N, and no new group starts after N failures in total; the tests that never ran count as
 * unexecuted, so a stopped run always fails. `--group=a,b` runs only those groups (`general` = every general shard) and `--spec=a,b` only
 * those spec files (`.spec.ts` optional), each in its own group; discovery always covers every group.
 */
export function parseArgs(argv: readonly string[]): E2EArgs {
  const args: E2EArgs = { listOnly: false };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--list") { args.listOnly = true; continue; }
    const match = /^--max-failures=(\d+)$/.exec(arg);
    if (match && Number(match[1]) > 0) { args.maxFailures = Number(match[1]); continue; }
    const filter = /^--(group|spec)=(.+)$/.exec(arg);
    const names = filter?.[2]!.split(",").map(name => name.trim()).filter(Boolean) ?? [];
    if (filter && names.length) {
      const key = filter[1] === "group" ? "groups" : "specs";
      const values = filter[1] === "spec" ? names.map(name => name.endsWith(".spec.ts") ? name : `${name}.spec.ts`) : names;
      args[key] = [...new Set([...(args[key] ?? []), ...values])];
      continue;
    }
    throw new Error("Supported arguments: --list (discovery only), --max-failures=N (stop after N failed tests), --group=a,b (only these groups), --spec=a,b (only these spec files)");
  }
  return args;
}

/** A group to execute; `specs` narrows it to those files, otherwise the whole group runs. */
export interface E2ERun { group: E2EGroup; specs?: string[] }
/** Groups to execute, in group order. A group named by --group runs whole even if --spec also names one of its files. */
export function selectRuns(groups: readonly E2EGroup[], filter: Pick<E2EArgs, "groups" | "specs">): E2ERun[] {
  if (!filter.groups && !filter.specs) return groups.map(group => ({ group }));
  // "general" names every general shard.
  const named = (group: E2EGroup) => filter.groups?.some(name => name === group.name || (name === "general" && isGeneral(group.name)));
  for (const name of filter.groups ?? []) {
    if (name !== "general" && !groups.some(group => group.name === name)) throw new Error(`Unknown E2E group: ${name}. Groups: ${groups.map(group => group.name).join(", ")}`);
  }
  for (const spec of filter.specs ?? []) {
    if (!groups.some(group => group.specs.includes(spec))) throw new Error(`${spec} is not in any E2E group (pnpm run e2e -- --list shows each group's specs)`);
  }
  return groups.flatMap(group => {
    if (named(group)) return [{ group }];
    const specs = group.specs.filter(spec => filter.specs?.includes(spec));
    return specs.length ? [{ group, specs }] : [];
  });
}

/** Tests a group's report counts as failed. */
export function failedTests(report: Report | undefined): number {
  return report ? reportTests(report).filter(({ test }) => test.status === "unexpected").length : 0;
}

/**
 * Runs in the order to start them: longest first by the last recorded whole-group durations (seconds),
 * groups never timed before go first; ties keep group order. Starting the long groups early keeps one
 * from being left running alone at the end.
 */
export function longestFirst(runs: readonly E2ERun[], durations: Readonly<Record<string, number>>): E2ERun[] {
  const duration = (run: E2ERun) => durations[run.group.name] ?? Infinity;
  return runs.map((run, index) => ({ run, index }))
    .sort((a, b) => duration(b.run) - duration(a.run) || a.index - b.index)
    .map(({ run }) => run);
}

export function concurrencyFrom(env: NodeJS.ProcessEnv, cpus = availableParallelism()): number {
  const requested = Number(env.PI_E2E_CONCURRENCY);
  if (Number.isInteger(requested) && requested > 0) return requested;
  // Each group runs its own browser plus mock/Vite servers; leave headroom for timing-sensitive specs
  // (at 8, ui-foundation focus checks failed on a 14-core machine; 6 stayed green).
  return Math.max(1, Math.min(6, Math.floor(cpus / 2)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { listOnly, maxFailures } = args;
  let failures = 0;
  const tooManyFailures = () => maxFailures !== undefined && failures >= maxFailures;
  const web = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
  const groups = buildGroups(discoverSpecs(testDir));
  // Per machine, so it lives with the other local caches; a missing or broken file only loses the ordering.
  const durationsFile = resolve(web, "node_modules/.cache/pi-e2e-durations.json");
  let durations: Record<string, number> = {};
  try { durations = JSON.parse(readFileSync(durationsFile, "utf8")) as Record<string, number>; } catch { /* first run */ }
  const runs = longestFirst(selectRuns(groups, args), durations);
  const partial = !!(args.groups || args.specs);
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
  const run = async (name: string, discovery: boolean, all = false, specs?: string[]) => {
    const dir = resolve(output, discovery ? "discovery" : "execution", name);
    mkdirSync(dir, { recursive: true });
    // Groups run side by side: buffer each one's output and print it whole, never interleaved.
    const chunks: Buffer[] = [];
    const started = Date.now();
    const code = await new Promise<number | null>(resolveCode => {
      const child = spawn(process.execPath, [resolve(web, "node_modules/@playwright/test/cli.js"), "test", "--config", "playwright.e2e-group.config.ts", ...(discovery ? ["--list"] : maxFailures ? [`--max-failures=${maxFailures}`] : [])], {
        cwd: web, stdio: ["ignore", "pipe", "pipe"], env: { ...groupEnvironment(all ? "general-1" : name, process.env), PI_E2E_GROUP: all ? "general-1" : name,
          PI_E2E_GROUP_OUTPUT: dir, PI_E2E_DISCOVERY_ALL: all ? "1" : "", PI_E2E_SPECS: specs?.join(",") ?? "" },
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
    if (!discovery) failures += failedTests(report);
    return { code, report, seconds: Number(seconds) };
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
      // The tests each run must execute: its group's discovery, narrowed to its --spec files.
      const expectedIds = runs.map(({ group, specs }) => {
        const report = JSON.parse(readFileSync(resolve(output, "discovery", group.name, "report.json"), "utf8")) as Report;
        return new Set(reportTests(report).filter(test => !specs || specs.includes(test.file)).map(test => test.id));
      });
      if (partial) {
        discovered = expectedIds.reduce((sum, ids) => sum + ids.size, 0);
        console.log(`Partial run: ${runs.length} of ${groups.length} groups, ${discovered} of ${seen.size} tests (${runs.map(({ group, specs }) => specs ? `${group.name}: ${specs.join(", ")}` : group.name).join("; ")})`);
      }
      const results = await inPool(runs, concurrency, ({ group, specs }) => run(group.name, false, false, specs), () => interrupted || tooManyFailures());
      if (tooManyFailures()) console.log(`Stopped after ${failures} failed tests (--max-failures=${maxFailures}); groups not started count as unexecuted`);
      // Only whole groups that ran to the end say how long the group takes.
      for (const [index, { group, specs }] of runs.entries()) if (results[index] && !specs && !interrupted && !tooManyFailures()) durations[group.name] = results[index]!.seconds;
      try { mkdirSync(dirname(durationsFile), { recursive: true }); writeFileSync(durationsFile, JSON.stringify(durations, null, 2)); }
      catch (error) { console.error("Could not record group durations", error); }
      for (const [index, { group }] of runs.entries()) {
        const result = results[index];
        if (!result) continue; // Never started (interrupted): counted as unexecuted.
        // Invalid/incomplete reports must not turn missing tests into a successful run.
        if (result.report) {
          const actual = reportTests(result.report).map(test => test.id);
          const ids = expectedIds[index]!;
          if (actual.length !== ids.size || new Set(actual).size !== ids.size || actual.some(id => !ids.has(id))) result.code = 1;
        }
        executions.push({ name: group.name, ...result });
      }
    }
    if (listOnly) { process.exitCode = interrupted ? 1 : 0; return; }
    const totals = aggregate(discovered, executions, interrupted);
    writeFileSync(resolve(output, "summary.json"), JSON.stringify({ ...totals, interrupted, ...(partial ? { filter: { groups: args.groups, specs: args.specs } } : {}), groups: executions.map(({ name, code, report }) => ({ name, code, reportPresent: !!report })) }, null, 2));
    console.log(`${partial ? "Partial total" : "Total"}: ${totals.passed} passed / ${totals.failed} failed / ${totals.skipped} skipped / ${totals.unexecuted} unexecuted`);
    process.exitCode = totals.exitCode;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
