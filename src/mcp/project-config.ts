// 项目的 MCP 目录（docs/mcp-integration.md §15）：全局 mcp.json 的目录，加上信任的项目里的 .pi/mcp.json。
// 项目文件和 Pi 一样有两种项：
// - 写了 command、url 或 type：项目自己的 server，和全局 server 同名（含只差 - 与 _）时不用，项目不能替换全局 server。
//   会话里的模型能写项目目录，所以这些 server 一律默认不启用（不认 piAgentServer.defaultEnabled），要 owner 在 Web 上勾选；
//   勾选后命令、参数、cwd、env、地址或 oauth 设置再变，设置就失效，要重新勾选（project-settings.ts 的 mcpServerIdentity）。
//   可以用 oauth：每个用户在 MCP 面板里用自己的账号授权，凭证按项目存（oauth-connections.ts）；
// - 只写 enabled、exposure、toolExposure：改全局同名 server 在这个项目里的默认设置，不能超过全局的 maxExposure，
//   adminOnly server 不能由项目文件默认启用。
// Web 上的项目 MCP 设置在这之上照常生效（只能收紧，见 project-settings.ts）。
// 未信任的项目只用全局目录，项目文件只用来在面板上提示“没有加载”。
// 每次取目录时检查项目文件的修改时间和大小，变了就重新解析；写坏时继续用上一次读成功的内容。

import { readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { exposureRank, type McpCatalog, type McpCatalogServer, type McpExposure } from "./catalog.js";
import { parseProjectPiMcpConfig, type PiMcpUnavailable, type ProjectPiMcpConfig } from "./pi-config.js";

const MAX_FILE_BYTES = 1024 * 1024;

/** 项目 .pi/mcp.json 的状态；文件不存在时没有。 */
export interface ProjectMcpConfigStatus {
  readonly path: string;
  /** 项目不受信任时为 false，文件没有加载。 */
  readonly trusted: boolean;
  /** 最近一次读取失败的原因；这时用的是上一次读成功的内容。 */
  readonly error?: string;
  /** 没有用上的项及原因。 */
  readonly unavailable: readonly PiMcpUnavailable[];
}

export interface ProjectMcpCatalog {
  readonly catalog: McpCatalog;
  readonly status?: ProjectMcpConfigStatus;
}

function widest(exposures: readonly McpExposure[]): McpExposure {
  return exposures.reduce((a, b) => exposureRank(b) > exposureRank(a) ? b : a);
}

/** 全局目录 + 项目文件 → 项目的目录。 */
export function mergeProjectMcpCatalog(global: McpCatalog, project: ProjectPiMcpConfig): { catalog: McpCatalog; unavailable: PiMcpUnavailable[] } {
  const servers = new Map<string, McpCatalogServer>(global.servers);
  const unavailable: PiMcpUnavailable[] = [...project.unavailable];
  for (const override of project.overrides) {
    const base = global.servers.get(override.name);
    if (!base) {
      unavailable.push({ name: override.name, reason: "没有 command 或 url 时是覆盖全局同名 server，但全局 mcp.json 里没有可用的这个 server" });
      continue;
    }
    if (base.adminOnly && override.enabled === true) {
      unavailable.push({ name: override.name, reason: "这个 server 只有管理员能启用，项目文件不能默认启用它" });
      continue;
    }
    const exposure = override.exposure ?? base.exposure;
    const toolExposure = override.toolExposure ?? base.toolExposure;
    if (exposureRank(widest([exposure, ...Object.values(toolExposure)])) > exposureRank(base.maxExposure)) {
      unavailable.push({ name: override.name, reason: `exposure 或 toolExposure 超过了全局设置的上限（${base.maxExposure}）` });
      continue;
    }
    servers.set(override.name, {
      ...base, exposure, toolExposure, defaultEnabled: override.enabled ?? base.defaultEnabled, projectFile: "overridden",
    });
  }
  // SDK 的工具名把 `-` 换成 `_`，仅这两个字符不同的名称会撞名。
  const globalNames = new Map([...global.servers.keys()].map(name => [name.replaceAll("-", "_"), name]));
  for (const server of project.servers) {
    const clash = globalNames.get(server.name.replaceAll("-", "_"));
    if (clash) {
      unavailable.push({ name: server.name, reason: `和全局 mcp.json 里的 ${clash} 重名；项目不能替换全局 server，只能写 enabled、exposure、toolExposure 覆盖它的默认设置` });
      continue;
    }
    servers.set(server.name, { ...server, defaultEnabled: false, projectFile: "defined" });
  }
  return { catalog: { servers }, unavailable };
}

interface CachedFile {
  signature: string;
  config?: ProjectPiMcpConfig;
  error?: string;
}

export interface ProjectMcpCatalogsOptions {
  /** 全局目录（运行中的 mcp.json）。 */
  readonly global: { snapshot(): McpCatalog };
  readonly isTrusted: (projectCwd: string) => boolean;
  /** 服务配置了 PI_MCP_TOKEN_KEY_FILE 与 PI_PUBLIC_URL：项目的 server 也可以用 oauth 让用户各自授权。 */
  readonly oauthEnabled?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly warn?: (message: string) => void;
}

export class ProjectMcpCatalogs {
  readonly #options: ProjectMcpCatalogsOptions;
  readonly #files = new Map<string, CachedFile>();

  constructor(options: ProjectMcpCatalogsOptions) {
    this.#options = options;
  }

  /** 项目的目录快照；会话要用同一份内容建连。 */
  forProject(projectCwd: string): ProjectMcpCatalog {
    const global = this.#options.global.snapshot();
    const path = join(projectCwd, ".pi", "mcp.json");
    let stat: Stats | undefined;
    try { stat = statSync(path); } catch { stat = undefined; }
    if (!stat) {
      this.#files.delete(path);
      return { catalog: global };
    }
    if (!this.#options.isTrusted(projectCwd)) return { catalog: global, status: { path, trusted: false, unavailable: [] } };
    const file = this.#refresh(path, stat);
    if (!file.config) return { catalog: global, status: { path, trusted: true, ...(file.error ? { error: file.error } : {}), unavailable: [] } };
    const merged = mergeProjectMcpCatalog(global, file.config);
    return { catalog: merged.catalog, status: { path, trusted: true, ...(file.error ? { error: file.error } : {}), unavailable: merged.unavailable } };
  }

  #refresh(path: string, stat: Stats): CachedFile {
    const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = this.#files.get(path);
    if (cached?.signature === signature) return cached;
    try {
      if (!stat.isFile()) throw new Error(`${path} must be a regular file`);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`${path} is larger than 1 MiB`);
      let raw: unknown;
      // 不回显 JSON.parse 的原文片段。
      try { raw = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw new Error(`${path} is not valid JSON`); }
      const config = parseProjectPiMcpConfig(raw, { env: this.#options.env ?? process.env, oauthEnabled: this.#options.oauthEnabled ?? false });
      for (const item of config.unavailable) this.#options.warn?.(`MCP: ${path} server "${item.name}" is not used: ${item.reason}`);
      const file = { signature, config };
      this.#files.set(path, file);
      return file;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#options.warn?.(`MCP: ${message}; keeping the project servers read before`);
      const file = { signature, ...(cached?.config ? { config: cached.config } : {}), error: message };
      this.#files.set(path, file);
      return file;
    }
  }
}
