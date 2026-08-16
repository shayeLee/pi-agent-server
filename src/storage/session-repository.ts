// 会话索引存储抽象（README §4.1 / docs/architecture.md 步骤 5）
// 服务库侧会话索引经 repository 接口读写；外部依赖（SQLite 等）经实现类接入，
// 核心逻辑不感知具体存储，预留外部数据库迁移。

export interface SessionRecord {
  id: string;
  ownerKey: string; // = identityKey(UserIdentity)，用于按 owner 隔离（README §4.2）
  title: string;
  createdAt: number; // 毫秒时间戳
  updatedAt: number; // 毫秒时间戳
  /** Pi 会话文件（JSONL）路径；首次发消息时懒创建并记录，重启后据此恢复对话历史。 */
  piSessionFile: string | null;
}

export interface SessionRepository {
  create(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  listByOwner(ownerKey: string): Promise<SessionRecord[]>;
  update(
    id: string,
    patch: { title?: string; updatedAt?: number; piSessionFile?: string | null },
  ): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}