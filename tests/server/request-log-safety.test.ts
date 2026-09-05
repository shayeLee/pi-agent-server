// WP5D-2 请求日志脱敏（安全 serializer + 关闭 Fastify 内置按请求日志 + subjectHash 后置安全日志）：
// - 捕获**真实** pino 序列化后的日志行（经 buildApp 注入的内存 Writable 目的流），
//   allowed / 401 / 403 三类准入结果都断言：
//   不含 raw remoteAddress/remotePort/url/path/query/X-Forwarded-For/Authorization/token；
// - allowed 行带 subjectHash（IP 派生哈希）；denied 行只带固定枚举（无表ID信息）；
// - Fastify 内置 per-request 日志（incoming request / request completed / routeNotFound）被关闭；
// - safeReqSerializer/safeResSerializer 直接单测：给定含敏感字段的伪造 request/reply，输出只剩安全字段。

import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp, safeReqSerializer, safeResSerializer } from "../../src/server/app.js";
import { MockAgentAdapter } from "../../src/agent/mock-agent-adapter.js";
import { makeInitializedMemoryDb } from "../helpers/sqlite.js";
import {
  makePolicy,
  makeTestIpAccess,
  OUTSIDE_IP,
  USER_IP_A,
  USER_IP_B,
} from "../helpers/ip-access.js";

type Capture = { stream: Writable; lines: string[] };

function makeCapture(): Capture {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { stream, lines };
}

async function makeApp(capture: Capture, ipAccess = makeTestIpAccess()): Promise<FastifyInstance> {
  const { sessions, projects } = await makeInitializedMemoryDb({ cwd: "/tmp/default-project" });
  return buildApp({
    sessions,
    projects,
    defaultProjectCwd: "/tmp/default-project",
    ipAccess,
    requestLogStream: capture.stream,
    createAdapter: async () => new MockAgentAdapter(),
  });
}

function subjectHashFor(ip: string): string {
  return createHash("sha256").update(`ip:${ip}`).digest("hex").slice(0, 16);
}

// 常见敏感/原始字段与值：只要它们出现在任何日志行里契约即被破坏。
const SENSITIVE_FRAGMENTS = [
  USER_IP_A, // raw socket IP（10.0.0.1）
  USER_IP_B, // raw socket IP（10.0.0.2）
  OUTSIDE_IP, // raw socket IP（203.0.113.9）
  "/tmp/default-project", // default project cwd（同样不得进日志）
  "/v1/sessions", // url/path
  "/health",
  "secret-token", // 明文 token
  "wrong-token",
  "sekrit-bearer",
  "x-forwarded-for",
  "remoteAddress",
  "remotePort",
  "authorization",
];

function assertNoSensitiveLeak(lines: string[]): void {
  const joined = lines.join("\n");
  for (const fragment of SENSITIVE_FRAGMENTS) {
    expect(joined, `日志不得含敏感片段 ${JSON.stringify(fragment)}`).not.toContain(fragment);
  }
}

