import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readSync,
  writeSync,
  fsyncSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import {
  ATTACHMENT_MAX_BYTES,
  validateAttachment,
  type AttachmentInput,
  type AttachmentKind,
  type AttachmentValidationFailure,
} from "./file-policy.js";

export interface AttachmentStorageConfig {
  /** Explicit server-side private storage directory. There is deliberately no default. */
  readonly storageRoot: string;
  /** Explicit agent-side path mapping; this module does not assume a mount exists. */
  readonly agentVisibleRoot: string;
}

export interface ExpectedAttachmentDigest {
  readonly size: number;
  readonly sha256: string;
}

export type AttachmentReadExactResult =
  | {
      readonly status: "verified";
      readonly storageKey: string;
      readonly bytes: Buffer;
      readonly size: number;
      readonly sha256: string;
      readonly storedPath: string;
      readonly agentPath: string;
    }
  | {
      readonly status: "missing";
      readonly storageKey: string;
    }
  | {
      readonly status: "unrecoverable";
      readonly code: "INTEGRITY_MISMATCH" | "UNSAFE_FILE";
      readonly storageKey: string;
      readonly actualSize?: number;
      readonly message: string;
    }
  | {
      readonly status: "failed";
      readonly code: "STORAGE_FAILED";
      readonly message: string;
    };

export type AttachmentWriteResult =
  | {
      /** Newly created and fully written. Caller must still complete the upload record. */
      readonly status: "written";
      readonly storageKey: string;
      readonly kind: AttachmentKind;
      readonly size: number;
      readonly sha256: string;
      readonly storedPath: string;
      readonly agentPath: string;
    }
  | {
      /** Idempotent retry: existing bytes were verified against the expected size and digest. */
      readonly status: "already-written";
      readonly storageKey: string;
      readonly kind: AttachmentKind;
      readonly size: number;
      readonly sha256: string;
      readonly storedPath: string;
      readonly agentPath: string;
    }
  | {
      readonly status: "rejected";
      readonly validation: AttachmentValidationFailure;
    }
  | {
      /** Existing or partial bytes are not replaced or removed. Caller must allocate a new key. */
      readonly status: "unrecoverable";
      readonly code: "INTEGRITY_MISMATCH" | "WRITE_INCOMPLETE" | "UNSAFE_FILE";
      readonly storageKey: string;
      readonly actualSize?: number;
      readonly message: string;
    }
  | {
      readonly status: "failed";
      readonly code: "STORAGE_FAILED";
      readonly message: string;
    };

interface ResolvedPaths {
  readonly storageRoot: string;
  readonly agentVisibleRoot: string;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isPrivateDirectory(stat: Stats): boolean {
  const uid = currentUid();
  return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && (uid === undefined || stat.uid === uid);
}

function assertSafeRoot(root: string, create: boolean): string {
  if (!root || !path.isAbsolute(root) || root.includes("\0")) throw new Error("invalid storage root");
  const absolute = path.resolve(root);
  if (absolute === path.parse(absolute).root) throw new Error("storage root cannot be a filesystem root");

  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]!);
    let stat: Stats | undefined;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && index === components.length - 1 && create) {
        mkdirSync(current, { mode: 0o700 });
        stat = lstatSync(current);
      } else {
        throw error;
      }
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("storage path contains a non-directory or symbolic link");
    if (index === components.length - 1) {
      if (!isPrivateDirectory(stat)) throw new Error("storage root must be a current-user private directory");
    } else if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      throw new Error("storage root has an unsafe writable ancestor");
    }
  }
  const canonical = realpathSync(absolute);
  if (canonical !== absolute) throw new Error("storage root must not use a symbolic-link alias");
  return canonical;
}

