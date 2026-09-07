import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  createAdmission,
  extractBearerToken,
  requireIpAccessRuntimeConfig,
  type Admission,
} from "../../src/server/network-admission.js";
import { parseIpAccessEnv } from "../../src/core/ip-access-config.js";
import { hashBearerToken } from "../../src/core/ip-access-policy.js";
import {
  makePolicy,
  makeTestIpAccess,
  OUTSIDE_IP,
  parseTestCidrs,
  USER_IP_A,
} from "../helpers/ip-access.js";

// WP5D-2 准入契约（docs/ip-rbac-design.md §2/§4/§5）单测：
// - 直接 socket IP（request.raw.socket.remoteAddress）为唯一身份来源；
// - CIDR 外 / disabled / socket IP 不可解析 → 403；/v1 tokenRequired 缺失/错误 → 401；
// - token off 忽略 Bearer；探针仅 IP gate；token hashes 不进入 allowed 结果。

function req(
  remoteAddress: string | undefined,
  url = "/v1/sessions",
  headers: Record<string, string> = {},
): FastifyRequest {
  return {
    url,
    headers,
    raw: {
      socket: { remoteAddress },
    },
  } as unknown as FastifyRequest;
}

describe("createAdmission（IP gate + /v1 token gate）", () => {
  const admission: Admission = createAdmission(makeTestIpAccess());

  it("CIDR 内未登记 IP：allowed + user=canonical IP + access=默认画像（role user / token off）", () => {
    const result = admission(req(USER_IP_A));
    expect(result.verdict).toBe("allowed");
    if (result.verdict !== "allowed") return;
    expect(result.user).toEqual({ kind: "ip", ip: USER_IP_A });
    expect(result.access).toEqual({
      ip: USER_IP_A,
      role: "user",
      tokenRequired: false,
      registered: false,
    });
    // access 契约不泄漏 token hashes / 明文 token（tokenRequired 字段名本身允许）
    expect(JSON.stringify(result.access)).not.toMatch(/sha256:|tokenHashes/);
  });

  it("IPv4-mapped socket IP 归一为 v4：allowed 且 user/access 用 canonical v4", () => {
    const result = admission(req("::ffff:10.0.0.1"));
    expect(result.verdict).toBe("allowed");
    if (result.verdict !== "allowed") return;
    expect(result.user).toEqual({ kind: "ip", ip: "10.0.0.1" });
    expect(result.access.ip).toBe("10.0.0.1");
  });

  it("CIDR 外 → 403（outside-cidr）", () => {
    expect(admission(req(OUTSIDE_IP))).toEqual({ verdict: "denied", reason: "outside-cidr", statusCode: 403 });
  });

  it("disabled 条目 → 403（即便出示有效 token 也不能绕过）", () => {
    const policy = makePolicy([
      { ip: USER_IP_A, disabled: true },
    ]);
    const withDisabled = createAdmission(makeTestIpAccess({ policy }));
    expect(withDisabled(req(USER_IP_A, "/v1/sessions", { authorization: "Bearer anything" }))).toEqual({
      verdict: "denied",
      reason: "disabled",
      statusCode: 403,
    });
    // 探针路由同样被 disabled gate 拦截
    expect(withDisabled(req(USER_IP_A, "/health"))).toEqual({
      verdict: "denied",
      reason: "disabled",
      statusCode: 403,
    });
  });

  it("unknown socket IP（undefined/空/不可解析）→ failclosed 403（bad-ip）", () => {
    expect(admission(req(undefined))).toEqual({ verdict: "denied", reason: "bad-ip", statusCode: 403 });
    expect(admission(req(""))).toEqual({ verdict: "denied", reason: "bad-ip", statusCode: 403 });
    expect(admission(req("not-an-ip"))).toEqual({ verdict: "denied", reason: "bad-ip", statusCode: 403 });
  });

  it("/v1 + tokenRequired：缺失/错误 token → 401（token-required）；正确 token → allowed", () => {
    const policy = makePolicy([{ ip: USER_IP_A, tokenRequired: true, tokens: ["secret-token"] }]);
    const gated = createAdmission(makeTestIpAccess({ policy }));

    expect(gated(req(USER_IP_A, "/v1/sessions"))).toEqual({ verdict: "denied", reason: "token-required", statusCode: 401 });
    expect(gated(req(USER_IP_A, "/v1/sessions", { authorization: "Bearer wrong-token" }))).toEqual({
      verdict: "denied",
      reason: "token-required",
      statusCode: 401,
    });
    expect(gated(req(USER_IP_A, "/v1/sessions", { authorization: "Bearer secret-token" })).verdict).toBe("allowed");
    // Bearer scheme 大小写不敏感；绑定精确 IP：同 token 其他 IP 无效（token 不换绑）
    expect(gated(req(USER_IP_A, "/v1/sessions", { authorization: "bearer secret-token" })).verdict).toBe("allowed");
    // 绑定精确 IP：同 token 在别的 IP 下无效（token 不换绑）。10.0.0.9 登记为自己的
    // tokenRequired 条目（token: other-token），出示 A 的 token → 401。
    const twoEntries = makePolicy([
      { ip: USER_IP_A, tokenRequired: true, tokens: ["secret-token"] },
      { ip: "10.0.0.9", tokenRequired: true, tokens: ["other-token"] },
    ]);
    const twoGated = createAdmission(makeTestIpAccess({ policy: twoEntries }));
    expect(twoGated(req("10.0.0.9", "/v1/sessions", { authorization: "Bearer secret-token" }))).toEqual({
      verdict: "denied",
      reason: "token-required",
      statusCode: 401,
    });
    expect(twoGated(req("10.0.0.9", "/v1/sessions", { authorization: "Bearer other-token" })).verdict).toBe("allowed");
  });

  it("tokenRequired：gate /v1 与 /metrics；/health、/readyz 探针无 token 也 allowed（仅 IP gate）", () => {
    const policy = makePolicy([{ ip: USER_IP_A, tokenRequired: true, tokens: ["probe-secret"] }]);
    const gated = createAdmission(makeTestIpAccess({ policy }));
    // 存活/就绪探针不被 token 卡死（任意 admitted IP/role）。
    for (const url of ["/health", "/readyz"]) {
      const result = gated(req(USER_IP_A, url));
      expect(result.verdict).toBe("allowed");
    }
    // /metrics 是运维面（WP5D-3 role=admin/operator）：实际 GET 仍要求 token。
    expect(gated(req(USER_IP_A, "/metrics")).verdict).toBe("denied");
    const metricsOk = gated(req(USER_IP_A, "/metrics", { authorization: "Bearer probe-secret" }));
    expect(metricsOk.verdict).toBe("allowed");
    // 非 /v1 且非 /metrics 路径（如未知 404 路径）不触发 token gate
    expect(gated(req(USER_IP_A, "/v10/whatever")).verdict).toBe("allowed");
  });

  it("token off（未登记默认画像）：出示任意 Bearer 一律忽略 → allowed", () => {
    const result = admission(req(USER_IP_A, "/v1/sessions", { authorization: "Bearer junk" }));
    expect(result.verdict).toBe("allowed");
    if (result.verdict !== "allowed") return;
    expect(result.access.tokenRequired).toBe(false);
  });

  it("registered 条目：access 回显条目画像（role/registered），无 token hashes", () => {
    const policy = makePolicy([
      { ip: USER_IP_A, role: "admin", tokenRequired: true, tokens: ["t1"] },
    ]);
    const gated = createAdmission(makeTestIpAccess({ policy }));
    const result = gated(req(USER_IP_A, "/v1/sessions", { authorization: "Bearer t1" }));
    expect(result.verdict).toBe("allowed");
    if (result.verdict !== "allowed") return;
    expect(result.access).toEqual({
      ip: USER_IP_A,
      role: "admin",
      tokenRequired: true,
      registered: true,
    });
    // 注入对象本身不含 token 哈希字段（clean contract）
    expect(Object.keys(result.access).sort()).toEqual(["ip", "registered", "role", "tokenRequired"]);
  });
});

