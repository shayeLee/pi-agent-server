import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { kill } from "node:process";
import path from "node:path";
import {
  computeFreshnessValue,
  evaluateFreshnessGuard,
  freshnessTextfileContent,
  isWithin,
  parseMachineReport,
  type MachineReport,
} from "./drill-helper.js";

export type FreshnessCrashHook = "before-rename" | "after-rename";

export interface FreshnessUpdateRequest {
  readonly textfileDir: string;
  readonly targetId: string;
  readonly backupRoot: string;
  readonly exitCode: number;
  /** Prefer reportText so parsing happens in this helper process, not in the caller. */
  readonly reportText?: string;
  readonly report?: MachineReport | null;
  readonly backupStartSec: number;
  readonly nowSec?: number;
  readonly maxFutureSkewSec?: number;
  /** Test/drill-only timing hook used to make two independent writers overlap. */
  readonly holdMs?: number;
  /** Deliberate crash injection for durability recovery verification. */
  readonly crashHook?: FreshnessCrashHook;
  /** Security-test overrides: the helper still lstat-checks the real inodes. */
  readonly requiredOwnerUid?: number;
  readonly requiredPackageOwnerUid?: number;
}

export interface FreshnessUpdateResult {
  readonly ok: boolean;
  readonly updated: boolean;
  readonly staleLockReclaimed: boolean;
  readonly detail: string;
}

const TARGET_RE = /^[A-Za-z0-9._:-]+$/;
const LOCK_STALE_GRACE_MS = 5 * 60 * 1000;

function uid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function ownerAllowed(actual: number, required: number | undefined): boolean {
  if (required !== undefined) return actual === required;
  const current = uid();
  return current === undefined || actual === current || actual === 0;
}

function mode(st: { mode: number }): number {
  return Number(st.mode) & 0o7777;
}

function safeName(targetId: string): void {
  if (!TARGET_RE.test(targetId)) throw new Error("target id is not an opaque token");
}

function assertNoSymlinkAncestors(input: string): void {
  const absolute = path.resolve(input);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st;
    try {
      st = lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw error;
    }
    if (st.isSymbolicLink()) {
      const trustedAlias = process.platform === "darwin"
        ? current === "/var" || current === "/tmp"
        : current === "/tmp";
      if (!trustedAlias) throw new Error("freshness path contains a symbolic-link ancestor");
    }
  }
}

function assertDirectory(directory: string, requiredOwnerUid?: number): void {
  assertNoSymlinkAncestors(directory);
  const st = lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("freshness directory is not a regular directory");
  if (mode(st) !== 0o700) throw new Error("freshness directory is not exactly 0700");
  if (!ownerAllowed(st.uid, requiredOwnerUid)) throw new Error("freshness directory owner is unsafe");
}

function assertRegular(file: string, expectedMode: number, label: string, requiredOwnerUid?: number): void {
  assertNoSymlinkAncestors(file);
  const st = lstatSync(file);
  if (st.isSymbolicLink()) throw new Error(`${label} is a symbolic link`);
  if (!st.isFile()) throw new Error(`${label} is not a regular file`);
  if (mode(st) !== expectedMode) throw new Error(`${label} is not exactly ${expectedMode.toString(8).padStart(4, "0")}`);
  if (!ownerAllowed(st.uid, requiredOwnerUid)) throw new Error(`${label} owner is unsafe`);
  if (st.nlink !== 1) throw new Error(`${label} is a hardlink`);
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function sleepSync(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const until = Date.now() + Math.min(ms, 30_000);
  while (Date.now() < until) {
    // Atomics.wait is a synchronous sleep that does not create another process
    // or alter the lock protocol.
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, Math.min(25, until - Date.now()));
  }
}

function parsePrior(file: string, targetId: string): number | null {
  if (!existsSync(file)) return null;
  assertRegular(file, 0o600, "freshness file");
  const escaped = targetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = readFileSync(file, "utf8").match(new RegExp(`^# HELP [^\\n]+\\n# TYPE [^\\n]+ gauge\\n[^\\n]+\\{target="${escaped}"\\} (-?\\d+)\\n?$`));
  if (!match) throw new Error("freshness file content is invalid");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) throw new Error("freshness file value is invalid");
  return value;
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function reclaimStaleLock(lock: string, requiredOwnerUid?: number): boolean {
  if (!existsSync(lock)) return false;
  assertRegular(lock, 0o600, "freshness lock", requiredOwnerUid);
  const st = lstatSync(lock);
  const text = readFileSync(lock, "utf8");
  const match = text.match(/^pid=(\d+)\nstartedAt=(\d+)\n$/);
  const pid = match ? Number(match[1]) : 0;
  if (pidAlive(pid)) throw new Error("freshness lock is held");
  // A malformed lock is only reclaimable once it is old enough. Crash-created
  // locks always contain a PID, while this prevents deleting a newly-created
  // file whose writer has not yet finished populating it.
  if (!match && Date.now() - st.mtimeMs < LOCK_STALE_GRACE_MS) throw new Error("freshness lock metadata is invalid");
  unlinkSync(lock);
  return true;
}