function resolvePaths(config: AttachmentStorageConfig, createRoot: boolean): ResolvedPaths {
  if (!config || typeof config.storageRoot !== "string" || typeof config.agentVisibleRoot !== "string"
    || !config.agentVisibleRoot || !path.isAbsolute(config.agentVisibleRoot) || config.agentVisibleRoot.includes("\0")) {
    throw new Error("both roots must be explicitly configured as absolute paths");
  }
  return {
    storageRoot: assertSafeRoot(config.storageRoot, createRoot),
    agentVisibleRoot: path.resolve(config.agentVisibleRoot),
  };
}

function recheckPrivateRoot(root: string): void {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !isPrivateDirectory(stat) || realpathSync(root) !== root) {
    throw new Error("storage root changed or is not private");
  }
}

function isValidStorageKey(storageKey: string): boolean {
  // The caller supplies an opaque random key; the allowlist makes it a single safe path component.
  return typeof storageKey === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(storageKey);
}

function isValidExpected(expected: ExpectedAttachmentDigest): boolean {
  return Number.isSafeInteger(expected.size) && expected.size >= 0 && expected.size <= ATTACHMENT_MAX_BYTES
    && /^[a-f0-9]{64}$/u.test(expected.sha256);
}

function fixedFailure(message: string): AttachmentReadExactResult {
  return { status: "failed", code: "STORAGE_FAILED", message };
}

/** Read only a regular, single-link file and return bytes iff size and SHA-256 both match. */
export function readExactAttachment(
  config: AttachmentStorageConfig,
  storageKey: string,
  expected: ExpectedAttachmentDigest,
): AttachmentReadExactResult {
  if (!isValidStorageKey(storageKey) || !expected || !isValidExpected(expected)) {
    return fixedFailure("Attachment key or expected digest is invalid.");
  }
  let paths: ResolvedPaths;
  try {
    paths = resolvePaths(config, false);
    recheckPrivateRoot(paths.storageRoot);
  } catch {
    return fixedFailure("Attachment storage is not safely configured.");
  }

  const file = path.join(paths.storageRoot, storageKey);
  let fd: number | undefined;
  try {
    let beforePath: ReturnType<typeof lstatSync>;
    try {
      beforePath = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", storageKey };
      return { status: "unrecoverable", code: "UNSAFE_FILE", storageKey, message: "Existing attachment cannot be safely inspected." };
    }
    if (beforePath.isSymbolicLink() || !beforePath.isFile() || beforePath.nlink !== 1
      || (beforePath.mode & 0o077) !== 0 || (currentUid() !== undefined && beforePath.uid !== currentUid())) {
      return { status: "unrecoverable", code: "UNSAFE_FILE", storageKey, actualSize: beforePath.size, message: "Existing attachment is not a private regular file." };
    }
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino || before.nlink !== 1
      || (before.mode & 0o077) !== 0 || before.size !== expected.size) {
      return { status: "unrecoverable", code: "INTEGRITY_MISMATCH", storageKey, actualSize: before.size, message: "Existing attachment size or file identity does not match." };
    }
    const bytes = Buffer.allocUnsafe(expected.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return { status: "unrecoverable", code: "INTEGRITY_MISMATCH", storageKey, actualSize: offset, message: "Existing attachment is incomplete." };
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(fd, extra, 0, 1, expected.size) !== 0) {
      return { status: "unrecoverable", code: "INTEGRITY_MISMATCH", storageKey, message: "Existing attachment changed while being read." };
    }
    const after = fstatSync(fd);
    const afterPath = lstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1
      || afterPath.isSymbolicLink() || afterPath.dev !== before.dev || afterPath.ino !== before.ino) {
      return { status: "unrecoverable", code: "INTEGRITY_MISMATCH", storageKey, message: "Existing attachment changed while being read." };
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== expected.size || sha256 !== expected.sha256) {
      return { status: "unrecoverable", code: "INTEGRITY_MISMATCH", storageKey, actualSize: bytes.length, message: "Existing attachment digest or size does not match." };
    }
    return {
      status: "verified",
      storageKey,
      bytes,
      size: bytes.length,
      sha256,
      storedPath: file,
      agentPath: path.join(paths.agentVisibleRoot, storageKey),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", storageKey };
    return { status: "unrecoverable", code: "UNSAFE_FILE", storageKey, message: "Existing attachment cannot be safely read." };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* read-only descriptor */ }
    }
  }
}

