import { describe, expect, it } from "vitest";
import { frozenPromptWithoutCwd } from "../../src/server/frozen-system-prompt.js";

describe("frozenPromptWithoutCwd", () => {
  it("removes the trailing cwd section Pi re-adds on restore", () => {
    const body = "You are pi.\n\n<rules>\n- be brief\n</rules>";
    expect(frozenPromptWithoutCwd(`${body}\n\n<cwd>\n/Users/me/project\n</cwd>`)).toBe(body);
  });
  it("removes the cwd section before a mode addendum, so the restored prompt carries one cwd", () => {
    const base = "You are pi.\n\n<rules>\n- be brief\n</rules>";
    expect(frozenPromptWithoutCwd(`${base}\n\n<cwd>\n/Users/me/project\n</cwd>\n\nMode addendum.`)).toBe(`${base}\n\nMode addendum.`);
  });
  it("removes the plain cwd line that frozen prompts from Pi ≤0.85.1 end with", () => {
    expect(frozenPromptWithoutCwd("You are pi.\nCurrent working directory: /Users/me/project\n")).toBe("You are pi.");
    expect(frozenPromptWithoutCwd("You are pi.\nCurrent working directory: /Users/me/project")).toBe("You are pi.");
  });
  it("leaves a prompt alone when the cwd is not its last part", () => {
    const quoted = "Explain <cwd>\n/x\n</cwd> tags.\n\n<rules>\n- a\n</rules>";
    expect(frozenPromptWithoutCwd(quoted)).toBe(quoted);
    const plugin = "Plugin mode prompt without any cwd.";
    expect(frozenPromptWithoutCwd(plugin)).toBe(plugin);
  });
  it("removes only one trailing cwd, so a prompt already doubled by the old restore keeps one", () => {
    const cwd = "\n\n<cwd>\n/p\n</cwd>";
    expect(frozenPromptWithoutCwd(`body${cwd}${cwd}`)).toBe(`body${cwd}`);
  });
});
