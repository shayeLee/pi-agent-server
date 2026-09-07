// file_operations 的路径与错误安全边界（WP4A）。
// outbox 只保存 DATA_DIR 下的相对 JSONL 路径；绝不把任意绝对路径交给未来 worker。

import { createHash } from "node:crypto";
import path from "node:path";
import { FILE_OPERATION_KINDS, type FileOperationKind } from "../application/ports/file-operation-store-port.js";

export class FileOperationPathError extends Error {
  constructor(message = "file operation path is outside the relative JSONL whitelist") {
    super(message);
    this.name = "FileOperationPathError";
  }
}

export class FileOperationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileOperationStateError";
  }
}

/**
 * 仅允许备份使用的两种会话布局：
 *   sessions/<session-id>/<file>.jsonl
 *   projects/<project-id>/sessions/<session-id>/<file>.jsonl
 *
 * 使用 POSIX 分隔符存库，即使服务运行在 Windows 也不会让反斜杠成为
 * 绕过 `..` 检查的第二种路径语法。
 */
export function assertWhitelistedRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new FileOperationPathError();
  }
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.includes("\u0000")
  ) {
    throw new FileOperationPathError();
  }

  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new FileOperationPathError();
  }
  const isDefaultSession = parts[0] === "sessions" && parts.length === 3;
  const isProjectSession = parts[0] === "projects" && parts[2] === "sessions" && parts.length === 5;
  if ((!isDefaultSession && !isProjectSession) || !parts.at(-1)!.endsWith(".jsonl")) {
    throw new FileOperationPathError();
  }
  return value;
}

/** 从绝对 JSONL 文件路径生成相对 DATA_DIR 路径，并执行相同白名单校验。 */
export function relativeWhitelistedPath(dataDir: string, filePath: string): string {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw new FileOperationPathError();
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    return assertWhitelistedRelativePath(filePath);
  }
  const relative = path.relative(path.resolve(dataDir), path.resolve(filePath)).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new FileOperationPathError();
  }
  return assertWhitelistedRelativePath(relative);
}

export function assertFileOperationKind(value: string): asserts value is FileOperationKind {
  if (!(FILE_OPERATION_KINDS as readonly string[]).includes(value)) {
    throw new FileOperationStateError("unsupported file operation kind");
  }
}

/**
 * Bounded, stable path segment for an operation key.  Long segments are hashed
 * instead of truncated so the same value always maps to the same digest while
 * the whole key stays within the outbox's 1024-character limit.
 */
function boundedKeyPart(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Stable, session-independent business key for a delete over a single artifact.
 * Derived only from agent kind + conversation format + whitelisted relative
 * path, so the same artifact always maps to the same outbox row no matter which
 * session row currently references it.  Omitting the session id is what makes
 * the row a durable tombstone: once a session (or a failed creation) enqueues a
 * delete for a path, a later reservation that would reuse that path is rejected
 * by the same key, whatever state the outbox row reached.
 */
export function artifactDeleteOperationKey(
  agentKind: string,
  conversationFormat: string,
  relativePath: string,
): string {
  if (typeof agentKind !== "string" || agentKind.trim() === "") {
    throw new Error("file operation artifact agent kind must be non-empty");
  }
  if (typeof conversationFormat !== "string" || conversationFormat.trim() === "") {
    throw new Error("file operation artifact conversation format must be non-empty");
  }
  const normalizedPath = assertWhitelistedRelativePath(relativePath);
  const kindPart = boundedKeyPart(agentKind, 400);
  const formatPart = boundedKeyPart(conversationFormat, 400);
  const pathDigest = createHash("sha256").update(normalizedPath, "utf8").digest("hex");
  return `delete-artifact:${kindPart}:${formatPart}:${pathDigest}`;
}

/**
 * Legacy session-scoped delete key.  The Pi cleanup plan now uses the
 * artifact-based {@link artifactDeleteOperationKey}; this remains exported for
 * callers that still want a session-scoped idempotency key.
 */
export function sessionDeleteOperationKey(sessionId: string, relativePath: string): string {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new Error("file operation session id must be non-empty");
  }
  const normalizedPath = assertWhitelistedRelativePath(relativePath);
  const sessionPart = sessionId.length <= 900
    ? sessionId
    : createHash("sha256").update(sessionId, "utf8").digest("hex");
  const pathDigest = createHash("sha256").update(normalizedPath, "utf8").digest("hex");
  return `delete-session:${sessionPart}:${pathDigest}`;
}