function acquireLock(lock: string, requiredOwnerUid?: number): { fd: number; reclaimed: boolean } {
  let reclaimed = false;
  for (;;) {
    try {
      const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        fchmodSync(fd, 0o600);
        const body = `pid=${process.pid}\nstartedAt=${Date.now()}\n`;
        let offset = 0;
        while (offset < body.length) offset += writeSync(fd, body, offset, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      assertRegular(lock, 0o600, "freshness lock", requiredOwnerUid);
      return { fd, reclaimed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      reclaimed = reclaimStaleLock(lock, requiredOwnerUid) || reclaimed;
    }
  }
}

function removeStaleTemp(temp: string, requiredOwnerUid?: number): void {
  if (!existsSync(temp)) return;
  assertRegular(temp, 0o600, "freshness temporary file", requiredOwnerUid);
  unlinkSync(temp);
}

function writeAll(fd: number, content: string): void {
  let offset = 0;
  while (offset < content.length) offset += writeSync(fd, content, offset, "utf8");
}

function publishedPackageGuard(request: FreshnessUpdateRequest, report: MachineReport | null): FreshnessUpdateResult | null {
  const finalPath = report?.finalPath ?? null;
  if (!path.isAbsolute(request.backupRoot)) return { ok: false, updated: false, staleLockReclaimed: false, detail: "backup root is not absolute" };
  try {
    assertDirectory(request.backupRoot, request.requiredOwnerUid);
  } catch {
    return { ok: false, updated: false, staleLockReclaimed: false, detail: "backup root is unsafe" };
  }
  const complete = finalPath ? path.join(finalPath, "COMPLETE") : "";
  let packageOwnerOk = false;
  let completeExists = false;
  try {
    if (finalPath && path.isAbsolute(finalPath) && isWithin(request.backupRoot, finalPath)) {
      assertDirectory(finalPath, request.requiredPackageOwnerUid ?? request.requiredOwnerUid);
      assertRegular(complete, 0o600, "published COMPLETE", request.requiredPackageOwnerUid ?? request.requiredOwnerUid);
      completeExists = true;
      packageOwnerOk = true;
    }
  } catch {
    packageOwnerOk = false;
  }
  const guard = evaluateFreshnessGuard({
    exitCode: request.exitCode,
    report,
    backupRoot: request.backupRoot,
    finalPath,
    completeExists,
    packageOwnerOk,
  });
  if (!guard.update) return { ok: false, updated: false, staleLockReclaimed: false, detail: guard.reason };
  return null;
}

/**
 * The sole production freshness write path. It owns report validation, package
 * lstat/owner/mode/link checks, O_EXCL stale-PID locking, monotonic/clock
 * guards, and durable temp-fsync/rename/dir-fsync publication.
 */
export function updateFreshness(request: FreshnessUpdateRequest): FreshnessUpdateResult {
  try {
    safeName(request.targetId);
    assertDirectory(request.textfileDir, request.requiredOwnerUid);
  } catch (error) {
    return { ok: false, updated: false, staleLockReclaimed: false, detail: error instanceof Error ? error.message : "freshness target is unsafe" };
  }
  const report = request.reportText !== undefined ? parseMachineReport(request.reportText) : (request.report ?? null);
  const packageResult = publishedPackageGuard(request, report);
  if (packageResult) return packageResult;

  const file = path.join(request.textfileDir, `${request.targetId}.prom`);
  const lock = `${file}.lock`;
  const temp = `${file}.tmp`;
  let lockHeld = false;
  let reclaimed = false;
  try {
    const acquired = acquireLock(lock, request.requiredOwnerUid);
    lockHeld = true;
    reclaimed = acquired.reclaimed;
    const prior = parsePrior(file, request.targetId);
    const now = request.nowSec ?? Math.floor(Date.now() / 1000);
    const value = computeFreshnessValue({
      backupStart: request.backupStartSec,
      priorValue: prior,
      now,
      maxFutureSkewSec: request.maxFutureSkewSec ?? 300,
    });
    if (value.value === null) return { ok: false, updated: false, staleLockReclaimed: reclaimed, detail: value.reason };
    if (!value.advanced) return { ok: true, updated: false, staleLockReclaimed: reclaimed, detail: value.reason };

    removeStaleTemp(temp, request.requiredOwnerUid);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeAll(fd, freshnessTextfileContent(value.value, request.targetId));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assertRegular(temp, 0o600, "freshness temporary file", request.requiredOwnerUid);
    sleepSync(request.holdMs ?? 0);
    if (request.crashHook === "before-rename") kill(process.pid, "SIGKILL");
    renameSync(temp, file);
    if (request.crashHook === "after-rename") kill(process.pid, "SIGKILL");
    fsyncDirectory(request.textfileDir);
    assertRegular(file, 0o600, "freshness file", request.requiredOwnerUid);
    return { ok: true, updated: true, staleLockReclaimed: reclaimed, detail: "freshness advanced" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "freshness update failed";
    return { ok: false, updated: false, staleLockReclaimed: reclaimed, detail };
  } finally {
    if (lockHeld) {
      try { unlinkSync(lock); } catch { /* SIGKILL intentionally leaves the lock */ }
    }
  }
}

/** A small stable surface for tests and the independent helper child. */
export function parseFreshnessRequest(value: unknown): FreshnessUpdateRequest {
  if (typeof value !== "object" || value === null) throw new Error("freshness request is invalid");
  const request = value as Partial<FreshnessUpdateRequest>;
  if (typeof request.textfileDir !== "string" || typeof request.targetId !== "string" || typeof request.backupRoot !== "string" || typeof request.exitCode !== "number" || typeof request.backupStartSec !== "number") {
    throw new Error("freshness request fields are invalid");
  }
  return request as FreshnessUpdateRequest;
}
