// Agent 设置：Pi 全局 settings.json 里服务会用的几个字段（docs/configuration.md「Agent 设置」）。
// - 读：自动压缩（含 Pi 的压缩阈值 reserveTokens、keepRecentTokens 与按模型的 modelOverrides，只读透传，Web 上不改）、
//   自动重试、按模型的思考档位。每次取值时检查文件的修改时间和大小，变了就重新解析；文件不存在时全用 Pi 的默认值，写坏时继续用上一次读成功的内容。
// - 会话：每个会话一个 SettingsManager，只看得到这几个字段；会话里的改动（Pi 的 setter）不写回文件。
//   信任的项目（project-trust.ts）里 .pi/settings.json 的同样几个字段叠加在全局之上，和 Pi 一样逐层合并。
//   有会话在用时每隔一会儿检查文件和项目信任，变了就让这些 SettingsManager 重新读取，运行中的会话也立即生效。
// - 另外读出 defaultProjectTrust，供项目信任在 trust.json 里没有记录时使用。
// - 写：和 pi CLI 用同一个文件锁（proper-lockfile 的 settings.json.lock），只改这几个字段，其他字段原样保留；
//   先写临时文件再改名。GET 给出文件内容的 hash，保存时对不上就是文件在别处（CLI、手工）被改过，拒绝覆盖。

import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import {
  AGENT_THINKING_LEVELS, MAX_AGENT_RETRIES,
  type AgentSettings, type AgentSettingsProject, type AgentSettingsValues, type AgentThinkingLevel,
} from "../shared/agent-settings.js";
import type { DefaultProjectTrust } from "./project-trust.js";

const MAX_FILE_BYTES = 1024 * 1024;
const ABSENT_HASH = "absent";
const MAX_MODEL_ENTRIES = 500;
const DEFAULT_POLL_MS = 2000;

/** Pi 1.3 的默认值（SETTINGS_DEFAULTS）。 */
export const AGENT_SETTINGS_DEFAULTS: AgentSettings["defaults"] = { autoCompaction: true, autoRetry: true, maxRetries: 3 };

type PiSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;
type PiSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

export type AgentSettingsErrorCode = "conflict" | "invalid";

