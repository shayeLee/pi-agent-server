import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectFileSearch } from "../../src/server/session-file-search.js";

const identity = (cwd: string) => { const canonical = realpathSync(cwd); const stat = statSync(canonical); return { cwd: canonical, dev: stat.dev, ino: stat.ino }; };
function project(files: Record<string, string>, git: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-file-search-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

describe("project file search", () => {
  it("lists git tracked and unignored files, ranks name matches first and omits sensitive names", async () => {
    const dir = project({ ".gitignore": "dist/\n", "src/cli.js": "", "src/client/index.ts": "", "docs/cli-guide.md": "",
      "dist/cli.js": "", ".env": "", "config/api.key": "", "secrets/notes.md": "" }, true);
    const search = createProjectFileSearch();
    const result = await search(identity(dir), "cli");
    expect(result.truncated).toBe(false);
    expect(result.entries.map(entry => entry.path)).toEqual(["src/client", "src/cli.js", "docs/cli-guide.md", "src/client/index.ts"]);
    const all = (await search(identity(dir), "")).entries.map(entry => `${entry.kind}:${entry.path}`);
    expect(all).toEqual(["directory:docs", "directory:src", "file:.gitignore"]);
    for (const query of ["dist", "env", "api.key", "secrets"]) {
      expect((await search(identity(dir), query)).entries.map(entry => entry.path)).not.toEqual(expect.arrayContaining([expect.stringMatching(/dist|\.env|api\.key|secrets/)]));
    }
  });

  it("matches path queries and accepts a leading @", async () => {
    const dir = project({ "src/cli.js": "", "web/src/cli.tsx": "" }, true);
    const search = createProjectFileSearch();
    expect((await search(identity(dir), "@web/src/c")).entries.map(entry => entry.path)).toEqual(["web/src/cli.tsx"]);
  });

  it("walks projects outside git without .git or node_modules", async () => {
    const dir = project({ "a/readme.md": "", "node_modules/pkg/readme.md": "", ".DS_Store": "", "a/.DS_Store": "" }, false);
    const result = await createProjectFileSearch()(identity(dir), "readme");
    expect(result.entries.map(entry => entry.path)).toEqual(["a/readme.md"]);
    expect((await createProjectFileSearch()(identity(dir), "")).entries.map(entry => entry.path)).toEqual(["a"]);
  });

  it("rejects invalid queries and a replaced project root", async () => {
    const dir = project({ "a.txt": "" }, false);
    const search = createProjectFileSearch();
    await expect(search(identity(dir), "x".repeat(257))).rejects.toThrow("FILE_SEARCH_INVALID_QUERY");
    await expect(search(identity(dir), 42)).rejects.toThrow("FILE_SEARCH_INVALID_QUERY");
    const frozen = identity(dir);
    renameSync(dir, `${dir}-moved`); mkdirSync(dir);
    await expect(search(frozen, "a")).rejects.toThrow("FILE_SEARCH_FORBIDDEN");
  });
});
