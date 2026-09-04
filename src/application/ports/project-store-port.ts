// 项目索引存储端口（application 层正式契约）。
// 默认项目也落库（owner_key 为空串表示所有用户共享），以便 sessions.project_id 外键 CASCADE 引用它；
// 额外项目按 owner 隔离，删除时由应用层处理关联会话。

/**
 * 默认项目 id（固定合法 UUID，服务端 AGENT_CWD 对应的工作目录；共享、不可删）。
 * 该 id 是唯一事实来源，由同一常量统一引用：bootstrap 的 sessions.project_id 默认值
 * （defaultTo(DEFAULT_PROJECT_ID)）、ensureDefaultProject 种子、服务端默认 cwd 解析、
 * DELETE 防护与 Web 侧默认项目推导均不得硬编码字符串。
 */
export const DEFAULT_PROJECT_ID = "6f1a2b3c-4d5e-4f6a-8b9c-0d1e2f3a4b5c";

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
  /** 删除项目及其文件清理操作入队由 repository 同一事务完成；不执行 unlink。 */
  delete(id: string): Promise<boolean>;
  /**
   * 在同一事务内锁住项目父行（PG `FOR UPDATE`；SQLite `BEGIN IMMEDIATE`），列出并删除项目及其所有会话记录（逻辑删墓碑）：
   * 要么项目与会话都删，要么都保留，避免删除一半留下孤儿会话。
   * 物理文件清理不在此处执行：本事务只向持久 file_operations outbox enqueue，
   * runtime/SSE 由应用层随后清理，文件由未来 worker 处理。
   * 数据库层另有外键 ON DELETE CASCADE 兑底：即使应用层遗漏，删项目也不会留下孤儿会话；父行锁同时阻止 FK insert 与删除之间的竞态。
   * file_operations 不设 FK，避免 outbox 被级联丢弃。
   */
  deleteProjectWithSessions(projectId: string, sessionIds: string[]): Promise<void>;
  /**
   * Repository-native variant: returns the exact session ids deleted while the
   * parent lock/list/enqueue/delete transaction is held. Optional for legacy
   * in-memory adapters; production repositories should implement it so the
   * application never needs an unlocked pre-delete session snapshot.
   */
  deleteProjectWithSessionsAndReturnSessionIds?(projectId: string, sessionIds: string[]): Promise<readonly string[]>;
  /** 确保默认项目记录存在（INSERT OR IGNORE）：默认项目落库以支持外键 CASCADE。 */
  ensureDefaultProject(record: ProjectRecord): Promise<void>;
}
