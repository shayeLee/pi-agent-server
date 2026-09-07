// 受控只读 DB 引用接口。
// reconcile analyzer 唯一允许接触的 DB 面：session id / project id /
// agent kind / conversation format / conversation ref；绝不选取 owner/title/system_prompt/cwd
// 等任何内容字段。引用本身由对应 ConversationStorage 做 DB-only 的词法校验。

export interface ReconcileReferenceRecord {
  readonly sessionId: string;
  readonly projectId: string;
  /** 当前 Agent 类型；未知值必须由 analyzer/storage fail-closed。 */
  readonly agentKind: string;
  /** 当前会话引用格式；未知值必须由 analyzer/storage fail-closed。 */
  readonly conversationFormat: string;
  /** 不透明会话引用；null = 尚未物化。 */
  readonly conversationRef: string | null;
}

/** 只读引用列表的存储端口：调用方（analyzer/CLI）只依赖此契约。 */
export interface ReconcileReferenceStorePort {
  /** 纯 SELECT：全部会话的只读引用，按 session id 升序（确定性顺序）。 */
  readonly listReconcileReferences: () => Promise<readonly ReconcileReferenceRecord[]>;
}
