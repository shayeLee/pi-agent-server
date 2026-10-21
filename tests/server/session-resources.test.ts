import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionCommandLister, extensionCommandsOf, sessionPromptPaths, sessionSkillPaths, sessionSystemPromptSources } from "../../src/server/session-resources.js";
import { loadSessionResourceLoader } from "../../src/server/provider-extensions.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

function write(file: string, content: string) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); }
function layout() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-resources-")));
  const home = path.join(base, "home"), agentDir = path.join(home, ".pi", "agent"), repo = path.join(base, "repo"), projectCwd = path.join(repo, "packages", "app");
  mkdirSync(path.join(repo, ".git"), { recursive: true }); mkdirSync(projectCwd, { recursive: true });
  const skill = (dir: string, name: string) => write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody`);
  skill(path.join(projectCwd, ".pi", "skills"), "project-pi");
  skill(path.join(repo, ".agents", "skills"), "repo-agents");
  skill(path.join(agentDir, "skills"), "user-pi");
  skill(path.join(home, ".agents", "skills"), "user-agents");
  skill(path.join(base, ".agents", "skills"), "above-git-root");
  write(path.join(agentDir, "prompts", "iterate.md"), "---\ndescription: Iterate\nargument-hint: <goal>\n---\nWork on $1");
  write(path.join(projectCwd, ".pi", "prompts", "review.md"), "---\ndescription: Review\n---\nReview it");
  write(path.join(agentDir, "AGENTS.md"), "user rules");
  write(path.join(repo, "AGENTS.md"), "repo rules");
  return { base, home, agentDir, repo, projectCwd, serviceCwd: path.join(base, "service") };
}

describe("session resources", () => {
  it("rebuilds Pi's discovery directories from the project cwd, stopping .agents at the git root", () => {
    const { home, agentDir, repo, projectCwd } = layout();
    expect(sessionSkillPaths({ projectCwd, agentDir, home })).toEqual([
      path.join(projectCwd, ".pi", "skills"), path.join(projectCwd, ".agents", "skills"), path.join(repo, "packages", ".agents", "skills"),
      path.join(repo, ".agents", "skills"), path.join(agentDir, "skills"), path.join(home, ".agents", "skills")]);
    expect(sessionPromptPaths({ projectCwd, agentDir })).toEqual([path.join(projectCwd, ".pi", "prompts"), path.join(agentDir, "prompts")]);
  });

  it("loads project and user context files, templates and skills into a session loader on the stable service cwd", async () => {
    const { home, agentDir, projectCwd, serviceCwd } = layout();
    mkdirSync(serviceCwd);
    write(path.join(serviceCwd, "AGENTS.md"), "service rules must not leak in");
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(serviceCwd, "auth.json"), modelsPath: path.join(serviceCwd, "models.json") });
    const loader = await loadSessionResourceLoader(modelRuntime, { extensionCwd: serviceCwd, agentDir, resources: { projectCwd, agentDir, home } });
    expect(loader.getAgentsFiles().agentsFiles.map(file => file.content)).toEqual(["user rules", "repo rules"]);
    expect(loader.getPrompts().prompts.map(prompt => prompt.name).sort()).toEqual(["iterate", "review"]);
    expect(loader.getSkills().skills.map(skill => skill.name).sort()).toEqual(["project-pi", "repo-agents", "user-agents", "user-pi"]);
    write(path.join(projectCwd, ".pi", "prompts", "later.md"), "Later");
    await loader.reload();
    expect(loader.getPrompts().prompts.map(prompt => prompt.name)).toContain("later");
  });

  it("takes a project's SYSTEM.md and APPEND_SYSTEM.md only when it is trusted, and never the service cwd's", async () => {
    const { agentDir, projectCwd, serviceCwd } = layout();
    write(path.join(serviceCwd, ".pi", "SYSTEM.md"), "service prompt must not leak in");
    write(path.join(projectCwd, ".pi", "SYSTEM.md"), "project prompt");
    write(path.join(projectCwd, ".pi", "APPEND_SYSTEM.md"), "project addendum");
    expect(sessionSystemPromptSources({ projectCwd, agentDir, projectTrusted: true })).toEqual({
      systemPrompt: path.join(projectCwd, ".pi", "SYSTEM.md"), appendSystemPrompt: [path.join(projectCwd, ".pi", "APPEND_SYSTEM.md")],
    });
    expect(sessionSystemPromptSources({ projectCwd, agentDir, projectTrusted: false })).toEqual({ systemPrompt: "", appendSystemPrompt: [] });
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(serviceCwd, "auth.json"), modelsPath: path.join(serviceCwd, "models.json") });
    const load = (projectTrusted: boolean) => loadSessionResourceLoader(modelRuntime, {
      extensionCwd: serviceCwd, agentDir, ...sessionSystemPromptSources({ projectCwd, agentDir, projectTrusted }),
    });
    // "" is Pi's default prompt: the loader does not go looking under its own (service) cwd.
    expect((await load(false)).getSystemPrompt()).toBeUndefined();
    write(path.join(agentDir, "SYSTEM.md"), "user prompt");
    expect(sessionSystemPromptSources({ projectCwd, agentDir, projectTrusted: false }).systemPrompt).toBe(path.join(agentDir, "SYSTEM.md"));
    const trusted = await load(true);
    expect(trusted.getSystemPrompt()).toBe("project prompt");
    expect(trusted.getAppendSystemPrompt()).toEqual(["project addendum"]);
    const untrusted = await load(false);
    expect(untrusted.getSystemPrompt()).toBe("user prompt");
    expect(untrusted.getAppendSystemPrompt()).toEqual([]);
  });

  it("lists built-ins, templates and skill commands without loading extensions", async () => {
    const { home, agentDir, projectCwd, serviceCwd } = layout();
    mkdirSync(serviceCwd);
    const list = await createSessionCommandLister({ loaderCwd: serviceCwd, agentDir, home })(projectCwd);
    expect(list.slice(0, 2).map(command => command.name)).toEqual(["compact", "reload"]);
    expect(list).toContainEqual({ name: "iterate", source: "prompt", description: "Iterate", argumentHint: "<goal>" });
    expect(list).toContainEqual({ name: "skill:repo-agents", source: "skill", description: "repo-agents skill" });
    expect(list.map(command => command.name)).not.toContain("skill:above-git-root");
  });
});

describe("extensionCommandsOf", () => {
  it("lists commands extensions registered, once each, without shadowing built-ins", () => {
    const commands = (...entries: [string, string?][]) => new Map(entries.map(([name, description]) => [name, { name, ...(description ? { description } : {}) }]));
    expect(extensionCommandsOf({ getExtensions: () => ({ extensions: [
      { commands: commands(["antigravity.usage", "Show quota"], ["reload", "shadow"]) },
      {},
      { commands: commands(["antigravity.usage", "duplicate"], ["team"]) },
    ] }) })).toEqual([
      { name: "antigravity.usage", source: "extension", description: "Show quota" },
      { name: "team", source: "extension", description: "" },
    ]);
  });
});
