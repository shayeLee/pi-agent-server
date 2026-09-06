import { describe, expect, it } from "vitest";
import {
  computeFreshnessValue,
  evaluateFreshnessGuard,
  freshnessTextfileContent,
  isWithin,
  parseMachineReport,
  type MachineReport,
} from "../../src/drill/drill-helper.js";

const GOOD_REPORT = 'backup-json-report: {"dialect":"sqlite","status":"published","dryRun":false,"finalPath":"/root/backups/b/backup-1","payloadCount":2,"missingSessionReferences":1}\n';

describe("parseMachineReport", () => {
  it("恰好一行 published 报告 → 解析成功", () => {
    const report = parseMachineReport(GOOD_REPORT);
    expect(report).not.toBeNull();
    expect(report!.status).toBe("published");
    expect(report!.dryRun).toBe(false);
    expect(report!.missingSessionReferences).toBe(1);
  });

  it("0 行（缺失）→ null", () => {
    expect(parseMachineReport("backup created: x\n")).toBeNull();
  });

  it("2 行（重复）→ null", () => {
    const dup = `${GOOD_REPORT}${GOOD_REPORT}`;
    expect(parseMachineReport(dup)).toBeNull();
  });

  it("不可解析 → null", () => {
    expect(parseMachineReport("backup-json-report: {not json}")).toBeNull();
  });

  it("dryRun=true 或非 published → null", () => {
    expect(parseMachineReport('backup-json-report: {"status":"published","dryRun":true,"finalPath":"/x"}')).toBeNull();
    expect(parseMachineReport('backup-json-report: {"status":"failed","dryRun":false,"finalPath":"/x"}')).toBeNull();
  });

  it("finalPath 空 → null", () => {
    expect(parseMachineReport('backup-json-report: {"status":"published","dryRun":false,"finalPath":""}')).toBeNull();
  });
});

describe("evaluateFreshnessGuard", () => {
  const report: MachineReport = { dialect: "sqlite", status: "published", dryRun: false, finalPath: "/root/backups/b/backup-1", payloadCount: 2, missingSessionReferences: 1 };
  const base = { exitCode: 0, report, backupRoot: "/root/backups", finalPath: report.finalPath, completeExists: true, packageOwnerOk: true };

  it("全部满足 → update", () => {
    expect(evaluateFreshnessGuard(base).update).toBe(true);
  });

  it("exit 非零 → skip", () => {
    expect(evaluateFreshnessGuard({ ...base, exitCode: 1 }).update).toBe(false);
  });

  it("report null（缺失/重复/不可解析）→ skip", () => {
    expect(evaluateFreshnessGuard({ ...base, report: null }).update).toBe(false);
  });

  it("finalPath 越出 backupRoot → skip", () => {
    expect(evaluateFreshnessGuard({ ...base, finalPath: "/etc/passwd", report: { ...report, finalPath: "/etc/passwd" } }).update).toBe(false);
  });

  it("COMPLETE 缺失 → skip", () => {
    expect(evaluateFreshnessGuard({ ...base, completeExists: false }).update).toBe(false);
  });

  it("包属主/权限不安全 → skip", () => {
    expect(evaluateFreshnessGuard({ ...base, packageOwnerOk: false }).update).toBe(false);
  });
});

describe("computeFreshnessValue", () => {
  it("首次成功 → 写入 backupStart，advanced=true", () => {
    const result = computeFreshnessValue({ backupStart: 100, priorValue: null, now: 200, maxFutureSkewSec: 300 });
    expect(result.value).toBe(100);
    expect(result.advanced).toBe(true);
  });

  it("时钟回拨（backupStart 远超 now+skew）→ 拒绝且不写", () => {
    const result = computeFreshnessValue({ backupStart: 1000, priorValue: null, now: 200, maxFutureSkewSec: 300 });
    expect(result.value).toBeNull();
    expect(result.reason).toContain("rollback");
  });

  it("迟到 run（backupStart < prior）→ 不倒退", () => {
    const result = computeFreshnessValue({ backupStart: 90, priorValue: 100, now: 200, maxFutureSkewSec: 300 });
    expect(result.value).toBeNull();
    expect(result.reason).toContain("regress");
  });

  it("相同值 → 不前进（advanced=false）", () => {
    const result = computeFreshnessValue({ backupStart: 100, priorValue: 100, now: 200, maxFutureSkewSec: 300 });
    expect(result.value).toBe(100);
    expect(result.advanced).toBe(false);
  });
});

describe("freshnessTextfileContent + isWithin", () => {
  it("textfile 只含数字与固定 label target", () => {
    const content = freshnessTextfileContent(123, "drill-sqlite");
    expect(content).toContain("pi_agent_server_backup_last_success_timestamp_seconds");
    expect(content).toContain('{target="drill-sqlite"} 123');
  });

  it("isWithin：命中与子路径", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a/b/c")).toBe(true);
    expect(isWithin("/a/b", "/a/x")).toBe(false);
    expect(isWithin("/a/b", "/a/b2")).toBe(false);
  });
});
