import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Metadata only: never hash/read source business payloads for verification. */
export function sqliteSourceMetadata(dbFile: string): string {
  return JSON.stringify(["", "-wal", "-shm"].map((suffix) => {
    try {
      const s = statSync(`${dbFile}${suffix}`, { bigint: true });
      return [suffix, String(s.dev), String(s.ino), String(s.size), String(s.mtimeNs), String(s.ctimeNs)];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [suffix, "absent"];
      throw error;
    }
  }));
}

/** Copies DB + WAL + SHM without ever opening the source with SQLite.
 * Fail closed if a live writer changes source metadata during copying/inspection.
 * This is a bounded stable-file snapshot, not a substitute for an offline backup.
 */
export async function withSqliteReadonlySnapshot<T>(dbFile: string, inspect: (db: DatabaseSync) => Promise<T>, temporaryRoot = tmpdir()): Promise<T> {
  const before = sqliteSourceMetadata(dbFile);
  const directory = mkdtempSync(path.join(temporaryRoot, "pi-init-readonly-"));
  let db: DatabaseSync | undefined;
  try {
    const copy = path.join(directory, "snapshot.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${dbFile}${suffix}`)) copyFileSync(`${dbFile}${suffix}`, `${copy}${suffix}`);
    }
    if (before !== sqliteSourceMetadata(dbFile)) throw new Error("SQLite source changed during snapshot; inspection refused");
    db = new DatabaseSync(copy, { readOnly: true, timeout: 5000, enableForeignKeyConstraints: true });
    return await inspect(db);
  } finally {
    try { db?.close(); }
    finally {
      rmSync(directory, { recursive: true, force: true });
      if (before !== sqliteSourceMetadata(dbFile)) throw new Error("SQLite source metadata changed during inspection; result not accepted");
    }
  }
}
