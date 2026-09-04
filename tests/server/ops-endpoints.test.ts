// WP5A 最小运维门禁基础（HTTP 层）：/readyz 与 /metrics 契约。
// 全部经 buildApp + Fastify inject，不启动服务、不触碰存储的启动路径。
// 覆盖：/health liveness 语义不变；/readyz 200/503 与 schema 背书语义；
// GET only；Cache-Control no-store；/metrics 固定小表面与格式稳定性；failclosed 不泄漏。
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.js";
import {
  createOperationStatus,
  isEffectiveReady,
  readyzBody,
  renderMetrics,
  type OperationStatus,
} from "../../src/server/ops-status.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";

async function makeApp(ops: OperationStatus): Promise<FastifyInstance> {
  const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
  const app = buildApp({
    sessions,
    projects,
    defaultProjectCwd: "/tmp/default-project",
    defaultModel: null,
    modelCatalog: {
      getAvailable: async () => [],
      isAvailable: async () => false,
    },
    authenticate: async () => ({ kind: "ip", ip: "127.0.0.1" }),
    createAdapter: async () => {
      throw new Error("unused");
    },
    ops,
  });
  return app;
}

const FIXED_NOW = 1_736_000_000_000;

describe("WP5A /readyz（进程 readiness + migration gate 背书语义）", () => {
  it("/health 保持 liveness 语义不变（免鉴权 { status: ok }）", async () => {
    const app = await makeApp(createOperationStatus());
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });

  it("no gate：ready=true 明确是 RC bootstrap ready，不背书 schema", async () => {
    const ops = createOperationStatus({
      ready: true,
      readyAt: FIXED_NOW,
      processStartedAt: FIXED_NOW - 10_000,
      migrationGate: "off",
      storageDialect: "sqlite",
    });
    const app = await makeApp(ops);
    try {
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({ ready: true, migrationGate: "off", schema: "rc-bootstrap" });
      // 响应体绝不含任何敏感字面量。
      expect(JSON.stringify(res.json())).not.toMatch(/auth|token|url|path|session|prompt|secret/i);
    } finally {
      await app.close();
    }
  });

  it("gate=verify 且校验通过：ready=true 且 schema=migration-head", async () => {
    const ops = createOperationStatus({
      ready: true,
      readyAt: FIXED_NOW,
      processStartedAt: FIXED_NOW - 10_000,
      migrationGate: "verify",
      migrationGateVerified: true,
      storageDialect: "sqlite",
    });
    const app = await makeApp(ops);
    try {
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ready: true, migrationGate: "verify", schema: "migration-head" });
    } finally {
      await app.close();
    }
  });

  it("not ready：503 ready=false，且不误报 schema 背书", async () => {
    const ops = createOperationStatus({
      ready: false,
      processStartedAt: FIXED_NOW,
      migrationGate: "verify",
      migrationGateVerified: false,
      storageDialect: "postgres",
    });
    const app = await makeApp(ops);
    try {
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({ ready: false, migrationGate: "verify", schema: "not-verified" });
    } finally {
      await app.close();
    }
  });

  it("状态对象可变：逐请求反映最新状态，无缓存", async () => {
    const ops = createOperationStatus({ ready: true, migrationGate: "off", storageDialect: "sqlite" });
    const app = await makeApp(ops);
    try {
      expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
      ops.ready = false;
      ops.readyAt = null;
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ready: false, migrationGate: "off", schema: "rc-bootstrap" });
    } finally {
      await app.close();
    }
  });

  it("preClose 钩子把 ops.ready 拉低：关闭开始即不误报 ready", async () => {
    const ops = createOperationStatus({ ready: true, migrationGate: "off", storageDialect: "sqlite" });
    const app = await makeApp(ops);
    try {
      expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
    expect(ops.ready).toBe(false);
    expect(ops.readyAt).toBeNull();
  });

  it("GET only：POST/PUT/DELETE 不返回 readiness 体；HEAD 404（route-level exposeHeadRoute:false）", async () => {
    const ops = createOperationStatus({ ready: true, migrationGate: "off", storageDialect: "sqlite" });
    const app = await makeApp(ops);
    try {
      // /readyz 是 strict GET-only（route-level 禁用 HEAD/其他方法）：都不返回 readiness 体。
      for (const method of ["POST", "PUT", "DELETE", "HEAD"] as const) {
        const res = await app.inject({ method, url: "/readyz" });
        expect([404, 405]).toContain(res.statusCode);
        expect(res.body).not.toMatch(/\"ready\":true/);
      }
      // GET 仍是唯一被接受的语义（HEAD 被禁用后 GET 不受影响）。
      expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("HEAD 语义：全局保留 Fastify 默认 HEAD（/health、/v1 照常）；仅 /readyz、/metrics route-level 禁用 HEAD（404）", async () => {
    const ops = createOperationStatus({ ready: true, migrationGate: "off", storageDialect: "sqlite" });
    const app = await makeApp(ops);
    try {
      // 全局保留 Fastify 默认 HEAD 暴露：HEAD /health 自动可用（200、空体、content-length 反映 GET 载荷）。
      const headHealth = await app.inject({ method: "HEAD", url: "/health" });
      expect(headHealth.statusCode).toBe(200);
      expect(headHealth.body).toBe("");
      expect(headHealth.headers["content-length"]).toBe(String(Buffer.byteLength('{"status":"ok"}')));
      // /readyz、/metrics 仅 route-level exposeHeadRoute:false：HEAD 404，GET 语义不受影响。
      expect((await app.inject({ method: "HEAD", url: "/readyz" })).statusCode).toBe(404);
      expect((await app.inject({ method: "HEAD", url: "/metrics" })).statusCode).toBe(404);
      // 既有 GET 回归（health/v1）：/health、/readyz、/metrics、/v1/models 全部照常。
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/v1/models" })).statusCode).toBe(200);
      // /v1 既有 GET（models）的 HEAD 也自动可用（200、空体）——全局默认未被砍。
      const headModels = await app.inject({ method: "HEAD", url: "/v1/models" });
      expect(headModels.statusCode).toBe(200);
      expect(headModels.body).toBe("");
    } finally {
      await app.close();
    }
  });

  it("failclosed 有效 readiness：ready=true 但与 gate=verify 未校验一致时 → 503，绝不误报", async () => {
    const ops = createOperationStatus({
      ready: true,
      readyAt: FIXED_NOW,
      processStartedAt: FIXED_NOW - 10_000,
      migrationGate: "verify",
      migrationGateVerified: false,
      storageDialect: "sqlite",
    });
    const app = await makeApp(ops);
    try {
      // 不一致：ready=true 但 verify 未通过 → 503，body ready=false（failclosed）。
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ready: false, migrationGate: "verify", schema: "not-verified" });
      // 状态补齐后立即恢复 200（逐请求反映最新状态）。
      ops.migrationGateVerified = true;
      const ok = await app.inject({ method: "GET", url: "/readyz" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ready: true, migrationGate: "verify", schema: "migration-head" });
    } finally {
      await app.close();
    }
  });

  it("failclosed：storageDialect=unknown（状态对象未初始化）即使 ready=true 也 503", async () => {
    // storageDialect 缺省 "unknown"：未知 → 不 ready（buildApp 未注入 ops 的缺省对象同此语义）。
    const ops = createOperationStatus({ ready: true, migrationGate: "off" });
    const app = await makeApp(ops);
    try {
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ready: false, migrationGate: "off", schema: "rc-bootstrap" });
    } finally {
      await app.close();
    }
  });

  it("buildApp 未注入 ops：缺省对象恒未就绪，/readyz 503、/metrics ready 0（不误报）", async () => {
    // 缺省 ops 只用于测试/非生产组合：绝不能声称就绪。
    const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
    const app = buildApp({
      sessions,
      projects,
      defaultProjectCwd: "/tmp/default-project",
      defaultModel: null,
      modelCatalog: {
        getAvailable: async () => [],
        isAvailable: async () => false,
      },
      authenticate: async () => ({ kind: "ip", ip: "127.0.0.1" }),
      createAdapter: async () => {
        throw new Error("unused");
      },
    });
    try {
      const readyz = await app.inject({ method: "GET", url: "/readyz" });
      expect(readyz.statusCode).toBe(503);
      expect(readyz.json().ready).toBe(false);
      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.body).toContain("pi_agent_server_ready 0");
    } finally {
      await app.close();
    }
  });

  it("failclosed：未知 migrationGate 值 → readyzBody 抛错（failclosed），路由 503 最小兜底体，metrics ready/enabled=0", async () => {
    const ops = createOperationStatus({ ready: true, migrationGate: "off", storageDialect: "sqlite" });
    // JS bypass：把 gate 改成未知值；ready 保持普通可写属性（preClose 会置 false）。
    Object.defineProperty(ops, "migrationGate", {
      value: "unknown-gate-bypass",
      writable: true,
      configurable: true,
    });
    const app = await makeApp(ops);
    try {
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({ ready: false, migrationGate: "off", schema: "unknown" });
      expect(res.body).not.toMatch(/unknown-gate-bypass|Error|stack/i);
      // metrics：ready=0、gate enabled/verified=0（failclosed）。
      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.body).toContain("pi_agent_server_ready 0");
      expect(metrics.body).toContain("pi_agent_server_migration_gate_enabled 0");
      expect(metrics.body).toContain("pi_agent_server_migration_gate_verified 0");
      expect(metrics.body).not.toMatch(/unknown-gate-bypass/i);
    } finally {
      await app.close();
    }
  });

  it("failclosed：状态读取异常 → 503 最小兜底体，不泄漏错误内容", async () => {
    const ops = createOperationStatus({ ready: true, migrationGate: "off", storageDialect: "sqlite" });
    // ready 保持普通可写属性（preClose 会置 false）；让 readyzBody 读取 migrationGate 时抛错。
    Object.defineProperty(ops, "migrationGate", {
      get() {
        throw new Error("boom-secret-internal");
      },
    });
    const app = await makeApp(ops);
    try {
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({ ready: false, migrationGate: "off", schema: "unknown" });
      expect(res.body).not.toMatch(/boom-secret-internal|Error|stack/i);
    } finally {
      await app.close();
    }
  });
});

