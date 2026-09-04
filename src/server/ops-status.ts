// WP5A 最小运维门禁基础：进程级 operation status / readiness 的纯数据模型与渲染。
// 无 I/O、无定时器、不触碰存储：状态由 startServer 在启动路径写入（门禁通过、listen 成功），
// HTTP 层（/readyz、/metrics）只读。任何生产组合（startServer）都注入真实对象；
// buildApp 缺省对象仅用于测试/非生产组合。

export type MigrationGateMode = "off" | "verify";

const MIGRATION_GATE_MODES = new Set<MigrationGateMode>(["off", "verify"]);

/**
 * startServer 入口的 migrationGate 运行时校验（failclosed）：只接受精确字面量 "off" / "verify"；
 * undefined/null → "off"（默认）。任何其他值（JS/typed bypass）在创建任何资源之前拒绝启动，
 * 且回显时绝不包含原始值（统一消息，不泄漏配置内容）。
 */
export function validateMigrationGate(value: unknown): MigrationGateMode {
  if (value === undefined || value === null) return "off";
  if (MIGRATION_GATE_MODES.has(value as MigrationGateMode)) return value as MigrationGateMode;
  throw new Error('migrationGate 只支持 "off" / "verify"（当前值不回显），收到未知值时拒绝启动');
}

/** 安全 label：只暴露方言名，绝不包含连接串/主机/路径。 */
export type StorageDialectLabel = "sqlite" | "postgres" | "unknown";

/**
 * 进程级运行状态（可注入、可原地更新）。
 * - ready：安全启动已完成（存储初始化成功、选用的 migration gate 通过、listen 成功）；
 *   启动失败时进程根本不会监听，ready 恒为 false。
 * - migrationGateVerified：仅当启用 gate（"verify"）且启动校验通过时为 true；
 *   "off" 时恒为 false——ready=true + gate=off 只代表 RC bootstrap 完成，不背书 schema。
 */
export type OperationStatus = {
  ready: boolean;
  /** ready 置真的 epoch 毫秒；未 ready 时为 null。 */
  readyAt: number | null;
  /** 进程启动 epoch 毫秒（metrics start_time/uptime 的稳定基准）。 */
  processStartedAt: number;
  migrationGate: MigrationGateMode;
  migrationGateVerified: boolean;
  storageDialect: StorageDialectLabel;
};

/** 进程启动墙钟时间（进程内恒定；不依赖模块加载时机）。 */
export function processStartTimestamp(): number {
  return Date.now() - process.uptime() * 1000;
}

const DEFAULT_OPERATION_STATUS: Omit<OperationStatus, "processStartedAt"> = {
  ready: false,
  readyAt: null,
  migrationGate: "off",
  migrationGateVerified: false,
  storageDialect: "unknown",
};

export function createOperationStatus(
  partial: Partial<OperationStatus> = {},
): OperationStatus {
  return {
    ...DEFAULT_OPERATION_STATUS,
    processStartedAt: processStartTimestamp(),
    ...partial,
  };
}

/** /readyz 最小 JSON 体：无路径/URL/凭证/版本等敏感状态。 */
export type ReadyzBody = {
  ready: boolean;
  migrationGate: MigrationGateMode;
  /**
   * schema 背书语义：
   * - migrationGate=off → 恒为 "rc-bootstrap"（明确不是 schema 背书）；
   * - migrationGate=verify + 校验通过 → "migration-head"；
   * - migrationGate=verify 但未校验通过 → "not-verified"（配合 ready=false）；
   * - "unknown" 仅用于 failclosed 兜底（含迁移 gate 值未知/状态读取异常）。
   */
  schema: "rc-bootstrap" | "migration-head" | "not-verified" | "unknown";
};

/**
 * Failclosed 有效 readiness（P2）：`ready === true` **且**（gate=off，或 gate=verify 且已校验通过）
 * **且** storageDialect 已知（非 "unknown"）。任何不一致（ready=true 但 verify 未通过）、未知 gate 值
 * 或未知 dialect 一律不算 ready——/readyz 503、/metrics ready 0，绝不误报。
 */