export class AgentSettingsError extends Error {
  constructor(readonly code: AgentSettingsErrorCode, message: string) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new AgentSettingsError("invalid", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is AgentThinkingLevel {
  return typeof value === "string" && (AGENT_THINKING_LEVELS as readonly string[]).includes(value);
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** compaction 里的 reserveTokens / keepRecentTokens；写错类型的项跳过并记下。 */
function tokenSettings(source: Record<string, unknown>, where: string, problems: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of ["reserveTokens", "keepRecentTokens"] as const) {
    if (isTokenCount(source[key])) result[key] = source[key];
    else if (source[key] !== undefined) problems.push(`${where}.${key} 不是非负整数`);
  }
  return result;
}

function isRetryCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_AGENT_RETRIES;
}

/** `provider/modelId`；modelId 自己也可以带 `/`。 */
function isModelKey(key: string): boolean {
  const slash = key.indexOf("/");
  return slash > 0 && slash < key.length - 1 && key.length <= 256 && !/\s/.test(key);
}

/**
 * settings.json → 服务会用的值，以及交给会话的 Pi 设置。文件里没写的项不进 `piSettings`，
 * 由 Pi 用自己的默认值；写错类型的项当作没写，并在 `problems` 里说明。
 */
export function parseAgentSettings(config: Record<string, unknown>): {
  values: AgentSettingsValues; piSettings: PiSettings; problems: string[];
} {
  const problems: string[] = [];
  const piSettings: Record<string, unknown> = {};
  const compaction = isRecord(config.compaction) ? config.compaction : {};
  const retry = isRecord(config.retry) ? config.retry : {};
  let autoCompaction = AGENT_SETTINGS_DEFAULTS.autoCompaction;
  const piCompaction: Record<string, unknown> = {};
  if (typeof compaction.enabled === "boolean") {
    autoCompaction = compaction.enabled;
    piCompaction.enabled = autoCompaction;
  } else if (compaction.enabled !== undefined) problems.push("compaction.enabled 不是 true 或 false");
  // 压缩阈值不在面板上，但和 CLI 一样交给会话，同一份文件两边压缩得一样。
  Object.assign(piCompaction, tokenSettings(compaction, "compaction", problems));
  if (isRecord(compaction.modelOverrides)) {
    const overrides: Record<string, Record<string, number>> = {};
    for (const [key, override] of Object.entries(compaction.modelOverrides)) {
      const where = `compaction.modelOverrides[${JSON.stringify(key).slice(0, 80)}]`;
      if (!isModelKey(key) || !isRecord(override)) { problems.push(`${where} 不是有效的模型设置`); continue; }
      const tokens = tokenSettings(override, where, problems);
      if (Object.keys(tokens).length > 0) overrides[key] = tokens;
    }
    if (Object.keys(overrides).length > 0) piCompaction.modelOverrides = overrides;
  } else if (compaction.modelOverrides !== undefined) problems.push("compaction.modelOverrides 不是对象");
  if (Object.keys(piCompaction).length > 0) piSettings.compaction = piCompaction;
  let autoRetry = AGENT_SETTINGS_DEFAULTS.autoRetry;
  let maxRetries = AGENT_SETTINGS_DEFAULTS.maxRetries;
  const piRetry: Record<string, unknown> = {};
  if (typeof retry.enabled === "boolean") {
    autoRetry = retry.enabled;
    piRetry.enabled = autoRetry;
  } else if (retry.enabled !== undefined) problems.push("retry.enabled 不是 true 或 false");
  if (isRetryCount(retry.maxRetries)) {
    maxRetries = retry.maxRetries;
    piRetry.maxRetries = maxRetries;
  } else if (retry.maxRetries !== undefined) problems.push(`retry.maxRetries 不是 0 到 ${MAX_AGENT_RETRIES} 的整数`);
  if (Object.keys(piRetry).length > 0) piSettings.retry = piRetry;
  const modelThinkingLevels: Record<string, AgentThinkingLevel> = {};
  if (isRecord(config.modelThinkingLevels)) {
    for (const [key, level] of Object.entries(config.modelThinkingLevels)) {
      if (isModelKey(key) && isThinkingLevel(level)) modelThinkingLevels[key] = level;
      else problems.push(`modelThinkingLevels 里的 ${JSON.stringify(key).slice(0, 80)} 不是有效的模型和思考档位`);
    }
    if (Object.keys(modelThinkingLevels).length > 0) piSettings.modelThinkingLevels = modelThinkingLevels;
  } else if (config.modelThinkingLevels !== undefined) problems.push("modelThinkingLevels 不是对象");
  return { values: { autoCompaction, autoRetry, maxRetries, modelThinkingLevels }, piSettings: piSettings as PiSettings, problems };
}

/** 在 settings.json 的内容上改服务管得到的字段；没给出的项保持原样。 */
export function applyAgentSettings(config: Record<string, unknown>, values: Partial<AgentSettingsValues>): Record<string, unknown> {
  const next = structuredClone(config);
  if (values.autoCompaction !== undefined) {
    if (typeof values.autoCompaction !== "boolean") invalid("autoCompaction 必须是 true 或 false");
    next.compaction = { ...(isRecord(next.compaction) ? next.compaction : {}), enabled: values.autoCompaction };
  }
  if (values.autoRetry !== undefined || values.maxRetries !== undefined) {
    const retry: Record<string, unknown> = isRecord(next.retry) ? { ...next.retry } : {};
    if (values.autoRetry !== undefined) {
      if (typeof values.autoRetry !== "boolean") invalid("autoRetry 必须是 true 或 false");
      retry.enabled = values.autoRetry;
    }
    if (values.maxRetries !== undefined) {
      if (!isRetryCount(values.maxRetries)) invalid(`重试次数必须是 0 到 ${MAX_AGENT_RETRIES} 的整数`);
      retry.maxRetries = values.maxRetries;
    }
    next.retry = retry;
  }
  if (values.modelThinkingLevels !== undefined) {
    if (!isRecord(values.modelThinkingLevels)) invalid("modelThinkingLevels 必须是对象");
    const entries = Object.entries(values.modelThinkingLevels);
    if (entries.length > MAX_MODEL_ENTRIES) invalid(`最多给 ${MAX_MODEL_ENTRIES} 个模型设置思考档位`);
    for (const [key, level] of entries) {
      if (!isModelKey(key)) invalid(`${key} 不是 provider/modelId`);
      if (!isThinkingLevel(level)) invalid(`${key} 的思考档位无效`);
    }
    if (entries.length > 0) next.modelThinkingLevels = Object.fromEntries(entries);
    else delete next.modelThinkingLevels;
  }
  return next;
}

/** 交给会话的 Pi 设置里写了的项，换成面板上的几个值。 */
function valuesOf(piSettings: PiSettings): Partial<AgentSettingsValues> {
  const settings = piSettings as { compaction?: { enabled?: boolean }; retry?: { enabled?: boolean; maxRetries?: number }; modelThinkingLevels?: Record<string, AgentThinkingLevel> };
  return {
    ...(settings.compaction?.enabled !== undefined ? { autoCompaction: settings.compaction.enabled } : {}),
    ...(settings.retry?.enabled !== undefined ? { autoRetry: settings.retry.enabled } : {}),
    ...(settings.retry?.maxRetries !== undefined ? { maxRetries: settings.retry.maxRetries } : {}),
    ...(settings.modelThinkingLevels ? { modelThinkingLevels: settings.modelThinkingLevels } : {}),
  };
}

/** 和 Pi 一样：只认 always 和 never，其余（包括没写）都是 ask。 */
function defaultProjectTrustOf(config: Record<string, unknown>): DefaultProjectTrust {
  return config.defaultProjectTrust === "always" || config.defaultProjectTrust === "never" ? config.defaultProjectTrust : "ask";
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface FileState {
  readonly hash: string;
  readonly text?: string;
  /** 解析好的整个文件；文件不存在时是空对象，读不了或不是有效 JSON 时缺省。 */
  readonly config?: Record<string, unknown>;
  readonly mode?: number;
  readonly error?: string;
}

export interface AgentSettingsFileOptions {
  readonly warn?: (message: string) => void;
  /** 有会话在用时检查文件的间隔。 */
  readonly pollMs?: number;
  /** 项目是否信任；没有时不读任何项目的 .pi/settings.json。 */
  readonly isProjectTrusted?: (projectCwd: string) => boolean;
}

function fileSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

/** 读 settings.json：不跟随符号链接，不超过 1 MiB，允许 BOM 和空文件。 */
function readSettingsFile(path: string): FileState {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hash: ABSENT_HASH, config: {} };
    return { hash: ABSENT_HASH, error: `${path} 读不了` };
  }
  if (stat.isSymbolicLink()) return { hash: ABSENT_HASH, error: `${path} 是符号链接，Web 上不能修改，请在终端里改` };
  if (!stat.isFile()) return { hash: ABSENT_HASH, error: `${path} 不是普通文件` };
  if (stat.size > MAX_FILE_BYTES) return { hash: ABSENT_HASH, error: `${path} 超过 1 MiB` };
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { return { hash: ABSENT_HASH, error: `${path} 读不了` }; }
  const hash = hashOf(text);
  let config: unknown;
  // 不回显 JSON.parse 的原文片段；Pi 和 pi CLI 一样允许 BOM。
  try { config = text.trim() === "" ? {} : JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { return { hash, text, error: `${path} 不是有效的 JSON` }; }
  if (!isRecord(config)) return { hash, text, error: `${path} 的内容要是一个对象` };
  return { hash, text, config, mode: stat.mode & 0o777 };
}

/** 一个会话所在项目的 .pi/settings.json。 */
interface ProjectSettings {
  readonly cwd: string;
  readonly path: string;
  /** 信任状态加文件签名；变了才重新读。 */
  signature?: string;
  piSettings: PiSettings;
}

/** Pi 全局 settings.json 中 Agent 设置的读写。同一进程里的写入排队执行。 */
export class AgentSettingsFile {
  readonly #options: AgentSettingsFileOptions;
  #queue: Promise<unknown> = Promise.resolve();
  #signature: string | undefined;
  #values: AgentSettingsValues = { ...AGENT_SETTINGS_DEFAULTS, modelThinkingLevels: {} };
  #piSettings: PiSettings = {};
  #defaultProjectTrust: DefaultProjectTrust = "ask";
  #liveError: string | undefined;
  /** 会话的 SettingsManager 及其项目设置（没给项目时缺省）。 */
  readonly #managers = new Map<SettingsManager, ProjectSettings | undefined>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly path: string, options: AgentSettingsFileOptions = {}) {
    this.#options = options;
  }

