import { describe, expect, it } from "vitest";
import { parseRestoreArgs, redactRestoreMessage } from "../../scripts/restore.js";

describe("offline restore CLI", () => {
  it("requires explicit restore paths and rejects relative paths", () => {
    expect(() => parseRestoreArgs([])).toThrow(/用法/);
    expect(() => parseRestoreArgs(["restore", "--input-backup", "/tmp/b", "--target-root", "/tmp/t"])).toThrow(/identity/);
    expect(() => parseRestoreArgs(["restore", "--input-backup", "relative", "--target-root", "/tmp/t", "--age-identity-file", "/tmp/i"])).toThrow(/绝对/);
    const pg = parseRestoreArgs(["restore", "--input-backup", "/tmp/b", "--target-root", "/tmp/t", "--age-identity-file", "/tmp/i", "--target-pg-url", "postgres://user:secret@example.test/pi_restore_x", "--dry-run"]);
    expect(pg.dryRun).toBe(true);
    expect(pg.targetPgUrl).toContain("postgres://");
    expect(() => parseRestoreArgs(["restore", "--input-backup", "/tmp/b", "--target-root", "/tmp/t", "--age-identity-file", "/tmp/i", "--target-pg-url", "postgres://user:secret@example.test/pi_restore_x", "--safety-token", "explicit-opt-in"])).toThrow(/未知参数/);
    expect(() => parseRestoreArgs(["restore", "--unknown", "secret-value"])).toThrowError(/未知参数/);
    try { parseRestoreArgs(["restore", "--unknown", "secret-value"]); } catch (error) { expect(String(error)).not.toContain("secret-value"); }
  });

  it("does not expose paths or database credentials in errors", () => {
    const secretUrl = "postgres://u:password@example.test/db";
    const message = redactRestoreMessage(new Error(`/private/user/source ${secretUrl}`), ["/private/user/source", "/private/user/identity"]);
    expect(message).not.toContain("/private/user/source");
    expect(message).not.toContain("password");
    expect(message).not.toContain(secretUrl);
  });
});
