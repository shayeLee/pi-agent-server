import { describe, expect, it } from "vitest";
import { validateRestoredFileOperations } from "../../src/backup/restore-validation.js";
import { redactFileOperationError } from "../../src/storage/file-operation-policy.js";

function row(last_error: string | null): Record<string, unknown> {
  return {
    id: "operation-1",
    operation_key: "delete-session:operation-1:hash",
    kind: "delete",
    relative_path: "sessions/s1/history.jsonl",
    session_id: "s1",
    project_id: "p1",
    state: "failed",
    attempt_count: 1,
    available_at: 10,
    lease_until: null,
    lease_token: null,
    last_error,
    created_at: 1,
    updated_at: 10,
  };
}

describe("restored file_operations validation", () => {
  it("accepts only a bounded, idempotently canonical redacted last_error", () => {
    const safe = redactFileOperationError(new Error("password=secret /private/worker/file.jsonl"));
    expect(validateRestoredFileOperations([row(safe)])).toBe(1);
    expect(() => validateRestoredFileOperations([row("password=secret")])).toThrow(/last_error/);
    expect(() => validateRestoredFileOperations([row("x".repeat(1001))])).toThrow(/last_error/);
  });
});
