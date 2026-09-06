import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export interface DrillRunLock {
  readonly file: string;
  readonly pid: number;
  readonly reclaimed: boolean;
}

function mode(value: number): number { return value & 0o7777; }
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function parseOwner(file: string): number {
  const match = readFileSync(file, "utf8").match(/^pid=(\d+)\n$/);
  return match ? Number(match[1]) : 0;
}
function assertSafeLock(file: string): void {
  const st = lstatSync(file);
  const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || mode(st.mode) !== 0o600 || (st.uid !== uid && st.uid !== 0)) {
    throw new Error("drill run lock is unsafe");
  }
}

/** Serialize runs that share one PI_DRILL_ROOT. A dead-PID lock is reclaimed. */
export function acquireDrillRunLock(root: string): DrillRunLock {
  const file = path.join(root, ".pi-agent-server-drill.lock");
  let reclaimed = false;
  for (;;) {
    try {
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        const body = `pid=${process.pid}\n`;
        writeSync(fd, body, 0, "utf8");
        fsyncSync(fd);
      } finally { closeSync(fd); }
      assertSafeLock(file);
      return { file, pid: process.pid, reclaimed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      assertSafeLock(file);
      const owner = parseOwner(file);
      if (processAlive(owner)) throw new Error("another drill run is active");
      unlinkSync(file);
      reclaimed = true;
    }
  }
}

export function releaseDrillRunLock(lock: DrillRunLock): void {
  assertSafeLock(lock.file);
  if (parseOwner(lock.file) !== lock.pid) throw new Error("drill run lock ownership changed");
  unlinkSync(lock.file);
}
