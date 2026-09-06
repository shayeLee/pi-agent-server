// WP5A 最小运维门禁基础：进程级 operation status / readiness 的纯数据模型与渲染。
// 无 I/O、无定时器、不触碰存储：状态由 startServer 在启动路径写入（门禁通过、listen 成功），
// HTTP 层（/readyz、/metrics）只读。任何生产组合（startServer）都注入真实对象；
// buildApp 缺省对象仅用于测试/非生产组合。

export type MigrationGateMode = "off" | "verify";

const MIGRATION_GATE_MODES = new Set<MigrationGateMode>(["off", "verify"]);

/**
 * startServer 入口的 migrationGate 运行时校验：只接受精确字面量 "off" / "verify"；
 * undefined/null → "verify"。`off` 仅在随后 enforceDataModeGate 中被统一拒绝；将
 * 词法校验与部署策略分开保留状态对象/测试隔离兼容性。
 */
export function validateMigrationGate(value: unknown): MigrationGateMode {
  if (value === undefined || value === null) return "verify";
  if (MIGRATION_GATE_MODES.has(value as MigrationGateMode)) return value as MigrationGateMode;
  throw new Error('migrationGate 只支持 "off" / "verify"（当前值不回显），收到未知值时拒绝启动');
}

/**
 * 数据模式保留用于区分部署配置，但不改变启动迁移安全边界：所有模式都必须先离线建立
 * 并 verify 单一基线；服务启动不接受 off，也不执行 bootstrap/migration/reset。
 */
export type DataMode = "managed" | "rc";

const DATA_MODES = new Set<DataMode>(["managed", "rc"]);

/**
 * startServer 入口的 dataMode 运行时校验（failclosed）：只接受精确字面量 "managed" / "rc"；
 * undefined/null → "managed"（Phase 3 默认）。任何其他值（JS/typed bypass）在创建任何资源
 * 之前拒绝启动，且回显时绝不包含原始值（统一消息，不泄漏配置内容）。
 */
export function validateDataMode(value: unknown): DataMode {
  if (value === undefined || value === null) return "managed";
  if (DATA_MODES.has(value as DataMode)) return value as DataMode;
  throw new Error('dataMode 只支持 "managed" / "rc"（当前值不回显），收到未知值时拒绝启动');
}

/**
 * managed/rc 仅为部署分类；两者均必须先离线迁移并 verify，服务启动不能自行
 * bootstrap baseline 或接受 migrationGate="off"。
 */
export function enforceDataModeGate(_dataMode: DataMode, gate: MigrationGateMode): void {
  if (gate === "off") {
    throw new Error('dataMode=managed 必须搭配 migrationGate "verify"；migrationGate "off" 已删除，服务必须先由离线 migration 建立并 verify 基线（当前值不回显）');
  }
}

/** 安全 label：只暴露方言名，绝不包含连接串/主机/路径。 */
export type StorageDialectLabel = "sqlite" | "postgres" | "unknown";

/**
 * 进程级运行状态（可注入、可原地更新）。
 * - ready：安全启动已完成（存储初始化成功、选用的 migration gate 通过、listen 成功）；
 *   启动失败时进程根本不会监听，ready 恒为 false。
 * - migrationGateVerified：服务入口只会注入 verify，且仅在启动门禁通过时为 true；
 *   off 仅是非生产状态对象兼容值。
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
  // 与 Phase 3 默认一致：gate 缺省 = "verify"（未校验通过 → 恒 not-ready，failclosed）。
  migrationGate: "verify",
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
   * schema 背书语义：服务启动只接受 verify；成功为 "migration-head"，否则为
   * "not-verified"。"rc-bootstrap" 仅保留给非生产状态对象兼容测试。
   */
  schema: "rc-bootstrap" | "migration-head" | "not-verified" | "unknown";
};

/**
 * Failclosed 有效 readiness（P2）：`ready === true` **且**（gate=off，或 gate=verify 且已校验通过）
 * **且** storageDialect 已知（非 "unknown"）。服务入口永不注入 off；它只保留给非生产状态对象。
 * 任何不一致、未知 gate 值或未知 dialect 一律不算 ready。
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
  return false;
}

/**
 * /readyz 渲染。对未知 migrationGate 值抛错（failclosed），由路由统一返回最小兜底体
 * （{ready:false, migrationGate:"verify", schema:"unknown"}），与本模块不泄漏内部细节的原则一致。
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