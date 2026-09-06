import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adjudicateDrill,
  buildDrillEvidence,
  cleanupRunDirectories,
  collectRedactables,
  defaultDrillPlan,
  preflightDrill,
  redactText,
  resolveDrillRoot,
  sanitizeDrillEvidence,
  validateDrillResources,
  validateDrillRoot,
  validateDrillSecrets,
  type DrillObservation,
  type DrillPlan,
} from "../../src/drill/drill-core.js";

/** 构造仅含 PI_DRILL_ROOT 的 drill env。 */
function drillEnv(root: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { PI_DRILL_ROOT: root, ...extra };
}

const cleanups: string[] = [];
afterEach(() => {
  for (const target of cleanups.splice(0)) {
    try { chmodSync(target, 0o700); } catch { /* may already be removed */ }
    rmSync(target, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const base = mkdtempSync(path.join(tmpdir(), "pi-drill-test-"));
  const root = path.join(base, "root");
  mkdirSync(path.join(root, "secrets"), { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  cleanups.push(base);
  return root;
}

function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function seedSecrets(root: string): void {
  writePrivate(path.join(root, "secrets", "age-identity.txt"), "AGE-SECRET-KEY-1TEST");
  writePrivate(path.join(root, "secrets", "age-recipient.txt"), "age1testrecipient\n");
}

describe("preflight: 环境缺失", () => {
  it("PI_DRILL_ROOT 未设置 → FAIL（drill_root_set=false）", () => {
    const verdict = preflightDrill({});
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.checks.find((c) => c.name === "drill_root_set")?.ok).toBe(false);
  });

  it("PI_DRILL_ROOT 相对路径 → FAIL，且不回显该路径", () => {
    const verdict = preflightDrill({ PI_DRILL_ROOT: "relative/root" });
    expect(verdict.outcome).toBe("FAIL");
    const redacted = JSON.stringify(verdict);
    expect(redacted).not.toContain("relative/root");
  });
});

describe("preflight: 路径重叠（fail-closed 双向）", () => {
  it("正式 DATA_DIR 位于根内 → FAIL（drill_overlap=false）", () => {
    const root = makeRoot();
    seedSecrets(root);
    const verdict = preflightDrill(drillEnv(root, { DATA_DIR: path.join(root, "data") }));
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.checks.find((c) => c.name === "drill_overlap")?.ok).toBe(false);
  });

  it("根位于正式 DATA_DIR 内 → FAIL", () => {
    const root = makeRoot();
    seedSecrets(root);
    const verdict = preflightDrill(drillEnv(root, { DATA_DIR: path.dirname(root) }));
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.checks.find((c) => c.name === "drill_overlap")?.ok).toBe(false);
  });

  it("正式路径与根互不重叠 → overlap 通过", () => {
    const root = makeRoot();
    seedSecrets(root);
    const formal = path.join(path.dirname(root), "formal-store");
    const verdict = preflightDrill(drillEnv(root, { DATA_DIR: formal, PI_AUTH_PATH: path.join(formal, "auth.json") }));
    expect(verdict.outcome).toBe("PASS");
    expect(verdict.checks.find((c) => c.name === "drill_overlap")?.ok).toBe(true);
  });

  it("服务默认解析：PI_AGENT_DIR 与演练根重叠 → FAIL（fail-closed）", () => {
    const root = makeRoot();
    seedSecrets(root);
    const verdict = preflightDrill(drillEnv(root, { PI_AGENT_DIR: path.join(root, "agent") }));
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.checks.find((c) => c.name === "drill_overlap")?.ok).toBe(false);
  });

  it("显式 PI_FORMAL_BACKUP_ROOT 与根重叠 → FAIL；根/secrets 安全时通过", () => {
    const root = makeRoot();
    seedSecrets(root);
    const formal = path.join(path.dirname(root), "formal-backup-root");
    const verdict = preflightDrill(drillEnv(root, { PI_FORMAL_BACKUP_ROOT: formal }));
    expect(verdict.outcome).toBe("PASS");
    expect(verdict.checks.find((c) => c.name === "drill_overlap")?.ok).toBe(true);
    const overlap = preflightDrill(drillEnv(root, { PI_FORMAL_BACKUP_ROOT: root }));
    expect(overlap.outcome).toBe("FAIL");
    expect(overlap.checks.find((c) => c.name === "drill_overlap")?.ok).toBe(false);
  });

  it("正式 postgres DB 与演练 postgres DB 指向同一目标 → FAIL（fail-closed）", () => {
    const root = makeRoot();
    seedSecrets(root);
    const verdict = preflightDrill(drillEnv(root, {
      PI_DRILL_DIALECT: "postgres",
      PI_DRILL_DATABASE_URL: "postgres://u:p@srv:5432/drill",
      PI_DATABASE_URL: "postgres://u:p@srv:5432/drill",
    }));
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.checks.find((c) => c.name === "drill_overlap")?.ok).toBe(false);
  });
});