  /** 服务正在用的值。 */
  get values(): AgentSettingsValues {
    this.#refresh();
    return this.#values;
  }

  /** 全局 settings.json 里的 defaultProjectTrust。 */
  get defaultProjectTrust(): DefaultProjectTrust {
    this.#refresh();
    return this.#defaultProjectTrust;
  }

  /**
   * GET /v1/settings；admin 另外拿到文件位置、hash 和读取错误。给了项目目录、而项目有 .pi/settings.json 时
   * 另外说明它覆盖了哪几项。
   */
  view(isAdmin: boolean, projectCwd?: string): AgentSettings {
    const values = this.values;
    const project = projectCwd === undefined ? undefined : this.projectView(projectCwd);
    const withProject = project ? { project } : {};
    if (!isAdmin) return { canEdit: false, values, defaults: AGENT_SETTINGS_DEFAULTS, ...withProject };
    const state = this.#read();
    const error = state.error ?? this.#liveError;
    return { canEdit: true, values, defaults: AGENT_SETTINGS_DEFAULTS, file: { path: this.path, hash: state.hash, ...(error ? { error } : {}) }, ...withProject };
  }

  /** 项目 .pi/settings.json 写了的几项；文件不存在时没有，项目不受信任时不读文件。 */
  projectView(projectCwd: string): AgentSettingsProject | undefined {
    const path = join(projectCwd, ".pi", "settings.json");
    if (fileSignature(path) === "missing") return undefined;
    if (!(this.#options.isProjectTrusted?.(projectCwd) ?? false)) return { path, trusted: false, values: {} };
    const state = readSettingsFile(path);
    if (!state.config) return { path, trusted: true, values: {}, ...(state.error ? { error: state.error } : {}) };
    const parsed = parseAgentSettings(state.config);
    return {
      path, trusted: true, values: valuesOf(parsed.piSettings),
      ...(parsed.problems.length > 0 ? { error: `${parsed.problems.join("；")}；这些项不生效` } : {}),
    };
  }

  /** 这个项目的会话实际用的按模型思考档位：全局的，再叠加信任项目的 .pi/settings.json。 */
  modelThinkingLevelsFor(projectCwd: string): Readonly<Record<string, AgentThinkingLevel>> {
    const project = this.projectView(projectCwd)?.values.modelThinkingLevels;
    return project ? { ...this.values.modelThinkingLevels, ...project } : this.values.modelThinkingLevels;
  }

  /**
   * 给一个会话用的 SettingsManager：只看得到 Agent 设置，会话里的改动留在内存里不写回文件。
   * 给了项目目录并且项目受信任时，项目 .pi/settings.json 里的这几个字段叠加在全局之上。
   * 会话结束时调用 release。
   */
  createSettingsManager(projectCwd?: string): { manager: SettingsManager; release: () => void } {
    this.#refresh();
    const project: ProjectSettings | undefined = projectCwd === undefined
      ? undefined
      : { cwd: projectCwd, path: join(projectCwd, ".pi", "settings.json"), piSettings: {} };
    if (project) this.#refreshProject(project);
    const storage: PiSettingsStorage = {
      withLock: (scope, fn) => {
        const settings = scope === "global" ? this.#piSettings : project?.piSettings;
        fn(settings ? JSON.stringify(settings) : undefined);
      },
    };
    const manager = SettingsManager.fromStorage(storage);
    this.#managers.set(manager, project);
    this.#startPolling();
    return {
      manager,
      release: () => {
        this.#managers.delete(manager);
        if (this.#managers.size === 0) this.#stopPolling();
      },
    };
  }

  /** 在文件内容的 hash 仍是 `expectedHash` 时修改给出的项并写回。 */
  update(expectedHash: string, values: Partial<AgentSettingsValues>): Promise<void> {
    const run = this.#queue.then(() => this.#update(expectedHash, values));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.#managers.clear();
    this.#stopPolling();
  }

  async #update(expectedHash: string, values: Partial<AgentSettingsValues>): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const release = await lockfile.lock(this.path, { realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } });
    try {
      const state = this.#read();
      if (state.hash !== expectedHash) throw new AgentSettingsError("conflict", "settings.json 已在别处修改，请刷新后再改");
      if (state.error || !state.config) invalid(`${state.error ?? "settings.json 读不了"}；请先在终端里修好`);
      const next = applyAgentSettings(state.config, values);
      this.#write(JSON.stringify(next, null, 2), state.mode ?? 0o600);
    } finally {
      await release();
    }
    this.#refresh();
  }

  #read(): FileState {
    return readSettingsFile(this.path);
  }

  #refresh(): void {
    const path = this.path;
    const signature = fileSignature(path);
    if (signature === this.#signature) return;
    this.#signature = signature;
    const state = signature === "unreadable" ? { hash: ABSENT_HASH, error: `${path} 读不了` } : this.#read();
    if (!state.config) {
      this.#liveError = state.error;
      this.#options.warn?.(`Agent settings: ${state.error ?? `${path} cannot be read`}; keeping the settings read before`);
      return;
    }
    const parsed = parseAgentSettings(state.config);
    this.#values = parsed.values;
    this.#piSettings = parsed.piSettings;
    this.#defaultProjectTrust = defaultProjectTrustOf(state.config);
    this.#liveError = parsed.problems.length > 0 ? `${parsed.problems.join("；")}；这些项按默认值处理` : undefined;
    for (const problem of parsed.problems) this.#options.warn?.(`Agent settings: ${problem}`);
    for (const manager of this.#managers.keys()) void manager.reload().catch(() => {});
  }

  /** 重新判断项目信任、检查项目 .pi/settings.json；有变化时返回 true。写坏时继续用上一次读成功的内容。 */
  #refreshProject(project: ProjectSettings): boolean {
    const trusted = this.#options.isProjectTrusted?.(project.cwd) ?? false;
    const signature = trusted ? fileSignature(project.path) : "untrusted";
    if (signature === project.signature) return false;
    project.signature = signature;
    if (!trusted) {
      project.piSettings = {};
      return true;
    }
    const state = signature === "unreadable" ? { hash: ABSENT_HASH, error: `${project.path} 读不了` } : readSettingsFile(project.path);
    if (!state.config) {
      this.#options.warn?.(`Agent settings: ${state.error ?? `${project.path} cannot be read`}; keeping the project settings read before`);
      return false;
    }
    const parsed = parseAgentSettings(state.config);
    for (const problem of parsed.problems) this.#options.warn?.(`Agent settings: ${project.path}: ${problem}`);
    project.piSettings = parsed.piSettings;
    return true;
  }

  #poll(): void {
    this.#refresh();
    for (const [manager, project] of this.#managers) {
      if (project && this.#refreshProject(project)) void manager.reload().catch(() => {});
    }
  }

  #startPolling(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#poll(), this.#options.pollMs ?? DEFAULT_POLL_MS);
    this.#timer.unref?.();
  }

  #stopPolling(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 先写同目录的临时文件再改名，读的一方不会看到写了一半的文件。 */
  #write(text: string, mode: number): void {
    const temp = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(temp, "wx", mode);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      rmSync(temp, { force: true });
      throw error;
    }
    closeSync(fd);
    try {
      renameSync(temp, this.path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