describe("WP5D-2 请求日志脱敏（真实 pino 序列化行）", () => {
  it("allowed（200）→ 日志带 subjectHash 且无 raw IP/url/token；无内置 per-request 日志", async () => {
    const capture = makeCapture();
    const app = await makeApp(capture);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: USER_IP_A,
        headers: { authorization: "Bearer sekrit-bearer" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("/tmp/default-project");
    } finally {
      await app.close();
    }
    expect(capture.lines.length).toBeGreaterThan(0);
    const joined = capture.lines.join("\n");
    // allowed 行带 subjectHash（IP 派生哈希）
    expect(joined).toContain(subjectHashFor(USER_IP_A));
    // Fastify 内置 per-request 日志被关闭
    expect(joined).not.toContain('"msg":"incoming request"');
    expect(joined).not.toContain("incoming request");
    expect(joined).not.toContain("request completed");
    assertNoSensitiveLeak(capture.lines);
  });

  it("401（tokenRequired 缺失/错误 token）→ 日志只有固定枚举，无 token/IP/url 泄漏", async () => {
    const policy = makePolicy([{ ip: USER_IP_A, tokenRequired: true, tokens: ["secret-token"] }]);
    const capture = makeCapture();
    const app = await makeApp(capture, makeTestIpAccess({ policy }));
    try {
      const missing = await app.inject({ method: "GET", url: "/v1/sessions", remoteAddress: USER_IP_A });
      expect(missing.statusCode).toBe(401);
      const wrong = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: USER_IP_A,
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(wrong.statusCode).toBe(401);
    } finally {
      await app.close();
    }
    expect(capture.lines.some((l) => l.includes('"admission":"denied"') && l.includes('"reason":"token-required"'))).toBe(true);
    // denied（401）不带 subjectHash（未知客户端不被记录哈希身份）
    expect(capture.lines.join("\n")).not.toContain(subjectHashFor(USER_IP_A));
    assertNoSensitiveLeak(capture.lines);
  });

  it("403（CIDR 外 / disabled）→ 日志只有固定枚举，无 IP/url 泄漏", async () => {
    const policy = makePolicy([{ ip: USER_IP_A, disabled: true }]);
    const capture = makeCapture();
    const app = await makeApp(capture, makeTestIpAccess({ policy }));
    try {
      const outside = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: OUTSIDE_IP,
        headers: { authorization: "Bearer sekrit-bearer" },
      });
      expect(outside.statusCode).toBe(403);
      const disabled = await app.inject({
        method: "GET",
        url: "/health",
        remoteAddress: USER_IP_A,
      });
      expect(disabled.statusCode).toBe(403);
    } finally {
      await app.close();
    }
    expect(capture.lines.some((l) => l.includes('"reason":"outside-cidr"'))).toBe(true);
    expect(capture.lines.some((l) => l.includes('"reason":"disabled"'))).toBe(true);
    assertNoSensitiveLeak(capture.lines);
  });

  it("allowed with registered tokenRequired 画像：日志仍无 token 明文/IP/url", async () => {
    const policy = makePolicy([
      { ip: USER_IP_A, role: "admin", tokenRequired: true, tokens: ["secret-token"] },
    ]);
    const capture = makeCapture();
    const app = await makeApp(capture, makeTestIpAccess({ policy }));
    try {
      const authOk = await app.inject({
        method: "GET",
        url: "/v1/sessions",
        remoteAddress: USER_IP_A,
        headers: { authorization: "Bearer secret-token" },
      });
      expect(authOk.statusCode).toBe(200);
    } finally {
      await app.close();
    }
    const joined = capture.lines.join("\n");
    expect(joined).toContain(subjectHashFor(USER_IP_A));
    expect(joined).not.toContain("secret-token");
    assertNoSensitiveLeak(capture.lines);
  });
});

describe("safeReqSerializer / safeResSerializer（直接单测）", () => {
  it("req：只输出 id/method，剥离 url/query/headers/XFF/authorization/remoteAddress/remotePort", () => {
    const out = safeReqSerializer({
      id: "req-1",
      method: "POST",
      url: "/v1/sessions?authorization=BAD&token=SECRET",
      host: "evil.example.com",
      remoteAddress: OUTSIDE_IP,
      remotePort: 31337,
      headers: {
        authorization: "Bearer SECRET",
        "x-forwarded-for": "10.0.0.1",
        cookie: "session=SECRET",
      },
      raw: { socket: { remoteAddress: OUTSIDE_IP, remotePort: 31337 } },
    });
    expect(out).toEqual({ id: "req-1", method: "POST" });
  });

  it("res：只输出 statusCode", () => {
    expect(safeResSerializer({ statusCode: 401, headers: { authorization: "Bearer SECRET" } })).toEqual({ statusCode: 401 });
  });

  it("非对象/脏输入：不抛错、不泄漏原始文本", () => {
    expect(safeReqSerializer(null)).toEqual({ id: undefined, method: undefined });
    expect(safeReqSerializer(undefined)).toEqual({ id: undefined, method: undefined });
    expect(safeReqSerializer({ method: 12345 })).toEqual({ id: undefined, method: undefined });
    expect(safeResSerializer("x")).toEqual({ statusCode: undefined });
  });
});