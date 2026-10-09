import path from "node:path";
import { DEFAULT_PROJECT_ID } from "../application/ports/index.js";
import { canonicalCwdIdentity } from "../core/native-session-policy.js";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";
import type { NativeSourceBinding, NativeSourceCandidate } from "../agent/native-session-source.js";
import { withSqliteWriteLock } from "./sqlite-write-lock.js";
import { acquireTombstoneAdvisoryXactLock } from "./pg-advisory-lock.js";

/** Atomic, durable native source claims. A deleted claim is never reactivated. */
export class KyselyNativeSessionIndex {
  constructor(private readonly db: Kysely<DatabaseSchema>, private readonly dialect: "sqlite" | "postgres",
    private readonly options: { defaultProjectCwd?: string } = {}) {}

  async hasClaim(sessionId: string): Promise<boolean> {
    return !!(await this.db.selectFrom("native_session_sources").select("session_id").where("session_id", "=", sessionId).executeTakeFirst());
  }

  async binding(sessionId: string): Promise<NativeSourceBinding | null> {
    const row = await this.db.selectFrom("native_session_sources").select("binding").where("session_id", "=", sessionId).where("deleted", "=", 0).executeTakeFirst();
    if (!row) return null;
    try {
      const value = JSON.parse(row.binding) as NativeSourceBinding;
      if (typeof value.cwd !== "string" || typeof value.sourceId !== "string" || typeof value.sourcePath !== "string" ||
          ![value.dev, value.ino, value.sourceDev, value.sourceIno].every(Number.isFinite)) return null;
      return value;
    } catch { return null; }
  }

  async reservePrivate(projectId: string, binding: NativeSourceBinding, sessionId: string): Promise<void> {
    const action = () => this.db.transaction().execute(async tx => {
      if (this.dialect === "postgres") await acquireTombstoneAdvisoryXactLock(tx, "native-source-index");
      const session = await tx.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.visibility !== "private" || session.project_id !== projectId) throw new Error("private session unavailable");
      await tx.insertInto("native_session_sources").values({ source_path: binding.sourcePath, source_id: binding.sourceId,
        session_id: sessionId, project_id: projectId, binding: JSON.stringify({ ...binding, private: true }), deleted: 0 }).execute();
    });
    await (this.dialect === "sqlite" ? withSqliteWriteLock(this.db, action) : action());
  }

  async finalizePrivate(binding: NativeSourceBinding, sessionId: string): Promise<void> {
    const result = await this.db.updateTable("native_session_sources").set({ binding: JSON.stringify({ ...binding, private: true }) })
      .where("session_id", "=", sessionId).where("source_path", "=", binding.sourcePath).where("source_id", "=", binding.sourceId)
      .where("deleted", "=", 0).executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) throw new Error("private source reservation retired");
  }

  async retirePrivate(sessionId: string): Promise<void> {
    await this.db.updateTable("native_session_sources").set({ deleted: 1 }).where("session_id", "=", sessionId).execute();
  }

  async claimWorkspace(source: NativeSourceCandidate, sessionId: string, projectId: string): Promise<string | null> {
    return this.claim(projectId, source, sessionId, true);
  }

  async claim(projectId: string, source: NativeSourceCandidate, sessionId: string, workspace = false): Promise<string | null> {
    const action = () => this.db.transaction().execute(async tx => {
      const currentDefault = this.options.defaultProjectCwd && canonicalCwdIdentity(this.options.defaultProjectCwd).cwd;
      if (this.dialect === "postgres") {
        // Same lock/order as manual canonical project registration.
        if (workspace || currentDefault) await acquireTombstoneAdvisoryXactLock(tx, "canonical-project-cwd");
        await acquireTombstoneAdvisoryXactLock(tx, "native-source-index");
      }
      // A registered Web/private transcript at this path is never promoted by the
      // scanner. Required also when new Web files later share the native layout.
      if (await tx.selectFrom("sessions").select("id").where("conversation_ref", "=", source.binding.sourcePath)
        .where(eb => eb.or([eb("visibility", "=", "private"), eb("origin", "=", "managed")])).executeTakeFirst()) return null;
      const existing = await tx.selectFrom("native_session_sources").selectAll()
        .where(eb => eb.or([eb("source_path", "=", source.binding.sourcePath), eb("source_id", "=", source.binding.sourceId)])).executeTakeFirst();
      if (existing) {
        if (existing.deleted || JSON.parse(existing.binding).private === true || existing.source_path !== source.binding.sourcePath || existing.source_id !== source.binding.sourceId) return null;
        // Correct only shared native index metadata after a default-cwd change.
        // Private/managed records and original files are never migrated.
        const session = await tx.selectFrom("sessions").selectAll().where("id", "=", existing.session_id).executeTakeFirst();
        const defaultChanged = currentDefault &&
          ((existing.project_id === DEFAULT_PROJECT_ID && source.binding.cwd !== currentDefault) ||
           (existing.project_id !== DEFAULT_PROJECT_ID && source.binding.cwd === currentDefault));
        if (!defaultChanged || session?.visibility !== "shared" || session.origin !== "native" ||
            session.conversation_format !== "pi-native-jsonl-v3") return existing.session_id;
      }
      if (workspace || (currentDefault && projectId === DEFAULT_PROJECT_ID) || existing) {
        let existingProject: string | undefined;
        if (currentDefault === source.binding.cwd) existingProject = DEFAULT_PROJECT_ID;
        for (const project of await tx.selectFrom("projects").select(["id", "cwd"]).execute()) {
          if (existingProject || (currentDefault && project.id === DEFAULT_PROJECT_ID)) continue;
          try { if (canonicalCwdIdentity(project.cwd).cwd === source.binding.cwd) { existingProject = project.id; break; } } catch { /* stale cwd */ }
        }
        if (existingProject) projectId = existingProject;
        else {
          // System administrative ownership, never the first viewing actor. A
          // project is inserted only after private/tombstone claim checks, and
          // atomically with its first eligible shared session.
          if (projectId === DEFAULT_PROJECT_ID) throw new Error("historical native cwd requires an independent project id");
          await tx.insertInto("projects").values({ id: projectId, cwd: source.binding.cwd,
            name: path.basename(source.binding.cwd) || source.binding.cwd, owner_key: "",
            created_at: source.createdAt }).execute();
        }
      }
      if (!(await tx.selectFrom("projects").select("id").where("id", "=", projectId).executeTakeFirst())) return null;
      if (existing) {
        await tx.updateTable("native_session_sources").set({ project_id: projectId }).where("session_id", "=", existing.session_id).execute();
        await tx.updateTable("sessions").set({ project_id: projectId }).where("id", "=", existing.session_id).execute();
        return existing.session_id;
      }
      await tx.insertInto("native_session_sources").values({ source_path: source.binding.sourcePath, source_id: source.binding.sourceId,
        session_id: sessionId, project_id: projectId, binding: JSON.stringify(source.binding), deleted: 0 }).execute();
      await tx.insertInto("sessions").values({ id: sessionId, owner_key: "", project_id: projectId, title: "",
        visibility: "shared", origin: "native", created_at: source.createdAt, updated_at: source.updatedAt,
        agent_kind: "pi", conversation_format: "pi-native-jsonl-v3", conversation_ref: source.binding.sourcePath,
        model_provider: null, model_id: null, thinking_level: null, system_prompt: null, capability_versions: null }).execute();
      return sessionId;
    });
    return this.dialect === "sqlite" ? withSqliteWriteLock(this.db, action) : action();
  }
}
