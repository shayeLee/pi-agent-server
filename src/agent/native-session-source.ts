import path from "node:path";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { opendir } from "node:fs/promises";
import { canonicalCwdIdentity, type CanonicalCwdIdentity, type NativeSessionPolicy } from "../core/native-session-policy.js";

export const NATIVE_SCAN_MAX_ENTRIES = 4096;
export const NATIVE_HEADER_MAX_BYTES = 16 * 1024;
export type NativeSourceBinding = CanonicalCwdIdentity & {
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly sourceDev: number;
  readonly sourceIno: number;
  /** Durable Web-private claim; share exclusions do not prohibit private use. */
  readonly private?: boolean;
};
export type NativeSourceCandidate = { binding: NativeSourceBinding; createdAt: number; updatedAt: number };
export type NativeScanWarning = "native-source-unavailable" | "native-source-skipped" | "native-scan-truncated";
export type NativeScanPage = { sources: NativeSourceCandidate[]; nextOffset: number | null; warnings: NativeScanWarning[] };

export function sameNativeFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export function sameNativeNode(a: Stats, b: Stats): boolean {
  // Directory content timestamps change for unrelated siblings; only its identity
  // and no-symlink directory type are relevant to the ancestor boundary.
  return a.isDirectory() ? b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino : sameNativeFile(a, b);
}

export function nativeProjectDirectory(cwd: string): string {
  return `--${cwd.replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}--`;
}

