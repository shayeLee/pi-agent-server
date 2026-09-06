import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDrillRunLock, releaseDrillRunLock } from "../../src/drill/drill-run-lock.js";

const roots: string[] = [];
function root(): string { const value = mkdtempSync(path.join(tmpdir(), "pi-drill-lock-")); roots.push(value); chmodSync(value, 0o700); return value; }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe("drill run lock", () => {
  it("rejects a concurrent live owner and releases its own lock", () => {
    const directory = root();
    const lock = acquireDrillRunLock(directory);
    expect(() => acquireDrillRunLock(directory)).toThrow("another drill run is active");
    releaseDrillRunLock(lock);
    expect(existsSync(lock.file)).toBe(false);
  });

  it("reclaims a dead-pid lock", () => {
    const directory = root();
    const file = path.join(directory, ".pi-agent-server-drill.lock");
    writeFileSync(file, "pid=99999999\n", { mode: 0o600 });
    const lock = acquireDrillRunLock(directory);
    expect(lock.reclaimed).toBe(true);
    releaseDrillRunLock(lock);
  });
});
