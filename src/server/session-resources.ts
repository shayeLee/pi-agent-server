// Session text resources: AGENTS.md / CLAUDE.md context files, prompt templates and skills.
//
// Pi discovers these relative to the ResourceLoader cwd. The host loader cwd is fixed to the
// service cwd (extension module cache, see provider-extensions.ts), so SDK auto-discovery would
// scan the service directory instead of the session project. These helpers rebuild Pi's
// discovery directories from the session project cwd and hand them to the loader explicitly.
// Extensions are never discovered here: they stay explicit (PI_EXTENSION_PATHS).
//
// Context files, prompt templates and skills load for every project, trusted or not. A project's
// .pi/SYSTEM.md and .pi/APPEND_SYSTEM.md load only when the project is trusted (project-trust.ts),
// see sessionSystemPromptSources; project extensions never load.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DefaultResourceLoader, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { SessionCommandInfo } from "../shared/commands.js";

export type SessionResourceRoots = {
  /** Session project cwd (project-level discovery root). */
  readonly projectCwd: string;
  /** Service agentDir (user-level discovery root, Pi's ~/.pi/agent by default). */
  readonly agentDir: string;
  /** User home for ~/.agents/skills; injectable for tests. */
  readonly home?: string;
};

function findGitRoot(start: string): string | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** `.agents/skills` from the project up to its git root (filesystem root without git), as Pi does. */
function ancestorAgentsSkillDirs(projectCwd: string): string[] {
  const gitRoot = findGitRoot(projectCwd);
  const dirs: string[] = [];
  for (let dir = resolve(projectCwd); ; dir = dirname(dir)) {
    dirs.push(join(dir, ".agents", "skills"));
    if ((gitRoot && dir === gitRoot) || dirname(dir) === dir) return dirs;
  }
}

/**
 * Pi's skill directories in its own precedence order (first name wins): project `.pi/skills`,
 * project `.agents/skills` ancestors, user `<agentDir>/skills`, user `~/.agents/skills`.
 * Missing directories are kept so /reload picks them up once created.
 */
export function sessionSkillPaths(roots: SessionResourceRoots): string[] {
  const userAgents = join(roots.home ?? homedir(), ".agents", "skills");
  const paths = [join(roots.projectCwd, ".pi", "skills"),
    ...ancestorAgentsSkillDirs(roots.projectCwd).filter(dir => dir !== userAgents),
    join(roots.agentDir, "skills"), userAgents];
  return [...new Set(paths)];
}

/** Pi's prompt template directories: project `.pi/prompts`, then user `<agentDir>/prompts`. */
export function sessionPromptPaths(roots: SessionResourceRoots): string[] {
  return [...new Set([join(roots.projectCwd, ".pi", "prompts"), join(roots.agentDir, "prompts")])];
}

