// WP4C（方案 A 收敛）受控只读 DB 引用接口。
//
// reconcile analyzer 唯一允许接触的 DB 面：只取 session id / project id /
// pi_session_file 三个标识字段，绝不选取 owner_key/title/system_prompt/cwd
// 等任何内容字段——报告不可能泄漏 prompt 内容。实现必须纯 SELECT；任何
// dialect 的 repository 都必须满足同一运行时契约（见
// tests/storage/reconcile-reference-contract.ts）。pi_session_file 为 null
// 表示懒会话尚未创建（normal unmaterialized 状态，不是 issue）；非 null 值
// 必须是服务预留的绝对规范布局路径（default project →
// DATA_DIR/sessions/<sessionId>/<file>；other project →
// DATA_DIR/projects/<projectId>/sessions/<sessionId>/<file>），合法性由
// analyzer 做纯字符串/lexical 验证（本端口只负责读取，不做任何校验）。

export interface ReconcileReferenceRecord {
  readonly sessionId: string;
  readonly projectId: string;
  /** 会话 JSONL 文件路径（绝对规范布局路径；null = 懒会话尚未创建）。 */
  readonly piSessionFile: string | null;
}

/** 只读引用列表的存储端口：调用方（analyzer/CLI）只依赖此契约。 */
export interface ReconcileReferenceStorePort {
  /** 纯 SELECT：全部会话的只读引用，按 session id 升序（确定性顺序）。 */
  readonly listReconcileReferences: () => Promise<readonly ReconcileReferenceRecord[]>;
}