// Exact, opaque original-byte binding for encrypted backup packages. No cleanup of server originals.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { stableSerialize } from "../storage/migration-manifest.js";
import type { BackupFileRecord, PlannedSourceFile } from "./backup-core.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const MAX_BYTES = 20 * 1024 * 1024;

export interface UploadedSnapshotRow {
  id: string; owner_key: string; project_id: string; upload_key: string; name: string;
  media_type: string; size: number; checksum: string; storage_key: string;
  agent_path: string; status: "ready" | "uploading"; created_at: number; session_id: string | null;
}
export interface AttachmentManifestEntry {
  fileId: string;
  storageKey: string;
  size: number;
  sha256: string;
  status: "ready" | "uploading";
  /** Authenticates every DB column, including owner/project and null session association. */
  rowSha256: string;
}

function invalid(message: string): never { throw new Error(`attachment payload: ${message}`); }
function safeId(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function safePath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") &&
    path.normalize(value) === value && !value.split(path.sep).includes("..");
}

export function snapshotUploadedRows(raw: readonly Record<string, unknown>[]): UploadedSnapshotRow[] {
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const rows = raw.map((row): UploadedSnapshotRow => {
    const size = typeof row.size === "string" && /^\d+$/.test(row.size) ? Number(row.size) : row.size;
    const created = typeof row.created_at === "string" && /^\d+$/.test(row.created_at) ? Number(row.created_at) : row.created_at;
    if (!safeId(row.id) || !safeId(row.project_id) || !safeId(row.storage_key) ||
      (row.session_id !== null && !safeId(row.session_id)) ||
      ![row.owner_key, row.upload_key, row.name, row.media_type].every((value) => typeof value === "string" && value.length > 0) ||
      !Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > MAX_BYTES ||
      !Number.isSafeInteger(created) || (created as number) < 0 ||
      typeof row.checksum !== "string" || !SHA.test(row.checksum) || !safePath(row.agent_path) ||
      path.basename(row.agent_path as string) !== row.storage_key ||
      (row.status !== "ready" && row.status !== "uploading")) invalid("invalid uploaded_files metadata");
    if (seenIds.has(row.id) || seenKeys.has(row.storage_key)) invalid("duplicate file or storage key");
    seenIds.add(row.id); seenKeys.add(row.storage_key);
    return {
      id: row.id, owner_key: row.owner_key as string, project_id: row.project_id, upload_key: row.upload_key as string,
      name: row.name as string, media_type: row.media_type as string, size: size as number,
      checksum: row.checksum, storage_key: row.storage_key, agent_path: row.agent_path as string,
      status: row.status, created_at: created as number, session_id: row.session_id as string | null,
    };
  });
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function attachmentEntries(rows: readonly UploadedSnapshotRow[]): AttachmentManifestEntry[] {
  return rows.map((row) => ({ fileId: row.id, storageKey: row.storage_key, size: row.size,
    sha256: row.checksum, status: row.status,
    rowSha256: createHash("sha256").update(stableSerialize(row)).digest("hex") }));
}

/** One private source root; a symlink or hardlink can never become an authenticated blob. */
export function verifyAttachmentBlob(root: string, entry: AttachmentManifestEntry): string {
  if (!safePath(root) || !safeId(entry.storageKey)) invalid("unsafe attachment storage root or key");
  const canonicalRoot = realpathSync(root);
  const rootStat = lstatSync(root);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || canonicalRoot !== root || (rootStat.mode & 0o077) !== 0 ||
    (uid !== undefined && rootStat.uid !== uid)) invalid("attachment storage root is unsafe");
  const file = path.join(root, entry.storageKey);
  const leaf = lstatSync(file);
  if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink !== 1 || (leaf.mode & 0o077) !== 0 || leaf.size !== entry.size ||
    (uid !== undefined && leaf.uid !== uid)) invalid("attachment original is missing or unsafe");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== leaf.dev || before.ino !== leaf.ino || before.size !== entry.size) invalid("attachment original changed");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < entry.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, entry.size - offset), offset);
      if (count <= 0) invalid("attachment original is incomplete");
      hash.update(chunk.subarray(0, count)); offset += count;
    }
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || hash.digest("hex") !== entry.sha256) invalid("attachment original digest differs from snapshot");
  } finally { closeSync(fd); }
  return file;
}

export function planAttachmentPayloads(root: string, rows: readonly UploadedSnapshotRow[]): { entries: AttachmentManifestEntry[]; plans: PlannedSourceFile[] } {
  const entries = attachmentEntries(rows);
  const plans = entries.map((entry): PlannedSourceFile => ({
    sourcePath: verifyAttachmentBlob(root, entry), relativePath: `attachments/${entry.storageKey}`, kind: "attachment",
  }));
  return { entries, plans };
}

export function validateAttachmentSet(
  format: string,
  entries: readonly AttachmentManifestEntry[] | undefined,
  rows: readonly UploadedSnapshotRow[],
  files: readonly BackupFileRecord[],
): void {
  if (format === "pi-agent-server.backup-manifest.v1") {
    if (entries !== undefined || rows.length !== 0 || files.some((f) => f.kind === "attachment")) invalid("legacy package has unbundled attachment metadata");
    return;
  }
  if (format !== "pi-agent-server.backup-manifest.v2" || !Array.isArray(entries) || entries.length === 0) invalid("v2 attachment manifest is missing");
  const expected = attachmentEntries(rows);
  if (stableSerialize(entries) !== stableSerialize(expected)) invalid("attachment manifest does not match exact uploaded_files snapshot");
  const records = files.filter((f) => f.kind === "attachment");
  if (records.length !== entries.length) invalid("attachment payload set is incomplete");
  for (const entry of entries) {
    if (!safeId(entry.fileId) || !safeId(entry.storageKey) || !SHA.test(entry.sha256) || !SHA.test(entry.rowSha256)) invalid("attachment manifest entry is malformed");
    const record = records.find((f) => f.path === `payload/attachments/${entry.storageKey}.age`);
    if (!record || record.size !== entry.size || record.sha256 !== entry.sha256) invalid("attachment payload differs from database metadata");
  }
}
