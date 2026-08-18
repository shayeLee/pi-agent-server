// 项目索引存储端口（application 层正式契约）。
// 默认项目也落库（owner_key 为空串表示所有用户共享），以便 sessions.project_id 外键 CASCADE 引用它；
// 额外项目按 owner 隔离，删除时由应用层处理关联会话。

/** 默认项目 id（固定，服务端 AGENT_CWD 对应的工作目录）。 */
export const DEFAULT_PROJECT_ID = "default";

export interface ProjectRecord {
  id: string;
  name: string;
  /** Agent 工作目录（绝对路径）；额外项目的 cwd 由创建者指定。 */
  cwd: string;
  ownerKey: string;
  createdAt: number;
}

export interface ProjectStorePort {
  create(record: ProjectRecord): Promise<void>;
  get(id: string): Promise<ProjectRecord | null>;
  listByOwner(ownerKey: string): Promise<ProjectRecord[]>;
  delete(id: string): Promise<boolean>;
  /**
   * 在同一事务内删除项目及其所有会话记录（逻辑删墓碑）：
   * 要么项目与会话都删，要么都保留，避免删除一半留下孤儿会话。
   * 物理清理（runtime/SSE/文件）由应用层在此之后执行。
   * 数据库层另有外键 ON DELETE CASCADE 兑底：即使应用层遗漏，删项目也不会留下孤儿会话。
   */
  deleteProjectWithSessions(projectId: string, sessionIds: string[]): Promise<void>;
  /** 确保默认项目记录存在（INSERT OR IGNORE）：默认项目落库以支持外键 CASCADE。 */
  ensureDefaultProject(record: ProjectRecord): Promise<void>;
}
