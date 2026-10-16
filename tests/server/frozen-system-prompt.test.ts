import { describe, expect, it } from "vitest";
import { frozenPromptBase } from "../../src/server/frozen-system-prompt.js";

describe("frozenPromptBase", () => {
  it("removes the trailing cwd section Pi re-adds on restore", () => {
    const body = "You are pi.\n\n<rules>\n- be brief\n</rules>";
    expect(frozenPromptBase(`${body}\n\n<cwd>\n/Users/me/project\n</cwd>`)).toBe(body);
  });
  it("removes the cwd section before a mode addendum, so the restored prompt carries one cwd", () => {
    const base = "You are pi.\n\n<rules>\n- be brief\n</rules>";
    expect(frozenPromptBase(`${base}\n\n<cwd>\n/Users/me/project\n</cwd>\n\nMode addendum.`)).toBe(`${base}\n\nMode addendum.`);
  });
  it("removes the plain cwd line that frozen prompts from Pi ≤0.85.1 end with", () => {
    expect(frozenPromptBase("You are pi.\nCurrent working directory: /Users/me/project\n")).toBe("You are pi.");
    expect(frozenPromptBase("You are pi.\nCurrent working directory: /Users/me/project")).toBe("You are pi.");
  });
  it("leaves a prompt alone when the cwd is not its last part", () => {
    const quoted = "Explain <cwd>\n/x\n</cwd> tags.\n\n<rules>\n- a\n</rules>";
    expect(frozenPromptBase(quoted)).toBe(quoted);
    const plugin = "Plugin mode prompt without any cwd.";
    expect(frozenPromptBase(plugin)).toBe(plugin);
  });
  it("removes only one trailing cwd, so a prompt already doubled by the old restore keeps one", () => {
    const cwd = "\n\n<cwd>\n/p\n</cwd>";
    expect(frozenPromptBase(`body${cwd}${cwd}`)).toBe(`body${cwd}`);
  });
});

describe("frozenPromptBase live sections", () => {
  const context = "\n\n<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path=\"/p/AGENTS.md\">\n# Rules\n\n- keep it\n</project_instructions>\n</project_context>";
  const skills = "\n\n<skills>\nThe following skills provide specialized instructions.\n\n<available_skills>\n  <skill>\n    <name>review</name>\n  </skill>\n</available_skills>\n</skills>";
  const cwd = "\n\n<cwd>\n/p\n</cwd>";
  it("removes frozen project context and skills, which Pi re-adds from the session loader", () => {
    expect(frozenPromptBase(`You are pi.${context}${skills}${cwd}`)).toBe("You are pi.");
    expect(frozenPromptBase(`You are pi.\n\n<addendum>\nmore\n</addendum>${context}${cwd}`)).toBe("You are pi.\n\n<addendum>\nmore\n</addendum>");
  });
  it("leaves a mention of the tags inside other text alone", () => {
    const prose = "Explain the <skills>\nsection</skills> format.";
    expect(frozenPromptBase(prose)).toBe(prose);
  });
});