describe("extractBearerToken", () => {
  it("大小写不敏感提取；非 Bearer / 多值 / undefined → undefined", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken("Basic abc")).toBeUndefined();
    expect(extractBearerToken("Bearer ")).toBeUndefined();
    expect(extractBearerToken(["Bearer a", "Bearer b"])).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
  });
});

describe("requireIpAccessRuntimeConfig（startServer/buildApp 共用严格校验）", () => {
  it("合法准入配置通过（main 解析产物 + 内存策略）", () => {
    const env = parseIpAccessEnv({
      PI_ALLOWED_CLIENT_CIDRS: "10.0.0.0/8,127.0.0.0/8",
    });
    const policy = makePolicy([{ ip: "10.0.0.1", tokenRequired: true, tokens: ["t"] }]);
    const input = {
      allowedClientCidrs: env.allowedClientCidrs,
      policy,
    };
    const resolved = requireIpAccessRuntimeConfig(input);
    expect(resolved.allowedClientCidrs).toHaveLength(2);
    expect(resolved.policy?.byIp.get("10.0.0.1")?.tokenHashes[0]).toBe(hashBearerToken("t"));
  });

  it("缺失/非对象/伪造 → 抛错（不回显值）", () => {
    expect(() => requireIpAccessRuntimeConfig(undefined)).toThrow(/ipAccess/);
    expect(() => requireIpAccessRuntimeConfig(null)).toThrow(/ipAccess/);
    expect(() => requireIpAccessRuntimeConfig("bypass")).toThrow(/ipAccess/);
    expect(() => requireIpAccessRuntimeConfig({})).toThrow(/allowedCidrs|ipAccess/);
    expect(() => requireIpAccessRuntimeConfig({ allowedClientCidrs: [], policy: null })).toThrow(/allowedClientCidrs/);
  });

  it("ipAccess 顶层严格 allowlist：任何未知字段（含 undefined）拒绝，值不回显", () => {
    const good = { allowedClientCidrs: parseTestCidrs(["127.0.0.0/8"]), policy: null };
    for (const [name, value] of [
      ["unknown", undefined],
      ["unknown", "SECRET-UNKNOWN-VALUE"],
      ["unknownField", undefined],
      ["unknownField", "SECRET-UNKNOWN-VALUE"],
    ] as const) {
      expect(() => requireIpAccessRuntimeConfig({ ...good, [name]: value })).toThrow(
        new RegExp(`^ipAccess 含未知字段 ${name}`),
      );
    }
  });

  it("非法 allowedClientCidrs / policy shape → 抛错；策略未知字段拒绝", () => {
    expect(() =>
      requireIpAccessRuntimeConfig({ allowedClientCidrs: [{ family: "v4", prefix: 8, bytes: [10, 0, 0, 0], text: "10.0.0.0/8" }], policy: null }),
    ).not.toThrow();
    expect(() =>
      requireIpAccessRuntimeConfig({ allowedClientCidrs: [{ family: "v4", prefix: 8, bytes: [10, 0, 0, 0], text: "10.0.0.1/8" }], policy: null }),
    ).toThrow(/CIDR|ipAccess/); // 非 canonical（host 位非零）
    expect(() =>
      requireIpAccessRuntimeConfig({ allowedClientCidrs: parseTestCidrs(["127.0.0.0/8"]), policy: { version: 2, entries: [], byIp: new Map() } }),
    ).toThrow(/ipAccess.policy/);
    // 策略条目/顶层出现未知字段 → failfast（防拼写错误；值不回显）。
    const policy = makePolicy([{ ip: "127.0.0.1" }]);
    for (const unknown of ["unknownField"] as const) {
      const withUnknownEntry = {
        version: policy.version,
        entries: policy.entries.map((e) => ({ ...e, [unknown]: undefined })),
        byIp: policy.byIp,
      };
      expect(() =>
        requireIpAccessRuntimeConfig({ allowedClientCidrs: parseTestCidrs(["127.0.0.0/8"]), policy: withUnknownEntry }),
      ).toThrow(new RegExp(unknown));

      const withUnknownPolicy = { ...policy, [unknown]: undefined };
      expect(() =>
        requireIpAccessRuntimeConfig({ allowedClientCidrs: parseTestCidrs(["127.0.0.0/8"]), policy: withUnknownPolicy }),
      ).toThrow(new RegExp(unknown));
    }
  });

  it("运行时复核策略覆盖：精确 IP 在允许 CIDR 外 → 抛错（与 load 一致）", () => {
    const policy = makePolicy([{ ip: "203.0.113.7" }]); // 不在 127.0.0.0/8 内
    expect(() =>
      requireIpAccessRuntimeConfig({ allowedClientCidrs: parseTestCidrs(["127.0.0.0/8"]), policy }),
    ).toThrow(/不在 PI_ALLOWED_CLIENT_CIDRS 范围/);
  });

  it("byIp 引用不一致的伪造策略 → 抛错", () => {
    const policy = makePolicy([{ ip: "127.0.0.1" }]);
    const fake = {
      version: policy.version,
      entries: policy.entries,
      byIp: new Map([["127.0.0.1", { ...policy.entries[0]! }]]), // 不同引用
    };
    expect(() =>
      requireIpAccessRuntimeConfig({ allowedClientCidrs: parseTestCidrs(["127.0.0.0/8"]), policy: fake }),
    ).toThrow(/byIp/);
  });
});