describe("preflight: symlink / 权限", () => {
  it("根是 symlink → FAIL（drill_root_private=false）", () => {
    const base = mkdtempSync(path.join(tmpdir(), "pi-drill-test-"));
    const real = path.join(base, "real-root");
    const link = path.join(base, "link-root");
    mkdirSync(path.join(real, "secrets"), { recursive: true, mode: 0o700 });
    chmodSync(real, 0o700);
    symlinkSync(real, link);
    cleanups.push(base);
    const verdict = preflightDrill({ PI_DRILL_ROOT: link });
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.checks.find((c) => c.name === "drill_root_private")?.ok).toBe(false);
  });

  it("根非 0700（group/other bits）→ FAIL", () => {
    const root = makeRoot();
    seedSecrets(root);
    chmodSync(root, 0o755);
    const verdict = preflightDrill({ PI_DRILL_ROOT: root });
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.checks.find((c) => c.name === "drill_root_private")?.ok).toBe(false);
  });

  it("根带 special bits（sticky bit，精确 0700）→ FAIL", () => {
    const root = makeRoot();
    seedSecrets(root);
    chmodSync(root, 0o1700);
    const verdict = preflightDrill({ PI_DRILL_ROOT: root });
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.checks.find((c) => c.name === "drill_root_private")?.ok).toBe(false);
  });

  it("根 0700 且带 group/other 权限 → FAIL", () => {
    const root = makeRoot();
    seedSecrets(root);
    chmodSync(root, 0o1770);
    const verdict = preflightDrill({ PI_DRILL_ROOT: root });
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.checks.find((c) => c.name === "drill_root_private")?.ok).toBe(false);
  });

  it("根 0700 且当前用户属主、非 symlink → 通过", () => {
    const root = makeRoot();
    seedSecrets(root);
    const info = validateDrillRoot(root);
    expect(info.canonical).toBeTruthy();
    expect(preflightDrill({ PI_DRILL_ROOT: root }).outcome).toBe("PASS");
  });

  it("secrets 非 0600 → FAIL（drill_secrets=false）", () => {
    const root = makeRoot();
    seedSecrets(root);
    writeFileSync(path.join(root, "secrets", "age-recipient.txt"), "age1testrecipient\n", { mode: 0o644 });
    chmodSync(path.join(root, "secrets", "age-recipient.txt"), 0o644);
    const verdict = preflightDrill({ PI_DRILL_ROOT: root });
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.checks.find((c) => c.name === "drill_secrets")?.ok).toBe(false);
  });

  it("secrets 带 special bits（sticky bit，精确 0600）→ FAIL", () => {
    const root = makeRoot();
    seedSecrets(root);
    chmodSync(path.join(root, "secrets", "age-identity.txt"), 0o1600);
    const verdict = preflightDrill({ PI_DRILL_ROOT: root });
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.checks.find((c) => c.name === "drill_secrets")?.ok).toBe(false);
  });

  it("secrets 是 symlink → FAIL", () => {
    const root = makeRoot();
    seedSecrets(root);
    const linkFile = path.join(root, "secrets", "age-recipient.txt");
    const target = path.join(root, "secrets", "recipient-target.txt");
    writePrivate(target, "age1testrecipient\n");
    rmSync(linkFile);
    symlinkSync(target, linkFile);
    // secureDrillPath 在遍历时即拒绝最终组件为 symlink（消息用 ancestor 措辞）。
    expect(() => validateDrillSecrets(root)).toThrow(/age recipient .*symbolic-link/);
  });

  it("secrets 是 hardlink → FAIL", () => {
    const root = makeRoot();
    seedSecrets(root);
    const original = path.join(root, "secrets", "age-identity.txt");
    const extra = path.join(root, "secrets", "age-identity-copy.txt");
    // hardlink 到同一 inode；nlink>1 即拒绝。
    linkSync(original, extra);
    expect(() => validateDrillSecrets(root)).toThrow(/age identity .*hardlink/);
  });
});