/** A persisted error is trusted only when redacting it is an idempotent no-op. */
export function isRedactedFileOperationError(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= 1000 && redactFileOperationError(value) === value;
}

/**
 * WP4B error policy：持久化 last_error 只允许固定、有限的 canonical error code。
 * 未知/相对路径/credential= 等任何非 allowlist 值一律只按 unsafeErrors 计数，
 * 绝不成为报告 key；仓库读取与 restore 校验对不合规值 fail-closed。
 */
export const FILE_OPERATION_FAILED_ERROR_CODE = "file operation failed";

export const FILE_OPERATION_ERROR_CODE_ALLOWLIST: readonly string[] = [
  // 通用回退码：任何无法归类的错误（redaction 后仍非 canonical code）都落到它。
  FILE_OPERATION_FAILED_ERROR_CODE,
  // 路径白名单拒绝（WP4A FileOperationPathError 默认消息）。
  "file operation path is outside the relative JSONL whitelist",
  // 不受支持的 operation kind（WP4A assertFileOperationKind）。
  "unsupported file operation kind",
  // 非法状态（repository state() 校验）。
  "file operation state is invalid",
] as const;

export function isFileOperationErrorCodeAllowlisted(value: string): boolean {
  return (FILE_OPERATION_ERROR_CODE_ALLOWLIST as readonly string[]).includes(value);
}

/**
 * 持久化/报告的 canonical code 映射：先按 WP4A 规则脱敏，再要求 allowlist 成员。
 * 未知/相对路径/credential= 等一律落到 FILE_OPERATION_FAILED_ERROR_CODE。
 */
export function canonicalFileOperationErrorCode(error: unknown): string {
  const candidate = redactFileOperationError(error);
  return isFileOperationErrorCodeAllowlisted(candidate) ? candidate : FILE_OPERATION_FAILED_ERROR_CODE;
}

/**
 * 持久化错误只保留有限长度的可诊断摘要，并移除 URL、token、凭证赋值和
 * 绝对路径。原始异常只能留在进程内，不能进入 outbox 或 HTTP 响应。
 */
const SECRET_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "PI_AUTH_TOKEN",
  "PGPASSWORD",
  "PGPASSFILE",
] as const;

function configuredSecretValues(): string[] {
  return SECRET_ENV_NAMES
    .map((name) => process.env[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end--;
  return value.slice(0, end);
}

export function redactFileOperationError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);

  // Redact values that are present in the process environment even when a
  // child/library emits the value without its variable name.  Longest first
  // prevents a shorter configured value from exposing a suffix of a longer one.
  for (const value of configuredSecretValues()) message = message.split(value).join("[redacted]");

  // Cover complete secret environment variable names.  The leading boundary
  // matters: matching only `PASSWORD` would miss `PGPASSWORD`, and matching
  // only `API_KEY` would miss `OPENAI_API_KEY` because `_` is a word char.
  message = message.replace(/(\b(?:OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|PGPASSWORD|[A-Z][A-Z0-9]*(?:_(?:API_KEY|SECRET(?:_ACCESS_KEY)?|PASSWORD|PASSWD|TOKEN|ACCESS_KEY_ID|PRIVATE_KEY)))\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)]*)/gi, "$1[redacted]");
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[redacted database URL]");
  message = message.replace(/AGE-SECRET-KEY-[A-Za-z0-9]+/g, "[redacted age identity]");
  message = message.replace(/(\b(?:authorization\s*:\s*bearer|bearer)\s+)(?:\[[^\]]+\]|[^\s,;]+)/gi, "$1[redacted token]");
  message = message.replace(/(\b(?:token|access[_-]?token|refresh[_-]?token|api[_-]?(?:key|token)|secret[_-]?(?:key|token)|password|passwd|pwd)\s*[=:]\s*)[\S]+/gi, "$1[redacted]");
  message = message.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]");
  // Do not persist workstation roots, home directories, or arbitrary absolute
  // paths.  The boundary is deliberately platform-neutral: errors can be
  // produced by a worker running on another OS, and a path such as
  // /workspace or C:\\work must not survive merely because it is not one of
  // this machine's well-known roots.  UNC paths are covered as well.
  message = message.replace(/(?:[A-Za-z]:[\\/][^\s,;)]*|\\\\[^\s,;)]*|(?<![A-Za-z0-9_])\/(?!\/)[^\s,;)]*)/g, "[redacted path]");
  message = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!message) message = "file operation failed";
  return truncateUtf8(message, 1000);
}
