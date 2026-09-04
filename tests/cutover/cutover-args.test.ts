// WP2A cutover CLI 参数解析 / 授权门禁 / PG target schema 校验（纯逻辑，零 I/O）。
import { describe, expect, it } from "vitest";
import {
  authorizeCutover,
  CUTOVER_CONFIRM_TOKEN,
  CUTOVER_SCHEMA_PREFIX,
  CUTOVER_USAGE,
  parseCutoverArgs,
  validateCutoverTargetSchema,
  type CutoverCliOptions,
} from "../../src/cutover/cutover-core.js";

function validArgs(overrides: string[] = [], remove: string[] = []): string[] {
  const base = [
    "--apply",
    "--reset-rc-data",
    "--confirm-reset",
    CUTOVER_CONFIRM_TOKEN,
    "--maintenance-window",
    "CONFIRMED",
    "--backup-root",
    "/abs/backup-root",
    "--age-recipient-file",
    "/abs/recipient",
  ];
  return base.filter((arg, index) => {
    void index;
    return !remove.includes(arg);
  }).concat(overrides);
}

function parsed(args: string[]): CutoverCliOptions {
  return parseCutoverArgs(args);
}

describe("cutover CLI argument parsing（confirmation bypass / unknown args）", () => {
  it("accepts a fully confirmed apply command", () => {
    const cli = parsed(validArgs());
    expect(cli.mode).toBe("apply");
    expect(cli.resetRcData).toBe(true);
    expect(cli.confirmReset).toBe(CUTOVER_CONFIRM_TOKEN);
    expect(cli.maintenanceWindowConfirmed).toBe(true);
    expect(authorizeCutover(cli)).toBeDefined();
  });

  it("supports -- separated args and the dry-run mode with the same confirmation chain", () => {
    const cli = parseCutoverArgs(["--", "--dry-run", ...validArgs().slice(1)]);
    expect(cli.mode).toBe("dry-run");
    expect(() => authorizeCutover(cli)).not.toThrow();
  });

  it("rejects a missing --reset-rc-data (zero deletion without it)", () => {
    expect(() => parsed(validArgs([], ["--reset-rc-data"]))).toThrow(/reset-rc-data/);
  });

  it("rejects a wrong confirmation token (case-sensitive, no prefix match)", () => {
    for (const token of ["delete_rc_data", "DELETE_RC_DATA ", "CONFIRM", "YES", "DELETE_RC_DATA2", ""]) {
      expect(() => parsed(["--apply", "--reset-rc-data", "--confirm-reset", token, "--maintenance-window", "CONFIRMED", "--backup-root", "/abs/b", "--age-recipient-file", "/abs/r"]))
        .toThrow(/confirm-reset/);
    }
  });

  it("rejects a missing confirmation token", () => {
    expect(() => parsed(validArgs([], ["--confirm-reset"]))).toThrow();
  });

  it("rejects a maintenance window that is not exactly CONFIRMED", () => {
    expect(() => parsed(["--apply", "--reset-rc-data", "--confirm-reset", CUTOVER_CONFIRM_TOKEN, "--maintenance-window", "confirmed-but-not", "--backup-root", "/abs/b", "--age-recipient-file", "/abs/r"]))
      .toThrow(/maintenance-window/);
    expect(() => parsed(["--apply", "--reset-rc-data", "--confirm-reset", CUTOVER_CONFIRM_TOKEN, "--backup-root", "/abs/b", "--age-recipient-file", "/abs/r"]))
      .toThrow(/maintenance-window/);
  });

  it("rejects relative --backup-root / --age-recipient-file", () => {
    expect(() => parsed(["--apply", "--reset-rc-data", "--confirm-reset", CUTOVER_CONFIRM_TOKEN, "--maintenance-window", "CONFIRMED", "--backup-root", "relative/backups", "--age-recipient-file", "/abs/r"]))
      .toThrow(/绝对 --backup-root/);
    expect(() => parsed(["--apply", "--reset-rc-data", "--confirm-reset", CUTOVER_CONFIRM_TOKEN, "--maintenance-window", "CONFIRMED", "--backup-root", "/abs/b", "--age-recipient-file", "relative/recipient"]))
      .toThrow(/绝对 --age-recipient-file/);
  });

  it("rejects unknown arguments without echoing their value", () => {
    const secret = "SUPER-SECRET-TOKEN-VALUE";
    try {
      parsed(validArgs(["--token", secret]));
      throw new Error("expected unknown-argument rejection");
    } catch (error) {
      expect((error as Error).message).toContain("未知参数");
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toContain("用法");
    }
  });

  it("rejects duplicate modes and duplicate flags", () => {
    expect(() => parsed(["--apply", "--dry-run", ...validArgs().slice(1)])).toThrow();
    expect(() => parsed(validArgs(["--reset-rc-data"]))).toThrow(/reset-rc-data/);
    expect(() => parsed(validArgs(["--confirm-reset", CUTOVER_CONFIRM_TOKEN]))).toThrow(/confirm-reset/);
  });

  it("rejects invocations without a mode and carries no default", () => {
    expect(() => parsed(validArgs().slice(1))).toThrow();
    expect(CUTOVER_USAGE).toContain("--dry-run");
    expect(CUTOVER_USAGE).toContain("--apply");
  });
});

describe("cutover PG target schema validation（public reject / restore reject / random allowlisted only）", () => {
  it("accepts allowlisted pi_cutover_* schemas", () => {
    expect(validateCutoverTargetSchema(`${CUTOVER_SCHEMA_PREFIX}abc123`)).toBe(`${CUTOVER_SCHEMA_PREFIX}abc123`);
    expect(validateCutoverTargetSchema("pi_cutover_3f9c2a1b7d4e5f608192a3b4")).toBe("pi_cutover_3f9c2a1b7d4e5f608192a3b4");
  });

  it("rejects public and system schemas outright", () => {
    for (const schema of ["public", "PUBLIC", "information_schema", "pg_catalog", "pg_toast", "pg_temp_1"]) {
      expect(() => validateCutoverTargetSchema(schema)).toThrow(/never allowed|system/);
    }
  });

  it("rejects restore-drill schemas and non-allowlisted names", () => {
    expect(() => validateCutoverTargetSchema("pi_restore_tmp1")).toThrow(/pi_restore_/);
    for (const schema of ["app", "pi_app", "cutover", "pi_cutoverx", "migrations", "legacy_rc"]) {
      expect(() => validateCutoverTargetSchema(schema)).toThrow(/allowlist/i);
    }
  });

  it("rejects unsafe identifiers and whitespace-padded names", () => {
    for (const schema of ["", "  ", "pi_cutover a", 'pi_cutover"', "pi_cutover;drop", "1_pi_cutover"]) {
      expect(() => validateCutoverTargetSchema(schema)).toThrow();
    }
  });
});