describe("cleanup: 固定保留 secrets、只清空运行子目录", () => {
  it("清空 runs/* 与临时目录，保留根与 secrets 内容不变", () => {
    const root = makeRoot();
    seedSecrets(root);
    const identityBefore = readFileSync(path.join(root, "secrets", "age-identity.txt"), "utf8");
    mkdirSync(path.join(root, "runs", "run-1"), { recursive: true, mode: 0o700 });
    writePrivate(path.join(root, "runs", "run-1", "evidence.json"), "{}");
    mkdirSync(path.join(root, "evidence"), { recursive: true, mode: 0o700 });
    writePrivate(path.join(root, "evidence", "run.log"), "x");
    mkdirSync(path.join(root, "backups"), { recursive: true, mode: 0o700 });

    const result = cleanupRunDirectories(drillEnv(root));
    expect(result.preservedSecrets).toBe(true);
    expect(result.removedRuns).toBe(1);
    expect(result.cleared).toContain("runs");
    expect(result.cleared).toContain("evidence");

    expect(existsSync(path.join(root, "runs", "run-1"))).toBe(false);
    expect(existsSync(path.join(root, "evidence"))).toBe(true); // 重建为空目录
    expect(existsSync(path.join(root, "backups"))).toBe(true);
    const identityAfter = readFileSync(path.join(root, "secrets", "age-identity.txt"), "utf8");
    expect(identityAfter).toBe(identityBefore);
    // 根与 secrets 仍存在且可校验。
    expect(() => validateDrillSecrets(root)).not.toThrow();
  });

  it("任意已知工作目录为 symlink → fail-closed，不删除", () => {
    const root = makeRoot();
    seedSecrets(root);
    const target = path.join(path.dirname(root), "outside");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    cleanups.push(path.dirname(root));
    const evidence = path.join(root, "evidence");
    mkdirSync(evidence, { recursive: true, mode: 0o700 });
    rmSync(evidence, { recursive: true, force: true });
    symlinkSync(target, evidence);
    expect(() => cleanupRunDirectories(drillEnv(root))).toThrow(/cleanup target is a symbolic link/);
    expect(existsSync(path.join(root, "secrets", "age-identity.txt"))).toBe(true);
  });

  it("正式 0700 备份根/演练根含 backups → cleanup 拒绝（preflight overlap fail）", () => {
    const root = makeRoot();
    seedSecrets(root);
    // 演练根本身即 0700，内含 backups（模拟正式备份根被复用为演练根）。
    mkdirSync(path.join(root, "backups"), { recursive: true, mode: 0o700 });
    writePrivate(path.join(root, "backups", "CORP-BACKUP.age"), "x");
    const env = drillEnv(root, { PI_FORMAL_BACKUP_ROOT: root });
    expect(preflightDrill(env).outcome).toBe("FAIL");
    expect(() => cleanupRunDirectories(env)).toThrow(/cleanup refused: preflight not passed/);
    expect(existsSync(path.join(root, "backups", "CORP-BACKUP.age"))).toBe(true);
  });

  it("cleanup 前两个 secrets 必须有效存在：缺 recipient → 拒绝删除", () => {
    const root = makeRoot();
    seedSecrets(root);
    rmSync(path.join(root, "secrets", "age-recipient.txt"));
    mkdirSync(path.join(root, "evidence"), { recursive: true, mode: 0o700 });
    writePrivate(path.join(root, "evidence", "run.log"), "x");
    expect(preflightDrill(drillEnv(root)).outcome).toBe("FAIL");
    expect(() => cleanupRunDirectories(drillEnv(root))).toThrow(/cleanup refused: preflight not passed/);
    expect(existsSync(path.join(root, "evidence", "run.log"))).toBe(true);
  });

  it("cleanup 目录带 special bits（sticky bit）→ fail-closed，不删除", () => {
    const root = makeRoot();
    seedSecrets(root);
    const evidence = path.join(root, "evidence");
    mkdirSync(evidence, { recursive: true, mode: 0o700 });
    writePrivate(path.join(evidence, "run.log"), "x");
    chmodSync(evidence, 0o1700);
    expect(() => cleanupRunDirectories(drillEnv(root))).toThrow(/cleanup target is not exactly 0700/);
    expect(existsSync(path.join(evidence, "run.log"))).toBe(true);
  });
});