describe("WP5A /metrics（Prometheus text exposition 固定小表面）", () => {
  it("完整格式与值：ready/start_time/uptime/gate/dialect，安全 label", async () => {
    const ops = createOperationStatus({
      ready: true,
      readyAt: FIXED_NOW,
      processStartedAt: FIXED_NOW - 10_000,
      migrationGate: "verify",
      migrationGateVerified: true,
      storageDialect: "postgres",
    });
    const app = await makeApp(ops);
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/plain; version=0\.0\.4/);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = res.body;
      // 固定小表面：恰好这 6 个指标，各自有 # HELP/# TYPE，无任何其他指标。
      for (const name of [
        "pi_agent_server_ready",
        "pi_agent_server_start_time_seconds",
        "pi_agent_server_uptime_seconds",
        "pi_agent_server_migration_gate_enabled",
        "pi_agent_server_migration_gate_verified",
        "pi_agent_server_storage_dialect_info",
      ]) {
        expect(body).toMatch(new RegExp(`# HELP ${name} `));
        expect(body).toMatch(new RegExp(`# TYPE ${name} gauge`));
      }
      const metricLines = body.split("\n").filter((l) => l && !l.startsWith("#"));
      expect(metricLines).toHaveLength(6);
      expect(body).toContain("pi_agent_server_ready 1");
      expect(body).toContain("pi_agent_server_start_time_seconds 1735999990.000");
      // uptime 以请求时的真实 now 计算：只断言可解析非负格式。
      expect(body).toMatch(/pi_agent_server_uptime_seconds \d+\.\d{3}/);
      expect(Number(body.match(/pi_agent_server_uptime_seconds (\d+\.\d{3})/)![1])).toBeGreaterThanOrEqual(0);
      expect(body).toContain("pi_agent_server_migration_gate_enabled 1");
      expect(body).toContain("pi_agent_server_migration_gate_verified 1");
      expect(body).toContain('pi_agent_server_storage_dialect_info{dialect="postgres"} 1');
      // 表层无 URL/path/session/prompt/auth/token/db counts。
      expect(body).not.toMatch(/url|path|session|prompt|auth|token|count|postgresql:\/\//i);
    } finally {
      await app.close();
    }
  });

  it("no gate：enabled=0、verified=0；dialect 安全标签为 sqlite", async () => {
    const ops = createOperationStatus({
      ready: true,
      processStartedAt: FIXED_NOW,
      migrationGate: "off",
      storageDialect: "sqlite",
    });
    const app = await makeApp(ops);
    try {
      const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
      expect(body).toContain("pi_agent_server_migration_gate_enabled 0");
      expect(body).toContain("pi_agent_server_migration_gate_verified 0");
      expect(body).toContain('pi_agent_server_storage_dialect_info{dialect="sqlite"} 1');
    } finally {
      await app.close();
    }
  });

  it("not ready：/metrics 仍 200 但 ready=0（探针可抓取，值反映状态）", async () => {
    const ops = createOperationStatus({
      ready: false,
      processStartedAt: FIXED_NOW,
      migrationGate: "off",
      storageDialect: "unknown",
    });
    const app = await makeApp(ops);
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("pi_agent_server_ready 0");
    } finally {
      await app.close();
    }
  });

  it("格式稳定性：连续两次 GET 除 uptime 外逐行完全一致，uptime 为可解析非负数", async () => {
    const ops = createOperationStatus({
      ready: true,
      processStartedAt: FIXED_NOW,
      migrationGate: "off",
      storageDialect: "sqlite",
    });
    const app = await makeApp(ops);
    try {
      const first = (await app.inject({ method: "GET", url: "/metrics" })).body;
      const second = (await app.inject({ method: "GET", url: "/metrics" })).body;
      const diff = first.split("\n").filter((line, i) => line !== second.split("\n")[i]);
      expect(diff.length).toBeLessThanOrEqual(1);
      if (diff.length === 1) {
        expect(diff[0]).toMatch(/^pi_agent_server_uptime_seconds \d+\.\d{3}$/);
        expect(Number(diff[0]!.split(" ")[1])).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await app.close();
    }
  });

  it("strict GET-only：POST/HEAD 不返回 metrics 文本（route-level HEAD 禁用）", async () => {
    const ops = createOperationStatus({ ready: true, migrationGate: "off", storageDialect: "sqlite" });
    const app = await makeApp(ops);
    try {
      for (const method of ["POST", "HEAD"] as const) {
        const res = await app.inject({ method, url: "/metrics" });
        expect([404, 405]).toContain(res.statusCode);
        expect(res.body).not.toMatch(/pi_agent_server|# HELP/);
      }
      // GET 不受影响（strict GET-only 不是砍掉 GET）。
      expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("failclosed：渲染异常 → 503 空体，不泄漏内部细节", async () => {
    const ops = createOperationStatus({
      ready: true,
      readyAt: FIXED_NOW,
      processStartedAt: FIXED_NOW,
      migrationGate: "off",
      migrationGateVerified: false,
      storageDialect: "sqlite",
    });
    Object.defineProperty(ops, "processStartedAt", {
      get() {
        throw new Error("boom-secret-internal");
      },
    });
    const app = await makeApp(ops);
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(503);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toBe("");
      expect(res.body).not.toMatch(/boom-secret-internal|Error|stack/i);
    } finally {
      await app.close();
    }
  });
});

describe("WP5A 纯渲染函数（确定性快照）", () => {
  it("renderMetrics 对固定状态+now 输出逐字节确定文本（格式冻结）", () => {
    const ops = createOperationStatus({
      ready: true,
      readyAt: FIXED_NOW,
      processStartedAt: FIXED_NOW - 12_345,
      migrationGate: "verify",
      migrationGateVerified: true,
      storageDialect: "sqlite",
    });
    expect(renderMetrics(ops, FIXED_NOW)).toBe(
      [
        "# HELP pi_agent_server_ready 1 when this process has completed safe startup (storage initialized and the selected migration gate, if enabled, passed); 0 otherwise.",
        "# TYPE pi_agent_server_ready gauge",
        "pi_agent_server_ready 1",
        "# HELP pi_agent_server_start_time_seconds Process start time as Unix epoch seconds.",
        "# TYPE pi_agent_server_start_time_seconds gauge",
        "pi_agent_server_start_time_seconds 1735999987.655",
        "# HELP pi_agent_server_uptime_seconds Seconds elapsed since process start (clamped at 0).",
        "# TYPE pi_agent_server_uptime_seconds gauge",
        "pi_agent_server_uptime_seconds 12.345",
        "# HELP pi_agent_server_migration_gate_enabled 1 when the strict startup migration gate is enabled (migrationGate=verify), else 0.",
        "# TYPE pi_agent_server_migration_gate_enabled gauge",
        "pi_agent_server_migration_gate_enabled 1",
        "# HELP pi_agent_server_migration_gate_verified 1 when the enabled migration gate passed at startup; 0 when disabled or verification did not pass.",
        "# TYPE pi_agent_server_migration_gate_verified gauge",
        "pi_agent_server_migration_gate_verified 1",
        "# HELP pi_agent_server_storage_dialect_info Storage dialect label (safe label only; never connection details).",
        "# TYPE pi_agent_server_storage_dialect_info gauge",
        'pi_agent_server_storage_dialect_info{dialect="sqlite"} 1',
        "",
      ].join("\n"),
    );
  });

  it("readyzBody：off/verify 的背书语义、effective readiness 与 failclosed 兜底值", () => {
    expect(
      readyzBody({ ready: true, migrationGate: "off", migrationGateVerified: false, storageDialect: "sqlite" }),
    ).toEqual({
      ready: true,
      migrationGate: "off",
      schema: "rc-bootstrap",
    });
    expect(
      readyzBody({ ready: true, migrationGate: "verify", migrationGateVerified: true, storageDialect: "postgres" }),
    ).toEqual({ ready: true, migrationGate: "verify", schema: "migration-head" });
    expect(
      readyzBody({ ready: false, migrationGate: "verify", migrationGateVerified: false, storageDialect: "sqlite" }),
    ).toEqual({ ready: false, migrationGate: "verify", schema: "not-verified" });
    // failclosed：ready=true 但 verify 未通过 → 返回 ready:false（绝不原样透传 ready）。
    expect(
      readyzBody({ ready: true, migrationGate: "verify", migrationGateVerified: false, storageDialect: "sqlite" }),
    ).toEqual({ ready: false, migrationGate: "verify", schema: "not-verified" });
    // failclosed：未知 gate 值 → 抛错（由路由统一渲染最小兜底体）。
    expect(() =>
      readyzBody({ ready: true, migrationGate: "bogus" as never, migrationGateVerified: false, storageDialect: "sqlite" }),
    ).toThrow(/unknown migration gate/);
  });

  it("isEffectiveReady：ready && (off || verified) 且 dialect 已知才成立", () => {
    const base = { ready: true, migrationGateVerified: false, storageDialect: "sqlite" as const };
    expect(isEffectiveReady({ ...base, migrationGate: "off" as const })).toBe(true);
    expect(isEffectiveReady({ ...base, migrationGate: "verify" as const })).toBe(false); // verify 未通过
    expect(
      isEffectiveReady({ ...base, migrationGate: "verify" as const, migrationGateVerified: true }),
    ).toBe(true);
    expect(isEffectiveReady({ ready: false, migrationGate: "off" as const, migrationGateVerified: false, storageDialect: "sqlite" })).toBe(false);
    // 不一致/未知一律 false：ready=true + verify 未通过、未知 gate 值、dialect unknown。
    expect(isEffectiveReady({ ...base, migrationGate: "bogus" as never })).toBe(false);
    expect(isEffectiveReady({ ready: true, migrationGate: "off" as const, migrationGateVerified: false, storageDialect: "unknown" })).toBe(false);
  });

  it("createOperationStatus 默认值：未 ready、gate off、未验证、dialect unknown（非生产组合仅限显式注入）", () => {
    const ops = createOperationStatus();
    expect(ops.ready).toBe(false);
    expect(ops.readyAt).toBeNull();
    expect(ops.migrationGate).toBe("off");
    expect(ops.migrationGateVerified).toBe(false);
    expect(ops.storageDialect).toBe("unknown");
    expect(ops.processStartedAt).toBeLessThanOrEqual(Date.now());
    expect(ops.processStartedAt).toBeGreaterThan(0);
  });
});