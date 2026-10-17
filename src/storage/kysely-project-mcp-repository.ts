// 项目级 MCP 设置的 Kysely 实现（SQLite 与 PostgreSQL 共用）。行随项目级联删除。
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./db-schema.js";
import type { ProjectMcpStorePort } from "../application/ports/project-mcp-store-port.js";
import { MCP_EXPOSURES, type McpExposure } from "../mcp/catalog.js";
import type { ProjectMcpServerSetting } from "../mcp/project-settings.js";

function hiddenTools(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export class KyselyProjectMcpRepository implements ProjectMcpStorePort {
  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async list(projectId: string): Promise<ProjectMcpServerSetting[]> {
    const rows = await this.db.selectFrom("project_mcp_servers").selectAll()
      .where("project_id", "=", projectId).orderBy("server_name").execute();
    return rows.map(row => ({
      serverName: row.server_name,
      enabled: Number(row.enabled) !== 0,
      // 新版本写入的未知 exposure 按未设置处理，回落到目录默认值。
      exposure: row.exposure !== null && (MCP_EXPOSURES as readonly string[]).includes(row.exposure) ? row.exposure as McpExposure : null,
      hiddenTools: hiddenTools(row.hidden_tools),
      updatedAt: Number(row.updated_at),
      updatedBy: row.updated_by,
    }));
  }

  async put(projectId: string, setting: ProjectMcpServerSetting): Promise<boolean> {
    const values = {
      enabled: setting.enabled ? 1 : 0,
      exposure: setting.exposure,
      hidden_tools: JSON.stringify(setting.hiddenTools),
      updated_at: setting.updatedAt,
      updated_by: setting.updatedBy,
    };
    const exists = async () => (await this.db.selectFrom("projects").select("id").where("id", "=", projectId).executeTakeFirst()) !== undefined;
    if (!(await exists())) return false;
    try {
      await this.db.insertInto("project_mcp_servers").values({ project_id: projectId, server_name: setting.serverName, ...values })
        .onConflict(conflict => conflict.columns(["project_id", "server_name"]).doUpdateSet(values)).execute();
    } catch (error) {
      // 项目在两步之间被删除时外键拒绝写入，按项目不存在处理。
      if (!(await exists())) return false;
      throw error;
    }
    return true;
  }
}