/** Strict allowroot verification; no symlink in the source root or descendants. */
export function nativePathSnapshot(root: string, file: string): Array<{ file: string; stat: Stats }> {
  if (!path.isAbsolute(root) || !path.isAbsolute(file) || path.resolve(root) !== root || path.resolve(file) !== file) throw new Error("native source unavailable");
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("native source unavailable");
  // Check ancestors too; realpath alone would silently accept a symlinked configured root.
  let node = path.parse(root).root;
  const nodes: Array<{ file: string; stat: Stats }> = [];
  for (const part of [...root.slice(node.length).split(path.sep).filter(Boolean), ...relative.split(path.sep)]) {
    node = path.join(node, part);
    const stat = lstatSync(node);
    if (stat.isSymbolicLink() || (node === file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new Error("native source unavailable");
    nodes.push({ file: node, stat });
  }
  if (realpathSync(file) !== file) throw new Error("native source unavailable");
  return nodes;
}

/** Header-only descriptor read, never SDK.open or a legacy migration. */
export function readNativeSource(root: string, file: string, identity?: CanonicalCwdIdentity): NativeSourceCandidate {
  const nodes = nativePathSnapshot(root, file);
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!sameNativeFile(before, nodes.at(-1)!.stat) || !before.isFile()) throw new Error();
    const buffer = Buffer.alloc(NATIVE_HEADER_MAX_BYTES);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, length).indexOf(10);
    if (newline < 0) throw new Error();
    const header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline)));
    if (header?.type !== "session" || header.version !== 3 || typeof header.id !== "string" || !header.id.length || header.id.length > 200 || typeof header.cwd !== "string") throw new Error();
    const cwd = canonicalCwdIdentity(header.cwd);
    identity ??= cwd;
    if (cwd.cwd !== identity.cwd || cwd.dev !== identity.dev || cwd.ino !== identity.ino) throw new Error();
    if (path.dirname(file) !== path.join(root, nativeProjectDirectory(identity.cwd))) throw new Error();
    if (!sameNativeFile(before, fstatSync(fd)) || nodes.some(node => !sameNativeNode(node.stat, lstatSync(node.file)))) throw new Error();
    const createdAt = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    return { binding: { ...identity, sourceId: header.id, sourcePath: file, sourceDev: before.dev, sourceIno: before.ino },
      createdAt: Number.isFinite(createdAt) ? createdAt : before.birthtimeMs, updatedAt: before.mtimeMs };
  } catch {
    throw new Error("native source unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class NativeSessionSource {
  private readonly revocationListeners = new Set<(binding: NativeSourceBinding) => void>();
  onRevoked(listener: (binding: NativeSourceBinding) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }
  revoke(binding: NativeSourceBinding): void {
    for (const listener of this.revocationListeners) listener(binding);
  }

  private readonly liveChecks = new Map<string, () => void>();

  /** The writer's FD fingerprint advances only after its own verified append. */
  registerLiveCheck(binding: NativeSourceBinding, check: () => void): () => void {
    this.liveChecks.set(binding.sourcePath, check);
    return () => { if (this.liveChecks.get(binding.sourcePath) === check) this.liveChecks.delete(binding.sourcePath); };
  }

  prepareOutputGuard(binding: NativeSourceBinding): () => boolean {
    // Capture the current writer: an old stream must never adopt a replacement runtime.
    const check = this.liveChecks.get(binding.sourcePath);
    return () => {
      try {
        if (check) check();
        else this.validate(binding); // No runtime: bounded descriptor/header verification only.
        return true;
      } catch { this.revoke(binding); return false; }
    };
  }

  allowsOutput(binding: NativeSourceBinding): boolean {
    return this.prepareOutputGuard(binding)();
  }

  constructor(readonly root: string, readonly policy: NativeSessionPolicy) {}

  allowsBinding(binding: NativeSourceBinding): boolean {
    if (!binding.private) return this.policy.allows(binding);
    try {
      const identity = canonicalCwdIdentity(binding.cwd);
      return identity.cwd === binding.cwd && identity.dev === binding.dev && identity.ino === binding.ino;
    } catch { return false; }
  }

  validate(binding: NativeSourceBinding): NativeSourceCandidate {
    if (!this.allowsBinding(binding)) throw new Error("native source unavailable");
    const current = readNativeSource(this.root, binding.sourcePath, binding);
    if (current.binding.sourceId !== binding.sourceId || current.binding.sourceDev !== binding.sourceDev || current.binding.sourceIno !== binding.sourceIno) throw new Error("native source unavailable");
    return current;
  }

  /** Full content change detection is on-demand only, never part of discovery. Not a CLI lock. */
  fingerprint(binding: NativeSourceBinding): string {
    this.validate(binding);
    const nodes = nativePathSnapshot(this.root, binding.sourcePath);
    const fd = openSync(binding.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!sameNativeFile(before, nodes.at(-1)!.stat)) throw new Error("native source changed");
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(256 * 1024);
      let position = 0;
      while (position < before.size) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - position), position);
        if (!count) throw new Error("native source changed");
        hash.update(chunk.subarray(0, count)); position += count;
      }
      if (!sameNativeFile(before, fstatSync(fd)) || nodes.some(node => !sameNativeNode(node.stat, lstatSync(node.file)))) throw new Error("native source changed");
      return `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}:${hash.digest("hex")}`;
    } finally { closeSync(fd); }
  }

  /** One yielded entry is one discovery budget unit, including invalid/empty directories.
   * Directory names are never decoded into authorized working directories. */
  async *workspaces(): AsyncGenerator<NativeSourceCandidate | null> {
    try {
      const stat = lstatSync(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(this.root) !== this.root) return;
      const root = await opendir(this.root);
      try {
        for (let dirs = 0; dirs < NATIVE_SCAN_MAX_ENTRIES; dirs++) {
          const entry = await root.read();
          if (!entry) break;
          yield null;
          const directory = path.join(this.root, entry.name);
          if (!entry.isDirectory() || !entry.name.startsWith("--") || !entry.name.endsWith("--")) continue;
          try {
            if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) continue;
            const files = await opendir(directory);
            try {
              for (let count = 0; count < NATIVE_SCAN_MAX_ENTRIES; count++) {
                const file = await files.read();
                if (!file) break;
                let source: NativeSourceCandidate | null = null;
                if (file.name.endsWith(".jsonl")) {
                  try {
                    const candidate = readNativeSource(this.root, path.join(directory, file.name));
                    if (this.policy.allows(candidate.binding)) source = candidate;
                  } catch { /* Invalid header or source boundary: no authorization. */ }
                }
                yield source;
              }
            } finally { await files.close(); }
          } catch { /* Missing/replaced/unsafe directory is not a workspace. */ }
        }
      } finally { await root.close(); }
    } catch { /* Missing or unsafe source root: no discovery. */ }
  }

  /** Bounded filesystem-order pages; offsets are scan cursors, not durable transcript cursors. */
  async scan(identity: CanonicalCwdIdentity, offset = 0, limit = 100): Promise<NativeScanPage> {
    if (!Number.isInteger(offset) || offset < 0 || offset >= NATIVE_SCAN_MAX_ENTRIES || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid native scan page");
    if (!this.policy.allows(identity)) return { sources: [], nextOffset: null, warnings: [] };
    const directory = path.join(this.root, nativeProjectDirectory(identity.cwd));
    const sources: NativeSourceCandidate[] = [];
    const warnings = new Set<NativeScanWarning>();
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      // Probe with a synthetic descendant to validate directories without creating anything.
      const rootStat = lstatSync(this.root);
      const directoryStat = lstatSync(directory);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !directoryStat.isDirectory() || directoryStat.isSymbolicLink() || realpathSync(this.root) !== this.root || realpathSync(directory) !== directory) throw new Error();
      handle = await opendir(directory);
      let index = 0;
      while (index < NATIVE_SCAN_MAX_ENTRIES) {
        const entry = await handle.read();
        if (!entry) return { sources, nextOffset: null, warnings: [...warnings] };
        if (index++ < offset) continue;
        if (entry.name.endsWith(".jsonl")) {
          try { sources.push(readNativeSource(this.root, path.join(directory, entry.name), identity)); }
          catch { warnings.add("native-source-skipped"); }
        }
        // Count examined entries, not successful imports, to bound bad-file scans too.
        if (index - offset >= limit) {
          const more = await handle.read();
          if (more && index === NATIVE_SCAN_MAX_ENTRIES) warnings.add("native-scan-truncated");
          return { sources, nextOffset: more && index < NATIVE_SCAN_MAX_ENTRIES ? index : null, warnings: [...warnings] };
        }
      }
      warnings.add("native-scan-truncated");
      return { sources, nextOffset: null, warnings: [...warnings] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.add("native-source-unavailable");
      return { sources: [], nextOffset: null, warnings: [...warnings] };
    } finally {
      await handle?.close();
    }
  }
}
