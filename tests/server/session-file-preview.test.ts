import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewProjectFile } from "../../src/server/session-file-preview.js";
import { buildApp } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import { makeTestIpAccess } from "../helpers/ip-access.js";

const root = () => mkdtempSync(path.join(tmpdir(), "pi-preview-"));
const identity = (cwd: string) => { const canonical = realpathSync(cwd); const stat = statSync(canonical); return { cwd: canonical, dev: stat.dev, ino: stat.ino }; };
describe("session file preview safety", () => {
  it("actually reads normal UTF-8 text on every supported local platform, including macOS", () => {
    const dir = root(); writeFileSync(path.join(dir, "a.txt"), "one\n你好\n");
    expect(previewProjectFile(identity(dir), "a.txt", "2")).toEqual({ path: "a.txt", content: "one\n你好\n", lineCount: 3, requestedLine: 2 });
  });

  it("fails closed at the HTTP endpoint until a session has a frozen JSONL root identity", async () => {
    const dir = root(); writeFileSync(path.join(dir, "visible.txt"), "owned");
    const { projects, sessions } = await makeInitializedMemoryDb({ cwd: dir });
    const app = buildApp({ sessions, projects, defaultProjectCwd: dir, ipAccess: makeTestIpAccess(), createAdapter: async () => new MockAgentAdapter() });
    try {
      const created = await app.inject({ method: "POST", url: "/v1/sessions", remoteAddress: "10.0.0.1", headers: { "content-type": "application/json" }, payload: "{}" });
      const id = created.json().id as string;
      const own = await app.inject({ method: "GET", url: `/v1/sessions/${id}/file-preview?path=visible.txt&line=1`, remoteAddress: "10.0.0.1" });
      expect(own.statusCode).toBe(404);
      const other = await app.inject({ method: "GET", url: `/v1/sessions/${id}/file-preview?path=visible.txt`, remoteAddress: "10.0.0.2" });
      expect(other.statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("rejects traversal, sensitive unicode names, binary, invalid UTF-8, 256KiB+1, absent, symlink and invalid line without disclosing paths", () => {
    const dir = root(); const outside = root();
    writeFileSync(path.join(dir, ".env"), "x"); writeFileSync(path.join(dir, ".env.local"), "x"); writeFileSync(path.join(dir, "auth.json"), "x"); writeFileSync(path.join(dir, ".npmrc"), "//registry/:_authToken=x"); writeFileSync(path.join(dir, "credentials"), "x"); writeFileSync(path.join(dir, "api.key"), "x"); writeFileSync(path.join(dir, "密钥.txt"), "x"); writeFileSync(path.join(dir, "bin"), Buffer.from([0, 1]));
    writeFileSync(path.join(dir, "bad"), Buffer.from([0xc3, 0x28])); writeFileSync(path.join(dir, "at-cap"), Buffer.alloc(256 * 1024, 0x61)); writeFileSync(path.join(dir, "big"), Buffer.alloc(256 * 1024 + 1));
    expect(previewProjectFile(identity(dir), "at-cap", undefined).content).toHaveLength(256 * 1024);
    writeFileSync(path.join(outside, "secret.txt"), "no"); symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link"));
    for (const [p, line] of [["../x", undefined], ["/etc/passwd", undefined], ["%2e%2e/x", undefined], [".env", undefined], [".env.local", undefined], ["auth.json", undefined], [".npmrc", undefined], ["credentials", undefined], ["api.key", undefined], ["密钥.txt", undefined], ["bin", undefined], ["bad", undefined], ["big", undefined], ["missing", undefined], ["link", undefined], ["x", "0"], ["x", "999"]] as const) {
      try { previewProjectFile(identity(dir), p, line); expect.unreachable(); } catch (error) {
        expect(error).toMatchObject({ message: expect.stringMatching(/^FILE_PREVIEW_/) });
        expect(String(error)).not.toContain(dir);
      }
    }
  });

  it("rejects static ancestor symlinks, replaced roots, and FIFO paths without blocking", () => {
    const dir = root(); const outside = root();
    mkdirSync(path.join(dir, "nested")); writeFileSync(path.join(outside, "visible.txt"), "no");
    symlinkSync(outside, path.join(dir, "nested", "linked"));
    expect(() => previewProjectFile(identity(dir), "nested/linked/visible.txt", undefined)).toThrow("FILE_PREVIEW_FORBIDDEN");

    const frozen = identity(dir); const moved = `${dir}-moved`;
    renameSync(dir, moved); mkdirSync(dir); writeFileSync(path.join(dir, "visible.txt"), "replacement");
    expect(() => previewProjectFile(frozen, "visible.txt", undefined)).toThrow("FILE_PREVIEW_FORBIDDEN");

    const fifoRoot = root(); const fifo = path.join(fifoRoot, "pipe");
    // mkfifo is an OS primitive, not a mocked platform branch. O_NONBLOCK/static regular-file
    // validation must return immediately rather than wait for a writer.
    const started = Date.now();
    try {
      if (process.platform === "win32") return; // mkfifo is unavailable; supported deployment targets are macOS/Linux.
      execFileSync("mkfifo", [fifo]);
      expect(() => previewProjectFile(identity(fifoRoot), "pipe", undefined)).toThrow("FILE_PREVIEW_FORBIDDEN");
    } finally { expect(Date.now() - started).toBeLessThan(1000); }
  });
});