describe("判定引擎 adjudicateDrill：PASS/FAIL/DEFERRED", () => {
  function allPass(plan: DrillPlan): DrillObservation[] {
    return plan.steps.map((spec) => ({ stepId: spec.id, passed: true, detail: "ok", durationMs: 1 }));
  }
  function step(stepId: string, passed: boolean): DrillObservation {
    return { stepId, passed, detail: passed ? "ok" : "fail", durationMs: 1 };
  }

  it("计划含先决条件 + 成功路径 + 全部故障场景", () => {
    const plan = defaultDrillPlan();
    expect(plan.faultScenarios.length).toBeGreaterThanOrEqual(12);
    expect(plan.steps.map((s) => s.kind)).toContain("prerequisite");
    expect(plan.steps.map((s) => s.kind)).toContain("mandatory");
    expect(plan.steps.map((s) => s.kind)).toContain("fault-guard");
    expect(plan.steps.map((s) => s.kind)).toContain("fault-recovery");
  });

  it("全部观测通过 → PASS；环境变量 PI_DRILL_VERIFIED 不参与判定", () => {
    const plan = defaultDrillPlan();
    const verdict = adjudicateDrill(allPass(plan), plan);
    expect(verdict.outcome).toBe("PASS");
    expect(verdict.passedCount).toBe(plan.steps.length);
  });

  it("先决条件(provision)未过 → DEFERRED", () => {
    const plan = defaultDrillPlan();
    const observations = plan.steps.map((s) => (s.id === "provision" ? step("provision", false) : { stepId: s.id, passed: true, detail: "ok", durationMs: 1 }));
    const verdict = adjudicateDrill(observations, plan);
    expect(verdict.outcome).toBe("DEFERRED");
    expect(verdict.deferredBy).toContain("provision");
  });

  it("成功路径某一步未过 → FAIL（强制项）", () => {
    const plan = defaultDrillPlan();
    const observations = plan.steps.map((s) => (s.id === "monitor-normal" ? step("monitor-normal", false) : { stepId: s.id, passed: true, detail: "ok", durationMs: 1 }));
    const verdict = adjudicateDrill(observations, plan);
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.mandatoryFailures.map((o) => o.stepId)).toContain("monitor-normal");
  });

  it("任一故障场景 guard 或 recovery 未过 → FAIL", () => {
    const plan = defaultDrillPlan();
    const scenarios = plan.faultScenarios;
    const chosen = scenarios[0]!;
    const observations = plan.steps.map((s) =>
      s.id === chosen.guardStep ? step(s.id, false)
        : s.id === chosen.recoveryStep ? step(s.id, true)
          : { stepId: s.id, passed: true, detail: "ok", durationMs: 1 },
    );
    const verdict = adjudicateDrill(observations, plan);
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.faultFailures.some((f) => f.fault === chosen.fault)).toBe(true);
  });

  it("先决条件通过但其余 mandatory 未运行 → 视为失败（step did not run）", () => {
    const plan = defaultDrillPlan();
    const verdict = adjudicateDrill([step("provision", true), step("fixture-sqlite", true)], plan);
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.mandatoryFailures.length).toBeGreaterThan(0);
  });
});

