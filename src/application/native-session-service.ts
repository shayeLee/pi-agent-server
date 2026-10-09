import type { NativeSessionPort } from "./ports/native-session-port.js";
import type { SessionRecord } from "./ports/session-store-port.js";
import { canonicalCwdIdentity } from "../core/native-session-policy.js";
import { NativeSessionSource, type NativeSourceBinding, type NativeSourceCandidate, type NativeScanWarning } from "../agent/native-session-source.js";

export interface NativeSessionIndexPort {
  claimWorkspace?(source: NativeSourceCandidate, sessionId: string, projectId: string): Promise<string | null>;
  binding(sessionId: string): Promise<NativeSourceBinding | null>;
  hasClaim?(sessionId: string): Promise<boolean>;
  reservePrivate?(projectId: string, binding: NativeSourceBinding, sessionId: string): Promise<void>;
  finalizePrivate?(binding: NativeSourceBinding, sessionId: string): Promise<void>;
  retirePrivate?(sessionId: string): Promise<void>;
  claim(projectId: string, source: NativeSourceCandidate, sessionId: string): Promise<string | null>;
}

export class NativeSessionService implements NativeSessionPort {
  private readonly scans = new Map<string, Promise<readonly NativeScanWarning[]>>();
  private readonly scanOffsets = new Map<string, number>();
  private readonly completed = new Map<string, { at: number; warnings: readonly NativeScanWarning[] }>();
  private workspaceIterator?: AsyncGenerator<NativeSourceCandidate | null>;
  private workspaceCompletedAt = 0;
  private workspaceScan?: Promise<void>;
  private readonly bindings = new Map<string, NativeSourceBinding>();
  private readonly revocationListeners = new Set<(sessionId: string) => void>();
  constructor(readonly source: NativeSessionSource, readonly index: NativeSessionIndexPort, private readonly createId: () => string) {
    source.onRevoked(binding => {
      for (const [id, known] of this.bindings) if (known.sourcePath === binding.sourcePath) {
        for (const listener of this.revocationListeners) listener(id);
      }
    });
  }

  async close(): Promise<void> {
    await this.workspaceScan;
    await this.workspaceIterator?.return(undefined);
    this.workspaceIterator = undefined;
  }

  onRevoked(listener: (sessionId: string) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }
  async outputGuard(record: SessionRecord): Promise<() => boolean> {
    if (!(await this.allows(record))) return () => false;
    const binding = this.bindings.get(record.id)!;
    return this.source.prepareOutputGuard(binding);
  }

  /** Advance at most 100 directory/header entries per call; concurrent callers
   * share a page and completed sweeps are cached for five seconds. */
  async discoverProjects(): Promise<void> {
    if (!this.index.claimWorkspace || Date.now() - this.workspaceCompletedAt < 5000) return;
    if (this.workspaceScan) return this.workspaceScan;
    const scan = (async () => {
      this.workspaceIterator ??= this.source.workspaces();
      for (let count = 0; count < 100; count++) {
        const next = await this.workspaceIterator.next();
        if (next.done) {
          this.workspaceIterator = undefined;
          this.workspaceCompletedAt = Date.now();
          break;
        }
        if (!next.value) continue;
        try { this.source.validate(next.value.binding); } catch { continue; }
        await this.index.claimWorkspace!(next.value, this.createId(), this.createId());
      }
    })();
    this.workspaceScan = scan;
    try { await scan; } finally { this.workspaceScan = undefined; }
  }

  async discover(project: { id: string; cwd: string }): Promise<readonly NativeScanWarning[]> {
    let identity;
    try { identity = canonicalCwdIdentity(project.cwd); } catch { return ["native-source-unavailable"]; }
    const completed = this.completed.get(identity.cwd);
    if (completed && Date.now() - completed.at < 5000) return completed.warnings;
    const active = this.scans.get(identity.cwd);
    if (active) return active;
    const scan = (async () => {
      let offset: number | null = this.scanOffsets.get(identity.cwd) ?? 0;
      const warnings = new Set<NativeScanWarning>();
      const page = await this.source.scan(identity, offset);
      for (const warning of page.warnings) warnings.add(warning);
      for (const candidate of page.sources) {
        // Directory policy may change during a bounded scan; recheck before indexing.
        try { this.source.validate(candidate.binding); } catch { continue; }
        if (this.index.claimWorkspace) await this.index.claimWorkspace(candidate, this.createId(), this.createId());
        else await this.index.claim(project.id, candidate, this.createId());
      }
      offset = page.nextOffset;
      if (offset === null) this.scanOffsets.delete(identity.cwd);
      else this.scanOffsets.set(identity.cwd, offset);
      return [...warnings];
    })();
    this.scans.set(identity.cwd, scan);
    try {
      const warnings = await scan;
      if (this.completed.size >= 128) this.completed.delete(this.completed.keys().next().value!);
      if (!this.scanOffsets.has(identity.cwd)) this.completed.set(identity.cwd, { at: Date.now(), warnings });
      return warnings;
    } finally { this.scans.delete(identity.cwd); }
  }

  async allows(record: SessionRecord): Promise<boolean> {
    const binding = await this.index.binding(record.id);
    if (!binding || binding.sourcePath !== record.conversationRef) return false;
    if (binding.private ? (record.origin ?? "managed") !== "managed" || (record.visibility ?? "private") !== "private" :
        record.visibility !== "shared" || record.origin !== "native" || record.conversationFormat !== "pi-native-jsonl-v3") return false;
    this.bindings.set(record.id, binding);
    try { this.source.validate(binding); return true; } catch { this.source.revoke(binding); return false; }
  }

  async hasSourceClaim(record: SessionRecord): Promise<boolean> {
    return this.index.hasClaim ? this.index.hasClaim(record.id) : (await this.index.binding(record.id)) !== null;
  }

  async cwdIdentity(record: SessionRecord) {
    return await this.allows(record) ? this.bindings.get(record.id)! : null;
  }
}