export function isEffectiveReady(
  ops: Pick<
    OperationStatus,
    "ready" | "migrationGate" | "migrationGateVerified" | "storageDialect"
  >,
): boolean {
  if (ops.ready !== true) return false;
  if (ops.storageDialect === "unknown") return false;
  if (ops.migrationGate === "off") return true;
  if (ops.migrationGate === "verify") return ops.migrationGateVerified === true;
  // 未知 gate 值：状态对象损坏，failclosed。
  return false;
}

/**
 * /readyz 渲染。对未知 migrationGate 值抛错（failclosed），由路由统一返回最小兜底体
 * （{ready:false, migrationGate:"off", schema:"unknown"}），与本模块不泄漏内部细节的原则一致。
 */
export function readyzBody(
  ops: Pick<OperationStatus, "ready" | "migrationGate" | "migrationGateVerified" | "storageDialect">,
): ReadyzBody {
  const gate = ops.migrationGate;
  if (gate !== "off" && gate !== "verify") {
    throw new Error("unknown migration gate state; refusing to render readiness");
  }
  const schema: ReadyzBody["schema"] =
    gate === "verify"
      ? ops.migrationGateVerified === true
        ? "migration-head"
        : "not-verified"
      : "rc-bootstrap";
  return { ready: isEffectiveReady(ops), migrationGate: gate, schema };
}

/**
 * Prometheus text exposition（0.0.4）固定小表面：
 * ready、start_time、uptime、migration gate enabled/verified、storage dialect info 标签。
 * 不含 URL/path/session/prompt/DB counts。纯函数：给定状态与 now 输出确定文本。
 */
export function renderMetrics(ops: OperationStatus, now: number): string {
  const startedSeconds = (ops.processStartedAt / 1000).toFixed(3);
  const uptimeSeconds = Math.max(0, now - ops.processStartedAt) / 1000;
  const gate = ops.migrationGate === "verify" ? "verify" : ops.migrationGate === "off" ? "off" : null;
  const gateEnabled = gate === "verify" ? 1 : 0;
  const gateVerified = gate === "verify" && ops.migrationGateVerified === true ? 1 : 0;
  // ready 必须是 failclosed 有效 readiness：不一致/未知状态一律 0。
  const ready = isEffectiveReady(ops) ? 1 : 0;
  const lines = [
    "# HELP pi_agent_server_ready 1 when this process has completed safe startup (storage initialized and the selected migration gate, if enabled, passed); 0 otherwise.",
    "# TYPE pi_agent_server_ready gauge",
    `pi_agent_server_ready ${ready}`,
    "# HELP pi_agent_server_start_time_seconds Process start time as Unix epoch seconds.",
    "# TYPE pi_agent_server_start_time_seconds gauge",
    `pi_agent_server_start_time_seconds ${startedSeconds}`,
    "# HELP pi_agent_server_uptime_seconds Seconds elapsed since process start (clamped at 0).",
    "# TYPE pi_agent_server_uptime_seconds gauge",
    `pi_agent_server_uptime_seconds ${uptimeSeconds.toFixed(3)}`,
    "# HELP pi_agent_server_migration_gate_enabled 1 when the strict startup migration gate is enabled (migrationGate=verify), else 0.",
    "# TYPE pi_agent_server_migration_gate_enabled gauge",
    `pi_agent_server_migration_gate_enabled ${gateEnabled}`,
    "# HELP pi_agent_server_migration_gate_verified 1 when the enabled migration gate passed at startup; 0 when disabled or verification did not pass.",
    "# TYPE pi_agent_server_migration_gate_verified gauge",
    `pi_agent_server_migration_gate_verified ${gateVerified}`,
    "# HELP pi_agent_server_storage_dialect_info Storage dialect label (safe label only; never connection details).",
    "# TYPE pi_agent_server_storage_dialect_info gauge",
    `pi_agent_server_storage_dialect_info{dialect="${ops.storageDialect}"} 1`,
  ];
  return `${lines.join("\n")}\n`;
}