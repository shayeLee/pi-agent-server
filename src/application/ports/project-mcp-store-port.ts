// 项目级 MCP 设置（docs/mcp-integration.md §4.2）：每个项目对目录 server 的启用与收紧，一行一个 server。
import type { ProjectMcpServerSetting } from "../../mcp/project-settings.js";

export interface ProjectMcpStorePort {
  /** 项目的全部设置（含目录里已删除 server 的行）。 */
  list(projectId: string): Promise<ProjectMcpServerSetting[]>;
  /** 新增或替换一个 server 的设置；项目不存在时返回 false。 */
  put(projectId: string, setting: ProjectMcpServerSetting): Promise<boolean>;
}
