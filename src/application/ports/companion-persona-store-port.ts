// The blank-session companion's persona (DESIGN.md §6.6): one row per caller, so the name,
// voice and docked state follow them across browsers and devices.
import type { CompanionPersonaRecord } from "../../shared/companion.js";

export interface CompanionPersonaStorePort {
  /** The caller's saved persona; `null` before the first save. */
  get(ownerKey: string): Promise<CompanionPersonaRecord | null>;
  /** Replaces the caller's persona. */
  put(ownerKey: string, persona: CompanionPersonaRecord, updatedAt: number): Promise<void>;
}
