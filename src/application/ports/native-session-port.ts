import type { CanonicalCwdIdentity } from "../../core/native-session-policy.js";
import type { SessionRecord } from "./session-store-port.js";

/** Native authorization is independent of managed owner-key authorization. */
export interface NativeSessionPort {
  discoverProjects?(): Promise<void>;
  discover(project: { id: string; cwd: string }): Promise<readonly import("../../agent/native-session-source.js").NativeScanWarning[]>;
  allows(record: SessionRecord): Promise<boolean>;
  hasSourceClaim?(record: SessionRecord): Promise<boolean>;
  /** Prepare once, invoke synchronously before live/replay/heartbeat output. */
  outputGuard?(record: SessionRecord): Promise<() => boolean>;
  onRevoked?(listener: (sessionId: string) => void): () => void;
  cwdIdentity(record: SessionRecord): Promise<CanonicalCwdIdentity | null>;
}
