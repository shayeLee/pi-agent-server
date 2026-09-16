// Session-scoped project file preview. Fixed public errors only: never expose paths or OS details.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const FILE_PREVIEW_MAX_BYTES = 256 * 1024;
export type FilePreviewErrorCode =
  | "FILE_PREVIEW_INVALID_PATH" | "FILE_PREVIEW_NOT_FOUND" | "FILE_PREVIEW_FORBIDDEN"
  | "FILE_PREVIEW_TOO_LARGE" | "FILE_PREVIEW_BINARY" | "FILE_PREVIEW_INVALID_UTF8" | "FILE_PREVIEW_INVALID_LINE";
export class FilePreviewError extends Error { constructor(readonly code: FilePreviewErrorCode) { super(code); } }
export type FilePreview = { path: string; content: string; lineCount: number; requestedLine?: number };
export type PreviewRoot = { readonly cwd: string; readonly dev: number; readonly ino: number };
type NodeIdentity = { readonly path: string; readonly dev: number; readonly ino: number };

// Explicit deny-list for project-local credential stores. This is a policy guard, not permission elevation:
// preview remains limited to the trusted, service-maintained project root of the owning session.
const sensitiveName = /^(?:\.env.*|auth(?:entication|orization)?(?:\..*)?|\.?npmrc|(?:\.?npm)?credentials?(?:\..*)?|.*(?:secret|credential|password|passwd|private[._-]?key|token|key|凭据|密钥|密码).*)$/iu;
const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
function reject(code: FilePreviewErrorCode): never { throw new FilePreviewError(code); }

function parseRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) reject("FILE_PREVIEW_INVALID_PATH");
  if (path.isAbsolute(value) || value.split(/[\\/]+/).some((part) => part === "" || part === "." || part === ".." || sensitiveName.test(part))) reject("FILE_PREVIEW_FORBIDDEN");
  return value.split(/[\\/]+/).join(path.sep);
}
function parseLine(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) reject("FILE_PREVIEW_INVALID_LINE");
  const line = Number(value);
  if (!Number.isSafeInteger(line)) reject("FILE_PREVIEW_INVALID_LINE");
  return line;
}
function sameNode(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean { return left.dev === right.dev && left.ino === right.ino; }

/** Snapshot a non-symlink directory or leaf path before it is used. */
function snapshotPath(file: string, kind: "directory" | "file" | "any"): NodeIdentity {
  const node = lstatSync(file);
  if (node.isSymbolicLink() || (kind === "directory" && !node.isDirectory()) || (kind === "file" && !node.isFile())) reject("FILE_PREVIEW_FORBIDDEN");
  return { path: file, dev: node.dev, ino: node.ino };
}
function stillSnapshot(snapshot: NodeIdentity, kind: "directory" | "file" | "any"): boolean {
  try {
    const now = lstatSync(snapshot.path);
    return !now.isSymbolicLink() && (kind !== "directory" || now.isDirectory()) && (kind !== "file" || now.isFile()) && sameNode(now, snapshot);
  } catch { return false; }
}

/**
 * Preview is for trusted, service-maintained local project directories on macOS and Linux. Node
 * has no portable openat(2)-style descriptor-relative walk, so this is deliberately not a claim
 * of strict TOCTOU/ABA isolation against a malicious concurrent local process. It rejects static
 * symlinks and checks root, ancestors and leaf identities before and after the descriptor read.
 */
export function previewProjectFile(rootIdentity: PreviewRoot, requestedPath: unknown, requestedLine: unknown): FilePreview {
  const relative = parseRelativePath(requestedPath);
  const line = parseLine(requestedLine);
  let rootFd: number | undefined;
  let fileFd: number | undefined;
  try {
    // Session creation stores realpath(cwd), so aliases such as macOS /var -> /private/var are
    // canonicalized once. Do not accept a later alias or redirect of that frozen spelling.
    const root = realpathSync(rootIdentity.cwd);
    if (root !== rootIdentity.cwd) reject("FILE_PREVIEW_FORBIDDEN");
    const rootSnapshot = snapshotPath(root, "directory");
    if (!sameNode(rootSnapshot, rootIdentity)) reject("FILE_PREVIEW_FORBIDDEN");
    rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const openedRoot = fstatSync(rootFd);
    if (!openedRoot.isDirectory() || !sameNode(openedRoot, rootSnapshot)) reject("FILE_PREVIEW_FORBIDDEN");

    const candidate = path.resolve(root, relative);
    if (!inside(root, candidate)) reject("FILE_PREVIEW_FORBIDDEN");
    const ancestors: NodeIdentity[] = [rootSnapshot];
    let cursor = root;
    const parts = relative.split(path.sep);
    for (const part of parts.slice(0, -1)) {
      cursor = path.join(cursor, part);
      ancestors.push(snapshotPath(cursor, "directory"));
    }
    // Snapshot any non-symlink leaf first, then use the nonblocking descriptor to prove it is a
    // regular file. In particular, a FIFO is opened O_NONBLOCK and rejected rather than waited on.
    const leaf = snapshotPath(candidate, "any");
    fileFd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const openedFile = fstatSync(fileFd);
    if (!openedFile.isFile() || !sameNode(openedFile, leaf)) reject("FILE_PREVIEW_FORBIDDEN");
    if (openedFile.size > FILE_PREVIEW_MAX_BYTES) reject("FILE_PREVIEW_TOO_LARGE");
    if (!ancestors.every((entry) => stillSnapshot(entry, "directory")) || !stillSnapshot(leaf, "any") || !sameNode(fstatSync(rootFd), openedRoot)) reject("FILE_PREVIEW_FORBIDDEN");

    // Always request one byte beyond the advertised cap: a file growing after fstat cannot evade it.
    const bytes = Buffer.allocUnsafe(FILE_PREVIEW_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fileFd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > FILE_PREVIEW_MAX_BYTES) reject("FILE_PREVIEW_TOO_LARGE");
    if (!ancestors.every((entry) => stillSnapshot(entry, "directory")) || !stillSnapshot(leaf, "any") || !sameNode(fstatSync(rootFd), openedRoot) || !sameNode(fstatSync(fileFd), openedFile)) reject("FILE_PREVIEW_FORBIDDEN");

    const contentBytes = bytes.subarray(0, length);
    if (contentBytes.includes(0)) reject("FILE_PREVIEW_BINARY");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes); } catch { reject("FILE_PREVIEW_INVALID_UTF8"); }
    const lineCount = content.split("\n").length;
    if (line !== undefined && line > lineCount) reject("FILE_PREVIEW_INVALID_LINE");
    return { path: relative.split(path.sep).join("/"), content, lineCount, ...(line === undefined ? {} : { requestedLine: line }) };
  } catch (error) {
    if (error instanceof FilePreviewError) throw error;
    reject("FILE_PREVIEW_NOT_FOUND");
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (rootFd !== undefined) closeSync(rootFd);
  }
  return reject("FILE_PREVIEW_NOT_FOUND");
}