describe("证据构建与脱敏", () => {
  it("buildDrillEvidence 仅含布尔/枚举/计数/时长/version，不含路径/secret/正文", () => {
    const plan = defaultDrillPlan();
    const observations = plan.steps.map((s) => ({ stepId: s.id, passed: true, detail: "ok", durationMs: 7 }));
    const adjudication = adjudicateDrill(observations, plan);
    const evidence = buildDrillEvidence(adjudication, plan, observations, { node: "v24.19.0", podman: "v6.1.0" }, "2026-01-01T00:00:00Z");
    expect(evidence.op).toBe("backup-freshness-drill");
    expect(evidence.outcome).toBe("PASS");
    expect(evidence.stepCount).toBe(plan.steps.length);
    expect(evidence.dialectCount).toBe(2);
    expect(evidence.faults.length).toBe(plan.faultScenarios.length);
    const json = JSON.stringify(evidence);
    expect(json).not.toContain("/Users");
  });

  it("sanitizeDrillEvidence 抹掉绝对路径与已知 secret", () => {
    const plan = defaultDrillPlan();
    const observations = plan.steps.map((s) => ({ stepId: s.id, passed: true, detail: "ok", durationMs: 1 }));
    const adjudication = adjudicateDrill(observations, plan);
    let root = "";
    const redactables = collectRedactables({ PI_DRILL_ROOT: "/tmp/secret-root", PI_DRILL_DATABASE_URL: "postgres://u:p@h:5432/db" });
    root = "";
    void root;
    const evidence = buildDrillEvidence(adjudication, plan, observations, {}, "2026-01-01T00:00:00Z");
    const safe = sanitizeDrillEvidence(evidence, { PI_DRILL_ROOT: "/tmp/secret-root" }, redactables);
    expect(safe).not.toContain("secret-root");
    expect(safe).not.toContain("postgres://");
  });
});

describe("validateDrillResources: 拒绝不安全/空/相对配置", () => {
  it("dialect=postgres 缺 URL → 拒绝", () => {
    const root = makeRoot();
    expect(() => validateDrillResources(root, { PI_DRILL_DIALECT: "postgres" })).toThrow(/requires PI_DRILL_DATABASE_URL/);
  });

  it("dialect 非法 → 拒绝", () => {
    const root = makeRoot();
    expect(() => validateDrillResources(root, { PI_DRILL_DIALECT: "mysql" })).toThrow(/must be sqlite or postgres/);
  });

  it("textfile 目录相对或不位于根内 → 拒绝", () => {
    const root = makeRoot();
    expect(() => validateDrillResources(root, { PI_DRILL_TEXTFILE_DIR: "relative/textfile" })).toThrow(/must be absolute/);
    expect(() => validateDrillResources(root, { PI_DRILL_TEXTFILE_DIR: path.join(path.dirname(root), "outside") })).toThrow(/must live inside the drill root/);
  });

  it("监测配置相对 → 拒绝", () => {
    const root = makeRoot();
    expect(() => validateDrillResources(root, { PI_DRILL_MONITORING_CONFIG: "monitoring.yml" })).toThrow(/must be absolute/);
  });

  it("receiver/review 引用必须是安全 token（拒绝 URL/路径）", () => {
    const root = makeRoot();
    expect(() => validateDrillResources(root, { PI_DRILL_RECEIVER_REFERENCE: "https://alertmanager:9093" })).toThrow(/opaque reference token/);
    expect(() => validateDrillResources(root, { PI_DRILL_REVIEW_REFERENCE: "/etc/passwd" })).toThrow(/opaque reference token/);
    expect(() => validateDrillResources(root, { PI_DRILL_RECEIVER_REFERENCE: "drill-receiver-01/A" })).toThrow(/opaque reference token/);
  });

  it("合规配置通过", () => {
    const root = makeRoot();
    const textfile = path.join(root, "textfile");
    const cfg = validateDrillResources(root, {
      PI_DRILL_DIALECT: "sqlite",
      PI_DRILL_TEXTFILE_DIR: textfile,
      PI_DRILL_RECEIVER_REFERENCE: "drill-receiver-01",
      PI_DRILL_REVIEW_REFERENCE: "auth-2024",
    });
    expect(cfg.dialect).toBe("sqlite");
    expect(cfg.textfileDir).toBe(textfile);
  });
});

describe("输出脱敏", () => {
  it("替换已知 secret/数据库 URL", () => {
    const secret = "postgres://user:supersecret@db.example:5432/prod";
    const out = redactText(`failed while connecting to ${secret}`, [secret]);
    expect(out).not.toContain("supersecret");
    expect(out).not.toContain("db.example");
    expect(out).toContain("[redacted]");
  });

  it("抹掉绝对路径片段（即使不在显式列表中）", () => {
    const out = redactText("write to /Users/mz/foo/bar failed", []);
    expect(out).not.toContain("/Users/mz/foo/bar");
    expect(out).toContain("[redacted]");
  });

  it("collectRedactables 收集 secret 与根路径", () => {
    const root = makeRoot();
    const redactables = collectRedactables({ PI_DRILL_ROOT: root, PI_DRILL_DATABASE_URL: "postgres://u:p@h:5432/db" });
    expect(redactables).toContain(root);
  });
});