/** Read-only recovery check used after reserve(uploading); never creates or modifies a file. */
export function verifyExisting(
  config: AttachmentStorageConfig,
  storageKey: string,
  size: number,
  sha256: string,
): AttachmentReadExactResult {
  return readExactAttachment(config, storageKey, { size, sha256 });
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (written <= 0) throw new Error("short write");
    offset += written;
  }
}

/**
 * Validate and create a file using the caller-reserved opaque key. O_EXCL ensures retries
 * never overwrite an existing file. Existing exact bytes are idempotently accepted; all
 * mismatches are reported as unrecoverable and left untouched for a new key to be used.
 */
export function writeAttachment(
  config: AttachmentStorageConfig,
  storageKey: string,
  input: AttachmentInput,
): AttachmentWriteResult {
  const validation = validateAttachment(input);
  if (!validation.ok) return { status: "rejected", validation };
  if (!isValidStorageKey(storageKey)) {
    return { status: "failed", code: "STORAGE_FAILED", message: "Caller-supplied storage key is invalid." };
  }

  let paths: ResolvedPaths;
  try {
    paths = resolvePaths(config, true);
    recheckPrivateRoot(paths.storageRoot);
  } catch {
    return { status: "failed", code: "STORAGE_FAILED", message: "Attachment storage is not safely configured." };
  }
  const expected = { size: validation.size, sha256: validation.sha256 };
  const file = path.join(paths.storageRoot, storageKey);
  const existing = verifyExisting(config, storageKey, expected.size, expected.sha256);
  if (existing.status === "verified") {
    return {
      status: "already-written", storageKey, kind: validation.kind, size: validation.size,
      sha256: validation.sha256, storedPath: existing.storedPath, agentPath: existing.agentPath,
    };
  }
  if (existing.status === "unrecoverable") return existing;
  if (existing.status === "failed") return existing;

  let fd: number | undefined;
  let created = false;
  try {
    recheckPrivateRoot(paths.storageRoot);
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const retry = verifyExisting(config, storageKey, expected.size, expected.sha256);
        if (retry.status === "verified") {
          return {
            status: "already-written", storageKey, kind: validation.kind, size: validation.size,
            sha256: validation.sha256, storedPath: retry.storedPath, agentPath: retry.agentPath,
          };
        }
        if (retry.status === "unrecoverable") return retry;
        return { status: "failed", code: "STORAGE_FAILED", message: "Attachment key was concurrently allocated." };
      }
      throw error;
    }
    writeAll(fd, validation.bytes);
    fsyncSync(fd);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== validation.size || (stat.mode & 0o077) !== 0) {
      throw new Error("post-write validation failed");
    }
    closeSync(fd);
    fd = undefined;
    const verification = verifyExisting(config, storageKey, expected.size, expected.sha256);
    if (verification.status !== "verified") {
      return {
        status: "unrecoverable",
        code: "WRITE_INCOMPLETE",
        storageKey,
        ...(verification.status === "unrecoverable" && verification.actualSize !== undefined ? { actualSize: verification.actualSize } : {}),
        message: "Written attachment did not pass exact size and digest verification; use a new upload key.",
      };
    }
    return {
      status: "written", storageKey, kind: validation.kind, size: validation.size,
      sha256: validation.sha256, storedPath: verification.storedPath, agentPath: verification.agentPath,
    };
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Preserve any partial file; cleanup is intentionally disabled. */ }
    }
    if (created) {
      return {
        status: "unrecoverable", code: "WRITE_INCOMPLETE", storageKey,
        message: "Attachment write failed after file creation; preserve it and use a new upload key.",
      };
    }
    return { status: "failed", code: "STORAGE_FAILED", message: "Attachment could not be written safely." };
  }
}
