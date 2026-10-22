import path from "node:path";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, writeSync, type Stats } from "node:fs";
import { parseSessionEntries, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { canonicalCwdIdentity, sameSavedCwdIdentity } from "../core/native-session-policy.js";
import { assertCurrentPiJsonl } from "./pi-jsonl-conversation-storage.js";
import { nativePathSnapshot, sameNativeFile, sameNativeNode, type NativeSessionSource, type NativeSourceBinding } from "./native-session-source.js";

/** A descriptor is the only IO authority. Paths are validation/metadata, never SDK IO. */
export class NativeSessionFd {
  private fd: number | undefined;
  private expected: Stats;
  private poisoned = false;
  private readonly ancestors: ReturnType<typeof nativePathSnapshot>;
  onPoison?: () => void;
  private releaseLiveCheck?: () => void;

  constructor(private readonly source: NativeSessionSource, readonly binding: NativeSourceBinding, writable: boolean) {
    if (!source.allowsBinding(binding)) throw new Error("native source unavailable");
    const nodes = nativePathSnapshot(source.root, binding.sourcePath);
    this.ancestors = nodes.slice(0, -1);
    this.fd = openSync(binding.sourcePath, (writable ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      this.expected = fstatSync(this.fd);
      this.check();
      if (!sameNativeFile(this.expected, nodes.at(-1)!.stat) || nodes.some(node => !sameNativeNode(node.stat, lstatSync(node.file)))) throw new Error("native source changed");
    } catch (error) { this.close(); throw error; }
    if (writable) this.releaseLiveCheck = source.registerLiveCheck(binding, () => this.check());
  }

  /** No full-file hashing/reading on output or append: stat fingerprint and policy only. */
  check(): void {
    try {
      if (this.poisoned || this.fd === undefined || !this.source.allowsBinding(this.binding)) throw new Error();
      const stat = fstatSync(this.fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== this.binding.sourceIno || !sameNativeFile(stat, this.expected)) throw new Error();
      const nodes = nativePathSnapshot(this.source.root, this.binding.sourcePath);
      if (this.ancestors.some((node, index) => !sameNativeNode(node.stat, nodes[index]!.stat)) ||
          !sameNativeFile(stat, nodes.at(-1)!.stat) || !sameNativeFile(stat, fstatSync(this.fd))) throw new Error();
    } catch { this.poison(); throw new Error("native source unavailable or changed"); }
  }

  snapshot(maxBytes = Number.MAX_SAFE_INTEGER): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.snapshotBytes(maxBytes));
  }

  snapshotBytes(maxBytes = Number.MAX_SAFE_INTEGER): Buffer {
    this.check();
    if (this.expected.size > maxBytes) throw new Error("native metadata budget exceeded");
    const buffer = Buffer.alloc(this.expected.size);
    let position = 0;
    try {
      while (position < buffer.length) {
        const count = readSync(this.fd!, buffer, position, buffer.length - position, position);
        if (!count) throw new Error();
        position += count;
      }
      this.check();
      return buffer;
    } catch (error) { this.poison(); throw error; }
  }

  /** Bounded positional metadata IO on the already-authorized descriptor. */
  readRange(position: number, maxBytes: number): Buffer {
    this.check();
    if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid native range");
    const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(0, this.expected.size - position)));
    let offset = 0;
    try {
      while (offset < buffer.length) {
        const count = readSync(this.fd!, buffer, offset, buffer.length - offset, position + offset);
        if (!count) throw new Error("native source changed");
        offset += count;
      }
      this.check();
      return buffer;
    } catch (error) { this.poison(); throw error; }
  }

  verifiedMetadata() {
    this.check();
    return { ...this.binding, relativeSourcePath: path.relative(this.source.root, this.binding.sourcePath),
      size: this.expected.size, mtimeMs: this.expected.mtimeMs, ctimeMs: this.expected.ctimeMs,
      mode: this.expected.mode, nlink: this.expected.nlink };
  }

  append(entry: SessionEntry): void {
    try {
      this.check();
      const line = Buffer.from(JSON.stringify(entry) + "\n");
      const before = this.expected;
      // Exactly one append write. A short write cannot be rolled back safely: poison forever.
      if (writeSync(this.fd!, line, 0, line.length, null) !== line.length) throw new Error();
      const after = fstatSync(this.fd!);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size + line.length || !after.isFile() || after.nlink !== 1) throw new Error();
      this.expected = after;
      this.check();
    } catch { this.poison(); throw new Error("native append failed; runtime invalidated"); }
  }

  private poison(): void {
    if (this.poisoned) return;
    this.poisoned = true;
    this.close();
    this.onPoison?.();
  }
  close(): void {
    this.releaseLiveCheck?.();
    this.releaseLiveCheck = undefined;
    if (this.fd === undefined) return;
    const fd = this.fd; this.fd = undefined;
    closeSync(fd);
  }
}

function validatedEntries(content: string, binding: NativeSourceBinding): SessionEntry[] {
  if (!content.trim() || !content.endsWith("\n")) throw new Error("native history is not complete v3 JSONL");
  assertCurrentPiJsonl(content);
  const entries = parseSessionEntries(content) as SessionEntry[];
  const header = entries[0] as unknown as { id: string; cwd: string };
  const cwd = canonicalCwdIdentity(header.cwd);
  if (header.id !== binding.sourceId || !sameSavedCwdIdentity(binding, cwd)) throw new Error("native header changed");
  return entries;
}

export function nativeEntries(descriptor: NativeSessionFd, maxBytes?: number): SessionEntry[] {
  return validatedEntries(descriptor.snapshot(maxBytes), descriptor.binding);
}

/** Reusable read-only backup/export boundary: actual bytes, safe root-relative path
 * and verified identity metadata. Does not claim cross-process atomicity or restore safety. */
export function readNativeSourceSnapshot(source: NativeSessionSource, binding: NativeSourceBinding, maxBytes?: number) {
  const descriptor = new NativeSessionFd(source, binding, false);
  try {
    const bytes = descriptor.snapshotBytes(maxBytes);
    validatedEntries(new TextDecoder("utf-8", { fatal: true }).decode(bytes), binding);
    const metadata = descriptor.verifiedMetadata();
    return { bytes, relativeSourcePath: metadata.relativeSourcePath, metadata };
  } finally { descriptor.close(); }
}

export function openNativeSessionManager(source: NativeSessionSource, binding: NativeSourceBinding): { manager: SessionManager; descriptor: NativeSessionFd } {
  const descriptor = new NativeSessionFd(source, binding, true);
  try {
    const manager = SessionManager.inMemory(binding.cwd, undefined, nativeEntries(descriptor));
    // SDK 1.0.4 funnels every append (including metadata/compaction/extension entries)
    // through _persist. SDK mutates memory first; poison prevents any subsequent output/use.
    Object.defineProperty(manager, "_persist", { value: (entry: SessionEntry) => descriptor.append(entry) });
    Object.defineProperty(manager, "getSessionFile", { value: () => binding.sourcePath });
    for (const method of ["newSession", "setSessionFile", "_setSessionFile", "createBranchedSession", "_rewriteFile", "_loadEntries"]) {
      Object.defineProperty(manager, method, { value: () => { throw new Error("native session replacement/rewrite forbidden"); } });
    }
    return { manager, descriptor };
  } catch (error) { descriptor.close(); throw new Error("native source unavailable", { cause: error }); }
}
