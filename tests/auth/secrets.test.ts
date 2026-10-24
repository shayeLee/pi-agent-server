import { describe, expect, it } from "vitest";
import {
  apiTokenPrefix,
  hashPassword,
  newApiToken,
  newSessionToken,
  passwordLengthOk,
  sha256Hex,
  verifyPassword,
} from "../../src/auth/secrets.js";

describe("password hashing", () => {
  it("hashes with scrypt N=2^15 r=8 p=1 and a fresh salt, and verifies", async () => {
    const first = await hashPassword("correct horse battery");
    const second = await hashPassword("correct horse battery");
    expect(first).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(await verifyPassword("correct horse battery", first)).toBe(true);
    expect(await verifyPassword("correct horse batterY", first)).toBe(false);
  });

  it("returns false for a missing or tampered hash, including one asking for other scrypt parameters", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", null)).toBe(false);
    expect(await verifyPassword("correct horse battery", stored.replace("$32768$", "$1048576$"))).toBe(false);
    expect(await verifyPassword("correct horse battery", "plain")).toBe(false);
  });

  it("counts length in code points, 12 to 256", () => {
    expect(passwordLengthOk("a".repeat(11))).toBe(false);
    expect(passwordLengthOk("a".repeat(12))).toBe(true);
    expect(passwordLengthOk("😀".repeat(12))).toBe(true);
    expect(passwordLengthOk("a".repeat(256))).toBe(true);
    expect(passwordLengthOk("a".repeat(257))).toBe(false);
  });
});

describe("random credentials", () => {
  it("makes 32-byte cookie values and pi_ tokens, stored only as SHA-256", () => {
    expect(newSessionToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const token = newApiToken();
    expect(token).toMatch(/^pi_[A-Za-z0-9_-]{43}$/);
    expect(apiTokenPrefix(token)).toBe(token.slice(0, 8));
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