/** Loader options for one session. Context files are re-read on every loader reload. */
export function sessionResourceLoaderOptions(roots: SessionResourceRoots) {
  return {
    additionalSkillPaths: sessionSkillPaths(roots),
    additionalPromptTemplatePaths: sessionPromptPaths(roots),
    agentsFilesOverride: () => ({ agentsFiles: loadProjectContextFiles({ cwd: roots.projectCwd, agentDir: roots.agentDir }) }),
  };
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * Where a new session's system prompt comes from, in Pi's order: a trusted project's
 * `.pi/SYSTEM.md`, then `<agentDir>/SYSTEM.md`, else Pi's default prompt (""). A trusted
 * project's `.pi/APPEND_SYSTEM.md` is appended. Values are absolute file paths the loader reads.
 *
 * Always explicit: left to itself the loader would look for `.pi/SYSTEM.md` under its own cwd,
 * which is the service cwd, and give one project's prompt to every project.
 */
export function sessionSystemPromptSources(roots: SessionResourceRoots & { readonly projectTrusted: boolean }): {
  systemPrompt: string; appendSystemPrompt: string[];
} {
  const projectSystem = join(roots.projectCwd, ".pi", "SYSTEM.md");
  const userSystem = join(roots.agentDir, "SYSTEM.md");
  const projectAppend = join(roots.projectCwd, ".pi", "APPEND_SYSTEM.md");
  return {
    systemPrompt: roots.projectTrusted && isFile(projectSystem) ? projectSystem : isFile(userSystem) ? userSystem : "",
    appendSystemPrompt: roots.projectTrusted && isFile(projectAppend) ? [projectAppend] : [],
  };
}

export const BUILTIN_SESSION_COMMANDS: readonly SessionCommandInfo[] = Object.freeze([
  { name: "compact", source: "builtin", description: "手动压缩会话上下文", argumentHint: "[总结要求]" },
  { name: "reload", source: "builtin", description: "重新加载 AGENTS.md、提示词模板、skills 与会话扩展" },
]);

const LIST_CACHE_MS = 3_000;

/**
 * Lists what a session can type after `/`: built-ins, prompt templates and `skill:<name>`.
 * Reads the disk through an extension-free loader on the stable loader cwd, so listing never
 * evaluates extension code or clears the extension module cache. Briefly cached per project.
 */
export function createSessionCommandLister(options: { loaderCwd: string; agentDir: string; home?: string; now?: () => number }) {
  const cache = new Map<string, { at: number; commands: Promise<SessionCommandInfo[]> }>();
  const now = options.now ?? Date.now;
  const load = async (projectCwd: string): Promise<SessionCommandInfo[]> => {
    const roots = { projectCwd, agentDir: options.agentDir, ...(options.home ? { home: options.home } : {}) };
    const loader = new DefaultResourceLoader({
      cwd: options.loaderCwd, agentDir: options.agentDir,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      appendSystemPrompt: [],
      additionalSkillPaths: sessionSkillPaths(roots),
      additionalPromptTemplatePaths: sessionPromptPaths(roots),
    });
    await loader.reload();
    const builtinNames = new Set(BUILTIN_SESSION_COMMANDS.map(command => command.name));
    const prompts: SessionCommandInfo[] = loader.getPrompts().prompts
      .filter(prompt => !builtinNames.has(prompt.name))
      .map(prompt => ({ name: prompt.name, source: "prompt", description: prompt.description,
        ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}) }));
    const skills: SessionCommandInfo[] = loader.getSkills().skills
      .map(skill => ({ name: `skill:${skill.name}`, source: "skill", description: skill.description }));
    return [...BUILTIN_SESSION_COMMANDS, ...prompts, ...skills];
  };
  return (projectCwd: string): Promise<SessionCommandInfo[]> => {
    const hit = cache.get(projectCwd);
    if (hit && now() - hit.at < LIST_CACHE_MS) return hit.commands;
    const commands = load(projectCwd);
    cache.set(projectCwd, { at: now(), commands });
    commands.catch(() => cache.delete(projectCwd));
    return commands;
  };
}

/**
 * Commands the explicitly loaded Pi extensions registered (pi.registerCommand), read once from an
 * already loaded ResourceLoader. Names that collide with a built-in are left out: the built-in wins.
 */
export function extensionCommandsOf(loader: { getExtensions(): { extensions: readonly { commands?: ReadonlyMap<string, { name: string; description?: string }> }[] } }): SessionCommandInfo[] {
  const builtinNames = new Set(BUILTIN_SESSION_COMMANDS.map(command => command.name));
  const seen = new Set<string>();
  const commands: SessionCommandInfo[] = [];
  for (const extension of loader.getExtensions().extensions) {
    for (const command of extension.commands?.values() ?? []) {
      if (builtinNames.has(command.name) || seen.has(command.name)) continue;
      seen.add(command.name);
      commands.push({ name: command.name, source: "extension", description: command.description ?? "" });
    }
  }
  return commands;
}
