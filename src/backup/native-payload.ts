import path from "node:path";
import { lstatSync, mkdirSync, linkSync, rmSync, readdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { NativeSessionSource, nativeProjectDirectory, type NativeSourceBinding } from "../agent/native-session-source.js";
import { readNativeSourceSnapshot } from "../agent/native-session-fd.js";
import { NativeSessionPolicy, canonicalCwdIdentity } from "../core/native-session-policy.js";
import { stableSerialize } from "../storage/migration-manifest.js";

/** External references are metadata, never a filesystem read/write capability. */
export interface NativeBackupEntry {
  readonly source_path: string;
  readonly source_id: string;
  readonly session_id: string;
  readonly project_id: string;
  readonly binding: string;
  readonly deleted: number;
  readonly status: "archived" | "external-required" | "tombstone";
  readonly relativeSourcePath?: string;
  readonly payloadPath?: string;
}

function fail(message: string): never { throw new Error(`native backup: ${message}`); }

export function snapshotNativeSources(rows: readonly Record<string, unknown>[]): NativeBackupEntry[] {
  const paths = new Set<string>(), ids = new Set<string>(), sessions = new Set<string>();
  return rows.map((row): NativeBackupEntry => {
    if (![row.source_path, row.source_id, row.session_id, row.project_id, row.binding].every(value => typeof value === "string" && value.length > 0) ||
        (row.deleted !== 0 && row.deleted !== 1) || !path.isAbsolute(String(row.source_path)) || String(row.source_path).includes("\0")) fail("malformed source index");
    const entry = row as unknown as Omit<NativeBackupEntry, "status">;
    let binding: Record<string, unknown>;
    try { binding = JSON.parse(entry.binding); } catch { fail("malformed source binding"); }
    if (!binding || typeof binding !== "object" || binding.sourcePath !== entry.source_path || binding.sourceId !== entry.source_id ||
        typeof binding.cwd !== "string" || !path.isAbsolute(binding.cwd) ||
        (binding.private !== undefined && binding.private !== true) ||
        ![binding.dev, binding.ino, binding.sourceDev, binding.sourceIno].every(value => typeof value === "number" && Number.isFinite(value))) fail("malformed source binding");
    if (paths.has(entry.source_path) || ids.has(entry.source_id) || sessions.has(entry.session_id)) fail("duplicate source index");
    paths.add(entry.source_path); ids.add(entry.source_id); sessions.add(entry.session_id);
    return { source_path: entry.source_path, source_id: entry.source_id, session_id: entry.session_id, project_id: entry.project_id,
      binding: entry.binding, deleted: entry.deleted, status: entry.deleted ? "tombstone" : "external-required" };
  }).sort((a, b) => a.source_path.localeCompare(b.source_path));
}

export function validateNativeManifest(value: unknown): void {
  if (value === undefined) return; // Historical managed-only packages remain compatible.
  if (!Array.isArray(value) || value.length === 0) fail("invalid native manifest");
  const entries = snapshotNativeSources(value);
  for (const entry of entries) {
    const raw = value.find(row => row?.source_path === entry.source_path);
    if (raw.status === "archived" && !entry.deleted) {
      validateNativeRelative(raw.relativeSourcePath, JSON.parse(entry.binding).cwd);
      if (raw.payloadPath !== `payload/native/${raw.relativeSourcePath}.age`) fail("invalid native payload mapping");
    } else if (raw.status !== entry.status || raw.relativeSourcePath !== undefined || raw.payloadPath !== undefined) fail("invalid native manifest status or capability");
    if (Object.keys(raw).some(key => ![...Object.keys(entry), "relativeSourcePath", "payloadPath"].includes(key))) fail("invalid native manifest capability");
  }
}

export function validateNativeSet(value: unknown, rows: readonly Record<string, unknown>[], sessionRows: readonly Record<string, unknown>[]): NativeBackupEntry[] {
  validateNativeManifest(value);
  const entries = snapshotNativeSources(rows);
  const claims = (value as NativeBackupEntry[] | undefined)?.map(({ relativeSourcePath: _relative, payloadPath: _payload, ...entry }) => ({ ...entry, status: entry.deleted ? "tombstone" : "external-required" })) ?? [];
  if (stableSerialize(entries) !== stableSerialize(claims)) fail("native manifest differs from frozen source index");
  for (const row of sessionRows) {
    const entry = entries.find(entry => entry.session_id === row.id && entry.deleted === 0);
    if (row.conversation_format !== "pi-native-jsonl-v3" && !entry) continue;
    const privateClaim = entry && JSON.parse(entry.binding).private === true;
    if (!entry || entry.project_id !== row.project_id || row.agent_kind !== "pi" || row.conversation_ref !== entry.source_path ||
      (privateClaim ? row.conversation_format !== "pi-jsonl-v3" || row.visibility !== "private" || row.origin !== "managed" : row.conversation_format !== "pi-native-jsonl-v3")) fail("native/private session has no exact active source claim");
  }
  for (const entry of entries) {
    if (entry.deleted === 0 && !sessionRows.some(row => row.id === entry.session_id)) fail("active native claim has no native session");
    if (entry.deleted === 1 && sessionRows.some(row => row.id === entry.session_id)) fail("native/private tombstone has a live session");
  }
  return entries;
}

/** Bindings from another instance are NOT authorization on this host. */
export function unauthorisedRestoreBinding(binding: string): string {
  return JSON.stringify({ ...JSON.parse(binding), dev: -1, ino: -1, sourceDev: -1, sourceIno: -1 });
}

export function validateNativeRelative(value: unknown, cwd: string): asserts value is string {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0") || path.isAbsolute(value)) fail("unsafe native relative path");
  const parts = value.split("/");
  if (parts.length !== 2 || parts.some(part => !part || part === "." || part === "..") || parts[0] !== nativeProjectDirectory(cwd) || !parts[1]!.endsWith(".jsonl")) fail("unsafe native encoded cwd path");
}

/** Administrator-only offline scope: exclusions govern shared access, not disaster recovery.
 * Still requires exact registered inode/cwd/header identities and a configured allowroot. */
export function captureNativePayloads(entries: readonly NativeBackupEntry[], sourceRoot?: string) {
  const source = sourceRoot ? new NativeSessionSource(sourceRoot, new NativeSessionPolicy([])) : undefined;
  return entries.map(entry => {
    if (entry.deleted) return { entry, bytes: undefined };
    if (!source) fail("active native sources require configured nativeSourceRoot");
    const binding = JSON.parse(entry.binding) as NativeSourceBinding;
    source.validate(binding);
    const snapshot = readNativeSourceSnapshot(source, binding);
    const relative = snapshot.relativeSourcePath.split(path.sep).join("/");
    validateNativeRelative(relative, binding.cwd);
    return { entry: { ...entry, status: "archived" as const, relativeSourcePath: relative, payloadPath: `payload/native/${relative}.age` }, bytes: snapshot.bytes };
  });
}

export interface NativeRestoreOptions {
  /** Where restored native sessions go; defaults to `<target root>/native-sessions` (nativeRestoreRoot). */
  readonly nativeSourceRoot?: string;
}

/** Default native destination: inside the isolated restore target, never the live session directory. */
export const NATIVE_RESTORE_DEFAULT_DIR = "native-sessions";
export function nativeRestoreRoot(configured: string | undefined, canonicalTarget: string): string {
  return configured ?? path.join(canonicalTarget, NATIVE_RESTORE_DEFAULT_DIR);
}
export interface NativeRestoreClaim { entry: NativeBackupEntry; target: string; binding: string; staged: string }

/** Files are assembled privately first; exclusive hardlink publish preserves inode bindings.
 * No archive absolute path is ever used as a destination. */
export function planNativeRestore(entries: readonly NativeBackupEntry[] | undefined, assembled: string, options: NativeRestoreOptions): NativeRestoreClaim[] {
  const active = (entries ?? []).filter(entry => !entry.deleted);
  if (active.some(entry => entry.status !== "archived")) fail("external-required package lacks native bytes; complete restore refused");
  if (!active.length) return [];
  const root = options.nativeSourceRoot;
  if (!root || !path.isAbsolute(root) || path.resolve(root) !== root) fail("restore requires configured nativeSourceRoot");
  const claims = active.map(entry => {
    const original = JSON.parse(entry.binding) as NativeSourceBinding;
    // Sessions return to the project they were taken from: bytes (including
    // header.cwd) are never rewritten, so a project must exist at its original path.
    const identity = canonicalCwdIdentity(original.cwd);
    if (identity.cwd !== original.cwd) fail("native session project is not at its original canonical path");
    validateNativeRelative(entry.relativeSourcePath, identity.cwd);
    const target = path.join(root, entry.relativeSourcePath);
    // Probe every existing component; missing leaf/ancestors are fine, symlinks are not.
    let node = path.parse(target).root;
    for (const part of target.slice(node.length).split(path.sep)) {
      node = path.join(node, part);
      try { const st = lstatSync(node); if (st.isSymbolicLink() || (node !== target && !st.isDirectory())) fail("unsafe native target ancestor"); if (node === target) fail("native restore target already exists"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const staged = path.join(assembled, "native", entry.relativeSourcePath);
    const st = lstatSync(staged);
    const bytes = readFileSync(staged);
    const header = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString("utf8"));
    // Backup accepts lexical cwd aliases such as /project/. after canonical
    // identity validation. Preserve those exact bytes on restore, but require
    // the header directory to exist and identify the original project.
    const headerIdentity = typeof header.cwd === "string" && path.isAbsolute(header.cwd) ? canonicalCwdIdentity(header.cwd) : undefined;
    if (header.id !== entry.source_id || header.version !== 3 || header.type !== "session" ||
      !headerIdentity || headerIdentity.cwd !== identity.cwd || headerIdentity.dev !== identity.dev || headerIdentity.ino !== identity.ino) fail("native restored header differs from claim");
    return { entry, target, staged, binding: JSON.stringify({ ...identity, sourceId: entry.source_id, sourcePath: target, sourceDev: st.dev, sourceIno: st.ino, ...(original.private ? { private: true } : {}) }) };
  });
  if (new Set(claims.map(claim => claim.target)).size !== claims.length) fail("duplicate native restore target");
  return claims;
}

export type NativeRestorePhase = "prepared" | "linked" | "renamed" | "committed" | "finalizing" | "finalized";
export const NATIVE_RESTORE_RECORD = "NATIVE-RESTORE-CLEANUP.json";

/** A local operator aid, NOT an automatically consumed recovery journal or an
 * archive-supplied deletion capability. Retained on SIGKILL for manual cleanup. */
export function recordNativeRestore(claims: readonly NativeRestoreClaim[], assembled: string, finalPath: string): void {
  if (!claims.length) return;
  const file = path.join(assembled, NATIVE_RESTORE_RECORD);
  writeFileSync(file, JSON.stringify({ version: 1, assembled, finalPath, claims: claims.map(claim => {
    const binding = JSON.parse(claim.binding);
    return { target: claim.target, stagedRelative: path.relative(assembled, claim.staged), sourceId: claim.entry.source_id,
      sessionId: claim.entry.session_id, dev: binding.sourceDev, ino: binding.sourceIno };
  }) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const fd = openSync(file, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Run ONLY after database publication (SQLite rename / PG COMMIT). Until then
 * staging hardlinks keep native files invisible to the nlink=1 scanner. */
export function finalizeNativeRestore(claims: readonly NativeRestoreClaim[], assembled: string, finalPath: string,
  checkpoint?: (phase: NativeRestorePhase) => void): void {
  for (const claim of claims) {
    const staged = path.join(finalPath, path.relative(assembled, claim.staged));
    const binding = JSON.parse(claim.binding);
    for (const file of [claim.target, staged]) {
      const st = lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.dev !== binding.sourceDev || st.ino !== binding.sourceIno) fail("restore finalize inode conflict");
    }
    rmSync(staged);
    checkpoint?.("finalizing");
  }
  if (claims.length) rmSync(path.join(finalPath, NATIVE_RESTORE_RECORD));
}

export function publishNativeRestore(claims: readonly NativeRestoreClaim[]): () => void {
  const published: NativeRestoreClaim[] = [], created: string[] = [];
  const rollback = () => {
    for (const claim of published.reverse()) {
      const binding = JSON.parse(claim.binding);
      try { const st = lstatSync(claim.target); if (st.dev === binding.sourceDev && st.ino === binding.sourceIno) rmSync(claim.target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const dir of created.reverse()) { if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true }); }
  };
  try {
    for (const claim of claims) {
      const missing: string[] = []; let dir = path.dirname(claim.target);
      while (true) { try { lstatSync(dir); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing.unshift(dir); dir = path.dirname(dir); } }
      for (const directory of missing) { mkdirSync(directory, { mode: 0o700 }); created.push(directory); }
      let node = path.parse(claim.target).root;
      for (const part of path.dirname(claim.target).slice(node.length).split(path.sep)) {
        node = path.join(node, part);
        const st = lstatSync(node);
        if (st.isSymbolicLink() || !st.isDirectory()) fail("unsafe native target ancestor");
      }
      linkSync(claim.staged, claim.target); published.push(claim);
    }
    return rollback;
  } catch (error) { rollback(); throw error; }
}
