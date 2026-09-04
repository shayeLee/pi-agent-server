// Serialize writes issued through the synchronous node:sqlite adapter within
// one process.  BEGIN IMMEDIATE still protects against other processes, but
// without this queue a second DatabaseSync connection can block the event loop
// while the first transaction is paused at an async Kysely boundary.

const locks = new WeakMap<object, Promise<void>>();
const lockKeys = new WeakMap<object, object>();
const filenameKeys = new Map<string, object>();

/** Return a shared process-local key for all handles opened on one SQLite file. */
export function sqliteWriteLockKeyForFilename(filename: string): object {
  const existing = filenameKeys.get(filename);
  if (existing) return existing;
  const key = {};
  filenameKeys.set(filename, key);
  return key;
}

/** Bind all Kysely handles over one DatabaseSync to one in-process queue. */
export function registerSqliteWriteLockKey(database: object, key: object): void {
  lockKeys.set(database, key);
}

export async function withSqliteWriteLock<T>(database: object, action: () => Promise<T>): Promise<T> {
  const key = lockKeys.get(database) ?? database;
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}
