import { describe, expect, it } from "vitest";
import { validateRestoredFileOperations } from "../../src/backup/restore-validation.js";
import { FILE_OPERATION_ERROR_CODE_ALLOWLIST, redactFileOperationError } from "../../src/storage/file-operation-policy.js";

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

describe("restored file_operations validation（与 planner error policy 一致）", () => {
  it("只接受固定 allowlist 内的 canonical error code，且长度与脱敏特性由 allowlist 保证", () => {
    for (const code of FILE_OPERATION_ERROR_CODE_ALLOWLIST) {
      expect(validateRestoredFileOperations([row(code)])).toBe(1);
    }
  });

  it("对脱敏幂等但不在 allowlist 的自由文本 fail-closed（与 planner unsafeErrors 契约一致）", () => {
    // redaction 后幂等、≤1000 bytes，但不在固定 allowlist 内 → restore 拒绝。
    const redactedFreeText = redactFileOperationError(new Error("password=secret /private/worker/file.jsonl"));
    expect(() => validateRestoredFileOperations([row(redactedFreeText)])).toThrow(/last_error/);
    expect(() => validateRestoredFileOperations([row("sqlite error: database is locked")])).toThrow(/last_error/);
  });

  it("未知/相对路径/credential=/超长值一律 fail-closed，绝不进 restored 库", () => {
    expect(() => validateRestoredFileOperations([row("password=secret")])).toThrow(/last_error/);
    expect(() => validateRestoredFileOperations([row("credential=AKIAIOSFODNN7EXAMPLE")])).toThrow(/last_error/);
    expect(() => validateRestoredFileOperations([row("x".repeat(1001))])).toThrow(/last_error/);
    // 相对路径即使对 redaction 幂等也不合法。
    expect(() => validateRestoredFileOperations([row("sessions/s1/history.jsonl")])).toThrow(/last_error/);
  });
});
