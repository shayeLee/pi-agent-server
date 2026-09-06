import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkDistHygiene } from "./dist-hygiene.mjs";

// 发布产物卫生：dist-drill 树中不允许任何 symlink 或已移除模块残留。
checkDistHygiene("dist-drill");

const core = await import(pathToFileURL(path.resolve("dist-drill/src/drill/drill-core.js")));
const exec = await import(pathToFileURL(path.resolve("dist-drill/src/drill/drill-exec.js")));
const cli = path.resolve("dist-drill/scripts/drill.js");

function run(command, args, options = {}) {
  return spawnSync(command, args, { ...options, stdio: "pipe", encoding: "utf8" });
}

function writePrivate(file, content) {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const directory = mkdtempSync(path.join(tmpdir(), "pi-drill-build-smoke-"));
let drillRoot = "";
try {
  // 演练根：当前用户 0700、非 symlink；secrets 固定保留两个 0600 普通文件。
  drillRoot = path.join(directory, "drill-root");
  mkdirSync(path.join(drillRoot, "secrets"), { recursive: true, mode: 0o700 });
  chmodSync(drillRoot, 0o700);
  writePrivate(path.join(drillRoot, "secrets", "age-identity.txt"), "AGE-SECRET-KEY-1SMOKE");
  writePrivate(path.join(drillRoot, "secrets", "age-recipient.txt"), "age1smokepublicrecipient\n");
  mkdirSync(path.join(drillRoot, "runs", "run-1"), { recursive: true, mode: 0o700 });
  writePrivate(path.join(drillRoot, "runs", "run-1", "evidence.json"), "{}");

  // 编排/判定/证据（fixture adapter，不依赖 podman）。
  const plan = core.defaultDrillPlan();
  const allOk = plan.steps.map((s) => ({ stepId: s.id, passed: true, detail: "ok", durationMs: 1 }));
  const verdict = core.adjudicateDrill(allOk, plan);
  if (verdict.outcome !== "PASS") throw new Error(`compiled adjudicate expected PASS, got ${verdict.outcome}`);

  const failVerdict = core.adjudicateDrill(
    plan.steps.map((s) => (s.id === "monitor-normal" ? { stepId: s.id, passed: false, detail: "fail", durationMs: 1 } : { stepId: s.id, passed: true, detail: "ok", durationMs: 1 })),
    plan,
  );
  if (failVerdict.outcome !== "FAIL") throw new Error("compiled adjudicate expected FAIL for mandatory failure");

  const fixtureExecutor = {
    name: "fixture",
    versions: { node: "v24.19.0" },
    async step(stepId) { return { stepId, passed: true, detail: "ok", durationMs: 1 }; },
    async cleanup() {},
  };
  const result = await exec.runDrill(fixtureExecutor, { PI_DRILL_ROOT: drillRoot }, plan);
  if (result.adjudication.outcome !== "PASS") throw new Error("compiled runDrill(fixture) expected PASS");

  // 证据脱敏：任何运行输出不得含根/secret/绝对路径。
  const redacted = core.sanitizeDrillEvidence(result.evidence, { PI_DRILL_ROOT: drillRoot, PI_DRILL_DATABASE_URL: "postgres://user:secret@db.example:5432/prod" });
  for (const needle of [drillRoot, "AGE-SECRET-KEY-", "postgres://", "/Users"]) {
    if (redacted.includes(needle)) throw new Error(`compiled evidence leaked '${needle}'`);
  }

  // CLI run：无 PI_DRILL_ROOT → preflight FAIL（exit 2），不起 podman。
  const noRootEnv = { ...process.env };
  delete noRootEnv.PI_DRILL_ROOT;
  const noRoot = run("node", [cli, "run"], { env: noRootEnv });
  if (noRoot.status !== 2) throw new Error(`compiled run without PI_DRILL_ROOT expected exit 2, got ${noRoot.status}`);

  // CLI preflight：有 root → exit 0。
  const preflightCli = run("node", [cli, "preflight"], { env: { ...process.env, PI_DRILL_ROOT: drillRoot } });
  if (preflightCli.status !== 0) throw new Error(`compiled preflight expected exit 0, got ${preflightCli.status}`);

  // CLI cleanup：清空运行子目录、保留 secrets。
  const cleanupCli = run("node", [cli, "cleanup"], { env: { ...process.env, PI_DRILL_ROOT: drillRoot } });
  if (cleanupCli.status !== 0) throw new Error(`compiled cleanup expected exit 0, got ${cleanupCli.status}`);
  if (existsSync(path.join(drillRoot, "runs", "run-1"))) throw new Error("compiled cleanup did not remove the run directory");
  if (!existsSync(path.join(drillRoot, "secrets", "age-identity.txt"))) throw new Error("compiled cleanup removed the age identity");

  console.log("compiled drill adjudication/evidence/redaction + preflight/cleanup smoke: ok");
} finally {
  if (drillRoot) rmSync(directory, { recursive: true, force: true });
}
