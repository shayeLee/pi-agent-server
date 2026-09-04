import { FILE_OPERATION_STATES } from "../application/ports/file-operation-store-port.js";
import { assertWhitelistedRelativePath, isRedactedFileOperationError } from "../storage/file-operation-policy.js";

function fail(message: string): never {
  throw new Error(`restore: ${message}`);
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = typeof value === "number"
    ? value
    : typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 0) fail(`restored file_operations ${field} is malformed`);
  return number;
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : nonNegativeInteger(value, field);
}

function nullableString(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== "string") fail(`restored file_operations ${field} is malformed`);
  return value as string | null;
}

/** Validate every outbox row before a restore is reported successful. */
export function validateRestoredFileOperations(rows: readonly Record<string, unknown>[]): number {
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || row.id.length === 0 ||
        typeof row.operation_key !== "string" || row.operation_key.trim() === "" || row.operation_key.length > 1024 ||
        row.kind !== "delete") {
      fail("restored file_operations row is malformed");
    }
    try {
      assertWhitelistedRelativePath(row.relative_path as string);
    } catch {
      fail("restored file_operations relative_path is outside the JSONL whitelist");
    }
    for (const [field, value] of [["session_id", row.session_id], ["project_id", row.project_id]] as const) {
      if (value !== null && typeof value !== "string") fail(`restored file_operations ${field} is malformed`);
    }
    if (typeof row.state !== "string" || !(FILE_OPERATION_STATES as readonly string[]).includes(row.state)) {
      fail("restored file_operations state is malformed");
    }
    const attemptCount = nonNegativeInteger(row.attempt_count, "attempt_count");
    nonNegativeInteger(row.available_at, "available_at");
    const leaseUntil = nullableInteger(row.lease_until, "lease_until");
    const leaseToken = nullableString(row.lease_token, "lease_token");
    const lastError = nullableString(row.last_error, "last_error");
    if (lastError !== null && !isRedactedFileOperationError(lastError)) {
      fail("restored file_operations last_error is not a canonical redacted error or exceeds 1000 bytes");
    }
    nonNegativeInteger(row.created_at, "created_at");
    nonNegativeInteger(row.updated_at, "updated_at");

    // A processing row is owned only by a row-local lease.  All terminal and
    // available states must have no lease, so a stale worker cannot act on a
    // row that has already been returned to the queue or completed.
    if (row.state === "processing") {
      if (leaseUntil === null || leaseToken === null || leaseToken.trim() === "" || attemptCount < 1) {
        fail("restored processing file_operations row has no valid lease");
      }
    } else if (leaseUntil !== null || leaseToken !== null) {
      fail("restored non-processing file_operations row retains a lease");
    }
  }
  return rows.length;
}
