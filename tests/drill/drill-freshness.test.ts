import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateFreshness, type FreshnessUpdateRequest } from "../../src/drill/drill-freshness.js";
import { sanitizeContainerEnv } from "../../src/drill/drill-scheduler.js";

const roots: string[] = [];
function fixture(): FreshnessUpdateRequest {
  const root = mkdtempSync(path.join(tmpdir(), "pi-drill-freshness-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const backupRoot = path.join(root, "backups");
  const finalPath = path.join(backupRoot, "backup-one");
  const textfileDir = path.join(root, "textfile");
  mkdirSync(finalPath, { recursive: true, mode: 0o700 });
  mkdirSync(textfileDir, { mode: 0o700 });
  writeFileSync(path.join(finalPath, "COMPLETE"), "ok\n", { mode: 0o600 });
  const report = { dialect: "sqlite", status: "published", dryRun: false, finalPath, payloadCount: 1, missingSessionReferences: 1 };
  return { textfileDir, targetId: "target-one", backupRoot, exitCode: 0, reportText: `backup-json-report: ${JSON.stringify(report)}\n`, backupStartSec: 100, nowSec: 100 };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("drill freshness writer", () => {
  it("validates the real package and atomically publishes a metric", () => {
    const request = fixture();
    expect(updateFreshness(request)).toMatchObject({ ok: true, updated: true });
    expect(readFileSync(path.join(request.textfileDir, "target-one.prom"), "utf8")).toContain(" 100\n");
  });

  it("rejects malformed reports and unsafe package ownership", () => {
    const request = fixture();
    expect(updateFreshness({ ...request, reportText: "broken" }).ok).toBe(false);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    expect(updateFreshness({ ...request, requiredPackageOwnerUid: uid === 0 ? 1 : 0 }).ok).toBe(false);
  });

  it("rejects symlink metrics and unsafe directory permissions", () => {
    const request = fixture();
    expect(updateFreshness(request).ok).toBe(true);
    const metric = path.join(request.textfileDir, "target-one.prom");
    const original = path.join(request.textfileDir, "original.prom");
    rmSync(metric);
    writeFileSync(original, "safe\n", { mode: 0o600 });
    symlinkSync(original, metric);
    expect(updateFreshness({ ...request, backupStartSec: 101, nowSec: 101 }).ok).toBe(false);
    rmSync(metric);
    chmodSync(request.textfileDir, 0o777);
    expect(updateFreshness({ ...request, backupStartSec: 101, nowSec: 101 }).ok).toBe(false);
  });

  it("serializes only the scheduler allowlist", () => {
    const entries = Object.fromEntries(sanitizeContainerEnv({ DATA_DIR: "/drill/data", PI_DATABASE_URL: "drill-url", AWS_SECRET_ACCESS_KEY: "secret", PI_MODEL_API_KEY: "secret" }));
    expect(entries).toEqual({ DATA_DIR: "/drill/data", PI_DATABASE_URL: "drill-url" });
  });
});
