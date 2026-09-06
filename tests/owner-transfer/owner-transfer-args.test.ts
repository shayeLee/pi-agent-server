// WP5D-4 owner-transfer CLI 参数解析（failclosed 契约）：
// 未知/重复/变体参数一律拒绝且不回显值；确认词与维护窗口逐字匹配；source/target IP
// 必须严格 canonical 且互不相同；dry-run 与 apply 要求同一套完整确认。
import { describe, expect, it } from "vitest";
import {
  OWNER_TRANSFER_CONFIRM_TOKEN,
  ownerKeyForIp,
  parseOwnerTransferArgs,
  subjectHashForIp,
  validateOwnerTransferSchema,
} from "../../src/owner-transfer/owner-transfer-core.js";

const RECIPIENT = "/tmp/recipient.txt";
const BACKUP_ROOT = "/tmp/backups";

function args(overrides: Record<string, string | boolean> = {}): string[] {
  const result: string[] = [];
  const push = (label: string, value: string): void => { result.push(label, value); };
  result.push(overrides.mode === "dry-run" ? "--dry-run" : "--apply");
  push("--source-ip", typeof overrides.sourceIp === "string" ? overrides.sourceIp : "10.1.2.3");
  push("--target-ip", typeof overrides.targetIp === "string" ? overrides.targetIp : "10.1.2.4");
  push("--confirm-transfer", overrides.confirmTransfer === false ? "transfer_ip_ownership" : OWNER_TRANSFER_CONFIRM_TOKEN);
  push("--maintenance-window", overrides.maintenanceWindow === false ? "confirmed" : "CONFIRMED");
  push("--backup-root", typeof overrides.backupRoot === "string" ? overrides.backupRoot : BACKUP_ROOT);
  push("--age-recipient-file", typeof overrides.ageRecipientFile === "string" ? overrides.ageRecipientFile : RECIPIENT);
  if (typeof overrides.targetSchema === "string") push("--target-schema", overrides.targetSchema);
  return result;
}

describe("owner-transfer CLI args (failclosed)", () => {
  it("accepts a complete apply mode with canonical IPs", () => {
    const cli = parseOwnerTransferArgs(args());
    expect(cli.mode).toBe("apply");
    expect(cli.sourceIp).toBe("10.1.2.3");
    expect(cli.targetIp).toBe("10.1.2.4");
    expect(cli.confirmTransfer).toBe(OWNER_TRANSFER_CONFIRM_TOKEN);
    expect(cli.maintenanceWindowConfirmed).toBe(true);
  });

  it("accepts dry-run with the same full confirmation chain", () => {
    const cli = parseOwnerTransferArgs(args({ mode: "dry-run" }));
    expect(cli.mode).toBe("dry-run");
  });

  it("accepts IPv6 canonical source/target and strips a leading -- marker", () => {
    const cli = parseOwnerTransferArgs([
      "--",
      ...args({ sourceIp: "2001:db8::1", targetIp: "2001:db8::2" }),
    ]);
    expect(cli.sourceIp).toBe("2001:db8::1");
    expect(cli.targetIp).toBe("2001:db8::2");
  });

  it("rejects missing or duplicated mode", () => {
    expect(() => parseOwnerTransferArgs(args().slice(1))).toThrow(/用法：/);
    expect(() => parseOwnerTransferArgs([...args(), "--dry-run"])).toThrow(/用法：/);
  });

  it("rejects unknown arguments without echoing their value", () => {
    expect(() => parseOwnerTransferArgs([...args(), "--unknown-flag"])).toThrow(/未知参数/);
    expect(() => parseOwnerTransferArgs(["POSITIONAL", ...args()])).toThrow(/未知参数/);
    expect(() => parseOwnerTransferArgs([...args(), "--source-ip", "10.9.9.9"])).toThrow(/只能出现一次/);
  });

  it("rejects duplicated flags", () => {
    expect(() => parseOwnerTransferArgs([...args(), "--backup-root", "/tmp/other"])).toThrow(/只能出现一次/);
    expect(() => parseOwnerTransferArgs([...args(), "--confirm-transfer", OWNER_TRANSFER_CONFIRM_TOKEN])).toThrow(/只能出现一次/);
  });

  it("rejects a wrong or variant confirmation token verbatim", () => {
    expect(() => parseOwnerTransferArgs(args({ confirmTransfer: false }))).toThrow(/必须为/);
  });

  it("rejects maintenance-window variants verbatim", () => {
    expect(() => parseOwnerTransferArgs(args({ maintenanceWindow: false }))).toThrow(/必须为 CONFIRMED/);
  });

  it("rejects source == target", () => {
    expect(() => parseOwnerTransferArgs(args({ targetIp: "10.1.2.3" }))).toThrow(/必须不同/);
  });

  it("rejects non-canonical or mapped IP forms (transfer subjects must be unambiguous canonical)", () => {
    for (const ip of ["1.2.3", "::ffff:10.1.2.3", "2001:0DB8::1", "010.001.002.003"]) {
      expect(() => parseOwnerTransferArgs(args({ sourceIp: ip }))).toThrow(/规范 canonical IP/);
      expect(() => parseOwnerTransferArgs(args({ targetIp: ip }))).toThrow(/规范 canonical IP/);
    }
  });

  it("rejects missing or relative paths", () => {
    expect(() => parseOwnerTransferArgs(args({ backupRoot: "" }))).toThrow();
    expect(() => parseOwnerTransferArgs(args({ backupRoot: "relative/backups" }))).toThrow(/绝对 --backup-root/);
    expect(() => parseOwnerTransferArgs(args({ ageRecipientFile: "" }))).toThrow();
    expect(() => parseOwnerTransferArgs(args({ ageRecipientFile: "relative/recipient.txt" }))).toThrow(/绝对 --age-recipient-file/);
  });

  it("accepts an optional PG --target-schema", () => {
    const cli = parseOwnerTransferArgs(args({ targetSchema: "business_schema" }));
    expect(cli.targetSchema).toBe("business_schema");
  });
});

describe("owner-transfer key derivation and schema validation", () => {
  it("derives owner keys as ip:<canonical IP> and subject hashes as a 16-hex prefix", () => {
    const owner = ownerKeyForIp("10.1.2.3");
    expect(owner).toBe("ip:10.1.2.3");
    expect(subjectHashForIp("10.1.2.3")).toMatch(/^[0-9a-f]{16}$/);
    // Distinct IPs produce distinct hashes; a hash never contains the raw IP.
    expect(subjectHashForIp("10.1.2.3")).not.toBe(subjectHashForIp("10.1.2.4"));
    expect(subjectHashForIp("10.1.2.3")).not.toContain("10.1.2.3");
  });

  it("rejects public and accepts dedicated business schemas; rejects whitespace-padded names", () => {
    expect(() => validateOwnerTransferSchema("public")).toThrow(/public is never allowed/);
    expect(validateOwnerTransferSchema("business_schema")).toBe("business_schema");
    expect(() => validateOwnerTransferSchema("  business_schema ")).toThrow(/owner-transfer/);
  });

  it("rejects forbidden PG schemas", () => {
    for (const schema of ["public", "information_schema", "pg_catalog", "pg_toast", "pi_restore_drill", "pi_cutover_x", "1bad", "bad-name", ""]) {
      expect(() => validateOwnerTransferSchema(schema)).toThrow(/owner-transfer/);
    }
  });
});