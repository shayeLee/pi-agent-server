// 会话索引存储端口（application 层正式契约）。
// SQLite 等具体存储由 adapter 实现，应用层不依赖具体 repository。

export interface SessionRecord {
  id: string;
  ownerKey: string; // = identityKey(UserIdentity)，用于按 owner 隔离（needs.md §4.2）
  /** 所属项目 id；默认项目恒为 DEFAULT_PROJECT_ID（服务端固定工作目录，见 project-store-port.ts）。 */
  projectId: string;
  title: string;
  createdAt: number; // 毫秒时间戳
  updatedAt: number; // 毫秒时间戳
  /** Agent 类型；当前实现为 "pi"。 */
  agentKind: string;
  /** 会话引用格式；当前实现为 "pi-jsonl-v3"。 */
  conversationFormat: string;
  /** Agent 会话引用；首次真正运行前为空，具体语义由对应 factory/storage 解释。 */
  conversationRef: string | null;
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
  modelProvider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
  systemPrompt?: string | null;
}

/**
 * 为新会话 reservation 提供的输入。conversationRef 是要写入的实际引用；
 * tombstoneOperationKey 是对应 artifact 的持久删除键，用于把删除的 outbox 行
 * 当作永久 tombstone：只要 file_operations 存在该键（无论 pending/processing/
 * completed/failed 任一状态），reservation 一律拒绝，即禁止复用已删除的 artifact。
 */
export type ConversationReservationInput = {
  readonly conversationRef: string;
  /** 该 artifact 的删除/tombstone operationKey（由 ConversationStorage.planCleanup 生成）。 */
  readonly tombstoneOperationKey: string;
};

export interface SessionStorePort {
  create(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  listByOwner(ownerKey: string): Promise<SessionRecord[]>;
  /** 按项目列出会话（owner + project 双重隔离）。 */
  listByProject(ownerKey: string, projectId: string): Promise<SessionRecord[]>;
  /** 对 system_prompt 为 NULL 的记录做防御性补齐；已有记录不可覆盖。 */
  backfillSystemPrompt(systemPrompt: string): Promise<number>;
  update(id: string, patch: SessionRecordPatch): Promise<boolean>;
  /**
   * 原子 reservation：只在 conversation_ref 仍为 NULL，且 file_operations 不存在
   * tombstoneOperationKey（任意状态都视为 tombstone，永久禁止复用）时写入。
   * false 表示会话不存在、已被其他创建者占用，或其 artifact 已被删除。
   */
  reserveConversation(id: string, reservation: ConversationReservationInput): Promise<boolean>;
  /**
   * 原子完成 reservation：只在当前引用仍为 expectedRef 时确认实际引用。
   * false 表示会话已被删除或 reservation 已不再属于调用方，调用方不得覆盖当前值。
   */
  commitConversationReservation(id: string, expectedRef: string, actualRef: string): Promise<boolean>;
  /** 仅当当前引用仍等于 expectedRef 时清除 reservation；仅用于确认未物化的失败路径。 */
  releaseConversationReservation(id: string, expectedRef: string): Promise<boolean>;
  /** 删除与 file_operations enqueue 在 repository 的同一数据库事务内完成；不执行文件副作用。 */
  delete(id: string): Promise<boolean>;
}
