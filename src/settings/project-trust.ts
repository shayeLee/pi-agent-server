// 项目信任（docs/configuration.md「项目信任」）：和 pi CLI 用同一份 `<agentDir>/trust.json`。
// 信任的项目才加载它的 .pi/mcp.json、.pi/settings.json、.pi/SYSTEM.md、.pi/APPEND_SYSTEM.md；
// skills、提示词模板和 AGENTS.md 不看信任，始终加载；项目扩展始终不加载。
//
// 判断顺序和 Pi 一样：trust.json 里离项目最近的一条记录（项目自己或它的上级目录）；没有记录时看全局
// settings.json 的 defaultProjectTrust，always 信任，ask 和 never 都不信任（服务没法像 TUI 那样弹窗问）。
// trust.json 由 TUI 的信任提示、Web 上的 admin（set）或手工维护。写入用 Pi 自己的 ProjectTrustStore，和 CLI 同一个文件锁、
// 同样的格式。读不加锁（锁被占着时 Pi 会直接报错）：每次判断时检查文件的修改时间和大小，改了立即生效；
// 读到写了一半或写坏的文件时继续用上一次读成功的内容。

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { PROJECT_TRUST_FILES, type DefaultProjectTrust, type ProjectTrustView } from "../shared/project-trust.js";

export type { DefaultProjectTrust };

export interface ProjectTrustOptions {
  /** 全局 settings.json 里的 defaultProjectTrust。 */
  readonly defaultTrust: () => DefaultProjectTrust;
  readonly warn?: (message: string) => void;
}

const MAX_FILE_BYTES = 1024 * 1024;

/** 和 Pi 一样按真实路径比较；目录不存在时用原路径。 */
function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function parseTrustFile(text: string): ReadonlyMap<string, boolean> {
  const parsed: unknown = JSON.parse(text.replace(/^﻿/, ""));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("is not a JSON object");
  const decisions = new Map<string, boolean>();
  for (const [key, value] of Object.entries(parsed)) {
    if (value === true || value === false) decisions.set(key, value);
    else if (value !== null) throw new Error(`has a value other than true, false or null for ${JSON.stringify(key).slice(0, 80)}`);
  }
  return decisions;
}

export class ProjectTrust {
  readonly path: string;
  readonly #agentDir: string;
  readonly #options: ProjectTrustOptions;
  #signature: string | undefined;
  #decisions: ReadonlyMap<string, boolean> = new Map();

  constructor(agentDir: string, options: ProjectTrustOptions) {
    this.path = join(agentDir, "trust.json");
    this.#agentDir = agentDir;
    this.#options = options;
  }

  isTrusted(projectCwd: string): boolean {
    return this.status(projectCwd, false).trusted;
  }

  /** 项目是否受信任、依据哪条记录，以及项目里有哪些受信任才加载的文件。 */
  status(projectCwd: string, canEdit: boolean): ProjectTrustView {
    this.#refresh();
    const project = canonical(projectCwd);
    const defaultTrust = this.#options.defaultTrust();
    const files = PROJECT_TRUST_FILES.map(name => ({ name, exists: existsSync(join(projectCwd, name)) }));
    for (let dir = project; ; dir = dirname(dir)) {
      const decision = this.#decisions.get(dir);
      if (decision !== undefined) {
        return { trusted: decision, source: dir === project ? "project" : "parent", ...(dir === project ? {} : { entryPath: dir }), defaultTrust, canEdit, files };
      }
      if (dirname(dir) === dir) break;
    }
    return { trusted: defaultTrust === "always", source: "default", defaultTrust, canEdit, files };
  }

  /**
   * 在 trust.json 里给项目自己记一条信任或不信任（Pi 的 ProjectTrustStore：同一个文件锁、同样的格式）。
   * trust.json 写坏了时抛错，不覆盖。
   */
  set(projectCwd: string, trusted: boolean): void {
    new ProjectTrustStore(this.#agentDir).set(projectCwd, trusted);
    // 同一毫秒内写入时修改时间可能没变，下次判断一定重新读。
    this.#signature = undefined;
  }

  #refresh(): void {
    let signature: string;
    let size = 0;
    try {
      const stat = statSync(this.path);
      signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      size = stat.size;
    } catch (error) {
      signature = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    }
    if (signature === this.#signature) return;
    this.#signature = signature;
    if (signature === "missing") {
      this.#decisions = new Map();
      return;
    }
    try {
      if (signature === "unreadable") throw new Error("cannot be read");
      if (size > MAX_FILE_BYTES) throw new Error("is larger than 1 MiB");
      this.#decisions = parseTrustFile(readFileSync(this.path, "utf8"));
    } catch (error) {
      // 不回显 JSON.parse 的原文片段。
      const reason = error instanceof SyntaxError ? "is not valid JSON" : error instanceof Error ? error.message : String(error);
      this.#options.warn?.(`Project trust: ${this.path} ${reason}; keeping the trust decisions read before`);
    }
  }
}
