import { afterEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";

const fs = vi.hoisted(() => ({
  openSync: vi.fn(), fstatSync: vi.fn(), readFileSync: vi.fn(), closeSync: vi.fn(),
}));
vi.mock("node:fs", () => fs);
import { readAppendSystemPromptFile } from "../../src/server/system-prompt-file.js";
afterEach(() => vi.resetAllMocks());

it("does not read unconfigured paths", () => {
  for (const value of [undefined, "", " \n\t "]) expect(readAppendSystemPromptFile(value)).toBeUndefined();
  expect(fs.openSync).not.toHaveBeenCalled();
});

it("rejects permission errors without leaking arbitrary error details", () => {
  fs.openSync.mockImplementation(() => { throw Object.assign(new Error("SECRET_BODY"), { code: "EACCES" }); });
  expect(() => readAppendSystemPromptFile("unreadable.txt"))
    .toThrow(`PI_APPEND_SYSTEM_FILE: cannot read regular UTF-8 file: ${resolve("unreadable.txt")}`);
  expect(fs.closeSync).not.toHaveBeenCalled();
});

it("decodes UTF-8 explicitly, preserves BOM/whitespace and does not expand ~", () => {
  fs.openSync.mockReturnValue(17);
  fs.fstatSync.mockReturnValue({ isFile: () => true });
  const text = "\ufeff  中文\n\n原文  \n";
  fs.readFileSync.mockReturnValue(Buffer.from(text, "utf8"));
  expect(readAppendSystemPromptFile(" ~/append.txt ")).toBe(text);
  expect(fs.openSync).toHaveBeenCalledWith(resolve(process.cwd(), "~/append.txt"), "r");
  expect(fs.closeSync).toHaveBeenCalledWith(17);
});
