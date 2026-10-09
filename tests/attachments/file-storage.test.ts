import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyExisting, writeAttachment } from "../../src/attachments/file-storage.js";

const roots: string[] = [];
function makeBase(): string {
  const base = mkdtempSync(path.join(realpathSync(tmpdir()), "pi-attachment-test-"));
  roots.push(base);
  return base;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const input = { kind: "text" as const, originalName: "report.txt", bytes: Buffer.from("raw attachment bytes\n") };
const storageKey = "e6b5c3a9-2ce1-49c5-a9c1-86b58c2cbe31";

describe("attachment storage", () => {
  it("writes the caller-reserved opaque key in a private root without using the original name", () => {
    const base = makeBase();
    const storageRoot = path.join(base, "private-attachments");
    const agentVisibleRoot = path.join(base, "agent-mount", "attachments");
    const result = writeAttachment({ storageRoot, agentVisibleRoot }, storageKey, input);
    expect(result.status).toBe("written");
    if (result.status !== "written") return;
    expect(result.storageKey).toBe(storageKey);
    expect(path.basename(result.storedPath)).toBe(storageKey);
    expect(result.storedPath).toBe(path.join(storageRoot, storageKey));
    expect(result.agentPath).toBe(path.join(agentVisibleRoot, storageKey));
    expect(readFileSync(result.storedPath)).toEqual(input.bytes);
    expect(lstatSync(storageRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(result.storedPath).mode & 0o777).toBe(0o600);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("verifies an existing exact file and makes a same-key retry idempotent", () => {
    const base = makeBase();
    const config = { storageRoot: path.join(base, "store"), agentVisibleRoot: path.join(base, "agent") };
    const first = writeAttachment(config, storageKey, input);
    expect(first.status).toBe("written");
    if (first.status !== "written") return;
    expect(verifyExisting(config, storageKey, first.size, first.sha256)).toMatchObject({
      status: "verified", storageKey, size: first.size, sha256: first.sha256,
    });
    const retry = writeAttachment(config, storageKey, input);
    expect(retry).toMatchObject({ status: "already-written", storageKey, sha256: first.sha256 });
    expect(readdirSync(config.storageRoot)).toEqual([storageKey]);
  });

  it("reports a partial or mismatched same-key residue as unrecoverable and preserves it", () => {
    const base = makeBase();
    const storageRoot = path.join(base, "store");
    mkdirSync(storageRoot, { mode: 0o700 });
    chmodSync(storageRoot, 0o700);
    const residue = Buffer.from("partial-original");
    writeFileSync(path.join(storageRoot, storageKey), residue, { mode: 0o600, flag: "wx" });
    const config = { storageRoot, agentVisibleRoot: path.join(base, "agent") };

    const verified = verifyExisting(config, storageKey, input.bytes.length, "0".repeat(64));
    expect(verified).toMatchObject({ status: "unrecoverable", code: "INTEGRITY_MISMATCH" });
    const retry = writeAttachment(config, storageKey, input);
    expect(retry).toMatchObject({ status: "unrecoverable", code: "INTEGRITY_MISMATCH", storageKey });
    expect(readFileSync(path.join(storageRoot, storageKey))).toEqual(residue);

    const newKey = "4f8d7083-3c65-4b82-ae62-18e3ec24b0b7";
    expect(writeAttachment(config, newKey, input).status).toBe("written");
    expect(readFileSync(path.join(storageRoot, storageKey))).toEqual(residue);
  });

  it("does not create a storage directory for rejected data", () => {
    const base = makeBase();
    const storageRoot = path.join(base, "must-not-exist");
    const result = writeAttachment({ storageRoot, agentVisibleRoot: path.join(base, "agent") }, storageKey, {
      kind: "pdf", originalName: "bad.pdf", bytes: Buffer.from("not a PDF"),
    });
    expect(result.status).toBe("rejected");
    expect(() => lstatSync(storageRoot)).toThrow();
  });

  it("rejects storage-root symlinks without writing through them", () => {
    const base = makeBase();
    const realRoot = path.join(base, "real");
    mkdirSync(realRoot, { mode: 0o700 });
    chmodSync(realRoot, 0o700);
    const alias = path.join(base, "alias");
    symlinkSync(realRoot, alias, "dir");
    const result = writeAttachment({ storageRoot: alias, agentVisibleRoot: path.join(base, "agent") }, storageKey, input);
    expect(result).toMatchObject({ status: "failed", code: "STORAGE_FAILED" });
    expect(lstatSync(realRoot).isDirectory()).toBe(true);
    expect(readdirSync(realRoot)).toEqual([]);
  });

  it("rejects non-private pre-existing roots and invalid filename paths", () => {
    const base = makeBase();
    const root = path.join(base, "public");
    mkdirSync(root, { mode: 0o755 });
    chmodSync(root, 0o755);
    expect(writeAttachment({ storageRoot: root, agentVisibleRoot: path.join(base, "agent") }, storageKey, input))
      .toMatchObject({ status: "failed", code: "STORAGE_FAILED" });
    const rejected = writeAttachment({ storageRoot: path.join(base, "unused"), agentVisibleRoot: path.join(base, "agent") }, storageKey, {
      ...input,
      originalName: "../../secret.txt",
    });
    expect(rejected.status).toBe("rejected");
  });

  it("fails closed when either explicit path configuration or the storage key is invalid", () => {
    const base = makeBase();
    expect(writeAttachment({ storageRoot: path.join(base, "store"), agentVisibleRoot: "" }, storageKey, input))
      .toMatchObject({ status: "failed", code: "STORAGE_FAILED" });
    expect(writeAttachment({ storageRoot: path.join(base, "store"), agentVisibleRoot: path.join(base, "agent") }, "../escape", input))
      .toMatchObject({ status: "failed", code: "STORAGE_FAILED" });
  });
});
