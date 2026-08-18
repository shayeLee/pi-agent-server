// 会话索引存储端口（application 层正式契约）。
// SQLite 等具体存储由 adapter 实现，应用层不依赖具体 repository。

export interface SessionRecord {
  id: string;
  ownerKey: string; // = identityKey(UserIdentity)，用于按 owner 隔离（needs.md §4.2）
  /** 所属项目 id；默认项目为 "default"（服务端固定工作目录）。 */
  projectId: string;
  title: string;
  createdAt: number; // 毫秒时间戳
  updatedAt: number; // 毫秒时间戳
  /** Pi 会话文件（JSONL）路径；首次发消息时懒创建并记录，重启后据此恢复对话历史。 */
  piSessionFile: string | null;
  /** 模型 provider（null = 服务端默认）。 */
  modelProvider: string | null;
  /** 模型 id（null = 服务端默认）。 */
  modelId: string | null;
  /** 思考级别（null = 服务端默认，off/minimal/low/medium/high/xhigh/max）。 */
  thinkingLevel: string | null;
  /** 创建会话时生效的系统提示词（null = 未记录）。 */
  systemPrompt: string | null;
  /** 创建会话时冻结的能力版本快照（JSON: id→version；null = 无能力）。 */
  capabilityVersions: string | null;
}

export interface SessionRecordPatch {
  title?: string;
  updatedAt?: number;
  piSessionFile?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
  systemPrompt?: string | null;
}

export interface SessionStorePort {
  create(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  listByOwner(ownerKey: string): Promise<SessionRecord[]>;
  /** 按项目列出会话（owner + project 双重隔离）。 */
  listByProject(ownerKey: string, projectId: string): Promise<SessionRecord[]>;
  /** 为历史会话补写首次启用此字段时的系统提示词；已有记录不可覆盖。 */
  backfillSystemPrompt(systemPrompt: string): Promise<number>;
  update(id: string, patch: SessionRecordPatch): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}
