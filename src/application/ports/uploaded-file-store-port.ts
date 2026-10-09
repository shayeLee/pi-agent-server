// Durable metadata for uploaded non-image files. File contents are never deleted by this store.

export const UPLOADED_FILE_STATUSES = ["uploading", "ready"] as const;
export type UploadedFileStatus = (typeof UPLOADED_FILE_STATUSES)[number];

export interface UploadedFileRecord {
  fileId: string;
  ownerKey: string;
  projectId: string;
  uploadKey: string;
  name: string;
  mediaType: string;
  size: number;
  checksum: string;
  storageKey: string;
  agentPath: string;
  status: UploadedFileStatus;
  createdAt: number;
  sessionId: string | null;
}

/** Immutable content/storage metadata supplied when an upload key is reserved. */
export interface ReserveUploadedFileInput {
  ownerKey: string;
  projectId: string;
  uploadKey: string;
  name: string;
  mediaType: string;
  size: number;
  checksum: string;
  storageKey: string;
  agentPath: string;
  createdAt?: number;
}

export interface ClaimUploadedFilesInput {
  ownerKey: string;
  projectId: string;
  sessionId: string;
  fileIds: readonly string[];
}

export interface UploadedFileQuotaLimits {
  ownerMaxBytes: number;
  globalMaxBytes: number;
}

export interface UploadedFileStorePort {
  /**
   * Atomically reserve the owner/project-scoped upload key in `uploading` state.
   * Retries with the same size and checksum return the canonical existing row (including its
   * storage paths); a different payload for that key throws UploadedFileConflictError. When quota
   * limits are provided, all uploading/ready metadata counts toward owner and global byte limits.
   */
  reserve(input: ReserveUploadedFileInput, quotaLimits?: UploadedFileQuotaLimits): Promise<UploadedFileRecord>;
  findById(fileId: string): Promise<UploadedFileRecord | null>;
  findByUploadKey(ownerKey: string, projectId: string, uploadKey: string): Promise<UploadedFileRecord | null>;
  /** Idempotently transition an existing reservation to ready; missing IDs are rejected. */
  completeReady(fileId: string): Promise<UploadedFileRecord>;
  /** Create a ready row directly; duplicate same-payload keys return their existing status unchanged. */
  createReady(input: ReserveUploadedFileInput): Promise<UploadedFileRecord>;
  /**
   * Atomically bind a complete ready-file batch to a session. Existing rows bound to the same
   * session are idempotent; any missing, foreign, unready, or differently-bound row rejects the
   * whole batch without updating any row.
   */
  claimBatch(input: ClaimUploadedFilesInput): Promise<UploadedFileRecord[]>;
}

export class UploadedFileConflictError extends Error {
  constructor(message = "upload key is already reserved for a different payload") {
    super(message);
    this.name = "UploadedFileConflictError";
  }
}

export class UploadedFileQuotaError extends Error {
  constructor(readonly scope: "owner" | "global") {
    super(`uploaded file ${scope} quota exceeded`);
    this.name = "UploadedFileQuotaError";
  }
}

export class UploadedFileClaimError extends Error {
  constructor(message = "uploaded file batch cannot be claimed") {
    super(message);
    this.name = "UploadedFileClaimError";
  }
}

export class UploadedFileNotFoundError extends Error {
  constructor(fileId: string) {
    super(`uploaded file '${fileId}' was not found`);
    this.name = "UploadedFileNotFoundError";
  }
}
