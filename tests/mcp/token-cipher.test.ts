import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpTokenKeyFile, McpTokenCipher } from "../../src/mcp/token-cipher.js";

describe("McpTokenCipher", () => {
  const cipher = new McpTokenCipher(randomBytes(32));

  it("round-trips and never repeats a ciphertext", () => {
    const first = cipher.encrypt("secret token", "row-a");
    expect(first).not.toContain("secret");
    expect(cipher.encrypt("secret token", "row-a")).not.toBe(first);
    expect(cipher.decrypt(first, "row-a")).toBe("secret token");
  });

  it("rejects another row, another key and tampering", () => {
    const text = cipher.encrypt("secret token", "row-a");
    expect(() => cipher.decrypt(text, "row-b")).toThrow(/cannot be decrypted/);
    expect(() => new McpTokenCipher(randomBytes(32)).decrypt(text, "row-a")).toThrow(/cannot be decrypted/);
    const [version, iv, body] = text.split(".");
    const flipped = Buffer.from(body!, "base64url");
    flipped[0]! ^= 1;
    expect(() => cipher.decrypt(`${version}.${iv}.${flipped.toString("base64url")}`, "row-a")).toThrow(/cannot be decrypted/);
    expect(() => cipher.decrypt("plain", "row-a")).toThrow(/unknown format/);
  });
});

describe("loadMcpTokenKeyFile", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
  function keyFile(content: string, mode = 0o600): string {
    dir ??= mkdtempSync(join(tmpdir(), "mcp-key-"));
    const path = join(dir, `key-${mode.toString(8)}-${content.length}`);
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  }

  it("loads a base64 32-byte key", () => {
    const key = randomBytes(32);
    const loaded = loadMcpTokenKeyFile(keyFile(`${key.toString("base64")}\n`));
    expect(new McpTokenCipher(key).decrypt(loaded.encrypt("x", "a"), "a")).toBe("x");
  });

  it("refuses group-readable files, wrong lengths and relative paths without echoing the content", () => {
    expect(() => loadMcpTokenKeyFile(keyFile(randomBytes(32).toString("base64"), 0o644))).toThrow(/chmod 600/);
    expect(() => loadMcpTokenKeyFile(keyFile(randomBytes(16).toString("base64")))).toThrow(/32 random bytes/);
    expect(() => loadMcpTokenKeyFile(keyFile("not a key at all"))).toThrow(/32 random bytes/);
    expect(() => loadMcpTokenKeyFile("relative/key")).toThrow(/absolute path/);
  });
});
