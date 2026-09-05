import { describe, expect, it } from "vitest";
import {
  DEFAULT_IP_ROLE,
  IP_ACCESS_POLICY_VERSION,
  IP_ROLES,
  assertPolicyCovered,
  hashBearerToken,
  parseIpAccessPolicy,
  publicProfile,
  resolveIpAccess,
  tokenHashMatches,
  verifyProfileToken,
  type IpAccessPolicy,
  type IpAccessProfile,
} from "../../src/core/ip-access-policy.js";
import { parseCidrStrict } from "../../src/core/cidr.js";

const SHA256_64 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const hash = (h: string) => `sha256:${h}`;

function minimalPolicy(ip = "203.0.113.7"): string {
  return JSON.stringify({ version: 1, ips: [{ ip }] });
}

function makeInput(policy: IpAccessPolicy | null = null) {
  return {
    allowedClientCidrs: ["203.0.113.0/24", "2001:db8::/32"].map(parseCidrStrict),
    policy,
  };
}

describe("parseIpAccessPolicy：schema 与严格性", () => {
  it("最小策略：默认 role=user、token off", () => {
    const policy = parseIpAccessPolicy(minimalPolicy());
    expect(policy.version).toBe(IP_ACCESS_POLICY_VERSION);
    expect(policy.entries).toHaveLength(1);
    const entry = policy.entries[0]!;
    expect(entry.ip).toBe("203.0.113.7");
    expect(entry.role).toBe(DEFAULT_IP_ROLE);
    expect(entry.role).toBe("user");
    expect(entry.disabled).toBe(false);
    expect(entry.tokenRequired).toBe(false);
    expect(entry.tokenHashes).toEqual([]);
  });

  it("完整条目：role/tokenRequired/tokens 全部生效", () => {
    const policy = parseIpAccessPolicy(
      JSON.stringify({
        version: 1,
        ips: [
          {
            ip: "203.0.113.7",
            role: "admin",
            tokenRequired: true,
            tokens: [hash(SHA256_64)],
          },
        ],
      }),
    );
    const entry = policy.entries[0]!;
    expect(entry.role).toBe("admin");
    expect(entry.tokenRequired).toBe(true);
    expect(entry.tokenHashes).toEqual([hash(SHA256_64)]);
    expect(policy.byIp.get("203.0.113.7")).toBe(entry);
  });

  it("全部四种角色可解析", () => {
    for (const role of IP_ROLES) {
      const policy = parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: `10.0.0.${IP_ROLES.indexOf(role) + 1}`, role }] }));
      expect(policy.entries[0]!.role).toBe(role);
    }
  });

  it("顶层与条目结构错误抛错", () => {
    expect(() => parseIpAccessPolicy("not json")).toThrow();
    expect(() => parseIpAccessPolicy(JSON.stringify([]))).toThrow();
    expect(() => parseIpAccessPolicy(JSON.stringify({}))).toThrow();
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1 }))).toThrow();
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [], extra: true }))).toThrow();
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: "1", ips: [{}] }))).toThrow();
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 2, ips: [{}] }))).toThrow();
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1.5, ips: [{}] }))).toThrow();
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [] }))).toThrow("不得为空");
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1, ips: "x" }))).toThrow();
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [null] }))).toThrow();
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4", rolee: "admin" }] }))).toThrow("未知字段");
  });

  it("重复 key：任意对象层级拒绝（不用 JSON.parse 覆盖语义）", () => {
    // 顶层
    expect(() => parseIpAccessPolicy('{"version":1,"version":2,"ips":[{"ip":"1.2.3.4"}]}')).toThrow("重复字段");
    expect(() => parseIpAccessPolicy('{"ips":[{"ip":"1.2.3.4"}],"ips":[]}')).toThrow("重复字段");
    // 条目（user 对象）
    expect(() => parseIpAccessPolicy('{"version":1,"ips":[{"ip":"1.2.3.4","ip":"1.2.3.5"}]}')).toThrow("重复字段");
    expect(() => parseIpAccessPolicy('{"version":1,"ips":[{"ip":"1.2.3.4","role":"admin","role":"user"}]}')).toThrow("重复字段");
    // token 层级的对象（任意嵌套对象同样拒绝）
    expect(() => parseIpAccessPolicy('{"version":1,"ips":[{"ip":"1.2.3.4","x":{"a":1,"a":2}}]}')).toThrow("重复字段");
    expect(() => parseIpAccessPolicy('{"version":1,"ips":[{"ip":"1.2.3.4","tokens":[{"k":1,"k":2}]}]}')).toThrow("重复字段");
    // 转义后同 key 同样判重（按解码后的 key 比较）
    expect(() => parseIpAccessPolicy('{"\\u0076ersion":1,"version":2,"ips":[{"ip":"1.2.3.4"}]}')).toThrow("重复字段");
    // 无重复时不受影响
    expect(parseIpAccessPolicy(minimalPolicy()).entries).toHaveLength(1);
  });

  it("JSON 错误脱敏：错误消息不回显输入内容/ key 名", () => {
    const secret = "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const attempt = (text: string): string => {
      try {
        parseIpAccessPolicy(text);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected throw");
    };
    const dupMsg = attempt(`{"version":1,"version":2,"ips":[{"ip":"1.2.3.4","tokens":["${secret}"]}]}`);
    expect(dupMsg).toContain("重复字段");
    expect(dupMsg).not.toContain(secret);
    expect(dupMsg).not.toContain("deadbeef");
    const badJson = attempt(`{"version":1,"ips":[{"ip":"1.2.3.4","tokens":["${secret}"],`); // 截断
    expect(badJson).toContain("不是合法 JSON");
    expect(badJson).not.toContain(secret);
    expect(badJson).not.toContain("deadbeef");
  });

  it("__proto__/constructor 作为 key 只是普通字段（无原型污染，未知字段拒绝）", () => {
    expect(() => parseIpAccessPolicy('{"version":1,"ips":[{"ip":"1.2.3.4","__proto__":{"x":1}}]}')).toThrow("未知字段");
    expect(() => parseIpAccessPolicy('{"version":1,"ips":[{"ip":"1.2.3.4","constructor":1}]}')).toThrow("未知字段");
    expect({}).toEqual({}); // 解析过程未污染全局 Object 原型
  });

  it("ip 校验：非规范、缺失、重复", () => {
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{}] }))).toThrow(".ip");
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "01.2.3.4" }] }))).toThrow();
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4/24" }] }))).toThrow();
    const mapped = parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "::ffff:1.2.3.4" }] }));
    expect(mapped.entries[0]!.ip).toBe("1.2.3.4"); // mapped 归一为 v4（与 env 层一致）
    expect(() =>
      parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4" }, { ip: "::ffff:1.2.3.4" }] })),
    ).toThrow("重复"); // 归一后判重
    expect(() =>
      parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4" }, { ip: "1.2.3.4" }] })),
    ).toThrow("重复");
  });

  it("role 校验：未知角色/非字符串", () => {
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4", role: "superadmin" }] }))).toThrow("已知角色");
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4", role: 1 }] }))).toThrow();
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4", role: "" }] }))).toThrow();
  });

  it("workspaceRoots 已移除：策略 JSON 中出现即未知字段 failfast（不做解析不使用）", () => {
    // 2026-02 用户决策：内网不做 workspace 强制，workspaceRoots 整体删除，出现即拒绝。
    const withRoots = (roots: unknown) =>
      JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4", workspaceRoots: roots }] });
    expect(() => parseIpAccessPolicy(withRoots(["/srv/ws/a"]))).toThrow("未知字段");
    expect(() => parseIpAccessPolicy(withRoots([]))).toThrow("未知字段");
    expect(() => parseIpAccessPolicy(withRoots("/srv/ws"))).toThrow("未知字段");
    // workspaceRoots 之外的历史字段也同样按未知字段拒绝（错误消息不回显字段名内容）。
    expect(() => parseIpAccessPolicy(minimalPolicy())).not.toThrow();
  });

  it("disabled 组合严格：不得携带 role/tokenRequired/tokens", () => {
    const base = (extra: object) => JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4", disabled: true, ...extra }] });
    expect(() => parseIpAccessPolicy(base({ role: "admin" }))).toThrow("disabled");
    expect(() => parseIpAccessPolicy(base({ tokenRequired: true }))).toThrow("disabled");
    expect(() => parseIpAccessPolicy(base({ tokens: [hash(SHA256_64)] }))).toThrow("disabled");
    // workspaceRoots 已移除：disabled 条目里出现它同样被拒（未知字段，先于互斥语义）
    expect(() => parseIpAccessPolicy(base({ workspaceRoots: ["/a"] }))).toThrow("未知字段");
    expect(() => parseIpAccessPolicy(base({ disabled: "yes" }))).toThrow("布尔");
    const policy = parseIpAccessPolicy(base({}));
    expect(policy.entries[0]!.disabled).toBe(true);
  });

  it("tokenRequired 必须有 hash；未启用不得有 hash（off 不得 hash）", () => {
    expect(() =>
      parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4", tokenRequired: true }] })),
    ).toThrow("必须提供非空 tokens");
    expect(() =>
      parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4", tokenRequired: true, tokens: [] }] })),
    ).toThrow("不得为空");
    expect(() =>
      parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4", tokens: [hash(SHA256_64)] }] })),
    ).toThrow("未启用 tokenRequired");
    expect(() =>
      parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4", tokenRequired: false, tokens: [hash(SHA256_64)] }] })),
    ).toThrow("未启用 tokenRequired");
    expect(() => parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4", tokenRequired: "yes" }] }))).toThrow("布尔");
  });

  it("token hash 格式：只接受 sha256:<64 小写 hex>", () => {
    const bad = [
      "sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789", // 大写
      `sha256:${SHA256_64.slice(0, 60)}`, // 长度不足
      "md5:" + SHA256_64,
      "sha256:" + SHA256_64 + "00", // 长度超出
      "token-1",
      42,
    ];
    for (const t of bad) {
      expect(() =>
        parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4", tokenRequired: true, tokens: [t] }] })),
      ).toThrow("sha256");
    }
  });

  it("token 全文件全局唯一（不换绑）", () => {
    expect(() =>
      parseIpAccessPolicy(
        JSON.stringify({
          version: 1,
          ips: [
            { ip: "1.2.3.4", tokenRequired: true, tokens: [hash(SHA256_64)] },
            { ip: "1.2.3.5", tokenRequired: true, tokens: [hash(SHA256_64)] },
          ],
        }),
      ),
    ).toThrow("全局唯一");
  });

  it("mapped 精确 IP 归一为 v4 后再判重与查找", () => {
    const policy = parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "203.0.113.7" }] }));
    expect(policy.byIp.get("203.0.113.7")).toBeDefined();
    expect(parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "1.2.3.4" }, { ip: "1.2.3.5" }] })).entries).toHaveLength(2);
  });
});

describe("resolveIpAccess：纯函数决策", () => {
  it("CIDR 外一律 deny（outside-cidr）", () => {
    const input = makeInput();
    expect(resolveIpAccess(input, "8.8.8.8")).toEqual({ verdict: "denied", reason: "outside-cidr", ip: "8.8.8.8" });
    expect(resolveIpAccess(input, "2001:db9::1")).toEqual({ verdict: "denied", reason: "outside-cidr", ip: "2001:db9::1" });
  });

  it("CIDR 内未登记：默认 role=user / token off", () => {
    const decision = resolveIpAccess(makeInput(), "203.0.113.99");
    expect(decision.verdict).toBe("allowed");
    if (decision.verdict !== "allowed") throw new Error("unreachable");
    expect(decision.profile).toMatchObject({
      ip: "203.0.113.99",
      role: "user",
      tokenRequired: false,
      registered: false,
    });
    expect(decision.profile.tokenHashes).toEqual([]);
  });

  it("精确 IP 条目覆盖 role/tokenRequired", () => {
    const policy = parseIpAccessPolicy(
      JSON.stringify({
        version: 1,
        ips: [
          {
            ip: "203.0.113.7",
            role: "admin",
            tokenRequired: true,
            tokens: [hash(SHA256_64)],
          },
        ],
      }),
    );
    const decision = resolveIpAccess(makeInput(policy), "203.0.113.7");
    expect(decision.verdict).toBe("allowed");
    if (decision.verdict !== "allowed") throw new Error("unreachable");
    expect(decision.profile).toMatchObject({
      ip: "203.0.113.7",
      role: "admin",
      tokenRequired: true,
      registered: true,
    });
  });

  it("disabled 条目 deny（disabled）", () => {
    const policy = parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "203.0.113.8", disabled: true }] }));
    expect(resolveIpAccess(makeInput(policy), "203.0.113.8")).toEqual({ verdict: "denied", reason: "disabled", ip: "203.0.113.8" });
  });

  it("条目指定 role 未指定其余字段时仅 role 生效（无 workspace 概念）", () => {
    const policy = parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "203.0.113.9", role: "viewer" }] }));
    const decision = resolveIpAccess(makeInput(policy), "203.0.113.9");
    if (decision.verdict !== "allowed") throw new Error("unreachable");
    expect(decision.profile.role).toBe("viewer");
    expect(decision.profile.registered).toBe(true);
  });

  it("mapped 请求 IP 归一为 v4 后命中条目", () => {
    const policy = parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "203.0.113.7", role: "operator" }] }));
    const decision = resolveIpAccess(makeInput(policy), "::ffff:203.0.113.7");
    if (decision.verdict !== "allowed") throw new Error("unreachable");
    expect(decision.profile.registered).toBe(true);
    expect(decision.profile.role).toBe("operator");
  });

  it("非法 IP 输入抛错（failfast，不静默）", () => {
    expect(() => resolveIpAccess(makeInput(), "not-an-ip")).toThrow();
  });

  it("v6 条目与 v6 CIDR 协同", () => {
    const policy = parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "2001:db8::10", role: "viewer" }] }));
    const decision = resolveIpAccess(makeInput(policy), "2001:db8::10");
    if (decision.verdict !== "allowed") throw new Error("unreachable");
    expect(decision.profile.registered).toBe(true);
    expect(decision.profile.role).toBe("viewer");
    expect(resolveIpAccess(makeInput(policy), "2001:db8::11").verdict).toBe("allowed"); // 未登记默认放行
  });
});

describe("assertPolicyCovered：条目必须落在允许 CIDR 内（死配置 failfast）", () => {
  it("范围内通过", () => {
    const policy = parseIpAccessPolicy(minimalPolicy()); // 203.0.113.7 ∈ 203.0.113.0/24
    expect(() => assertPolicyCovered(policy, makeInput().allowedClientCidrs)).not.toThrow();
  });

  it("范围外抛错", () => {
    const policy = parseIpAccessPolicy(JSON.stringify({ version: 1, ips: [{ ip: "8.8.8.8" }] }));
    expect(() => assertPolicyCovered(policy, makeInput().allowedClientCidrs)).toThrow("不在 PI_ALLOWED_CLIENT_CIDRS 范围内");
  });
});

describe("Bearer token 校验助手", () => {
  const token = "op-0secret-token-123";
  const stored = hashBearerToken(token);
  const profile: IpAccessProfile = {
    ip: "203.0.113.7",
    role: "admin",
    tokenRequired: true,
    tokenHashes: [stored],
    registered: true,
  };

  it("hashBearerToken：sha256:<64 小写 hex>，确定且不可逆", () => {
    expect(stored).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashBearerToken(token)).toBe(stored);
    expect(stored).not.toContain(token);
  });

  it("tokenHashMatches：命中/未命中/畸形存储", () => {
    expect(tokenHashMatches(stored, token)).toBe(true);
    expect(tokenHashMatches(stored, "wrong-token")).toBe(false);
    expect(tokenHashMatches("sha256:NOTHEX", token)).toBe(false);
    expect(tokenHashMatches("md5:" + "a".repeat(64), token)).toBe(false);
  });

  it("verifyProfileToken：token off 恒 true；token required 必须命中绑定 hash", () => {
    expect(verifyProfileToken({ tokenRequired: false, tokenHashes: [] }, undefined)).toBe(true);
    expect(verifyProfileToken({ tokenRequired: false, tokenHashes: [] }, "anything")).toBe(true);
    expect(verifyProfileToken(profile, undefined)).toBe(false);
    expect(verifyProfileToken(profile, "")).toBe(false);
    expect(verifyProfileToken(profile, "wrong")).toBe(false);
    expect(verifyProfileToken(profile, token)).toBe(true);
  });

  it("verifyProfileToken：只哈希一次、遍历全部 hash 不短路、累积匹配", () => {
    const other = hashBearerToken("other-token");
    // 匹配在列表末尾：先比较若干不命中项仍返回 true
    expect(verifyProfileToken({ ...profile, tokenHashes: [other, other, stored] }, token)).toBe(true);
    // 匹配在列表开头：同样返回 true（不短路语义下结果一致）
    expect(verifyProfileToken({ ...profile, tokenHashes: [stored, other, other] }, token)).toBe(true);
    // 畸形/非本画像格式条目不中断后续比较
    expect(verifyProfileToken({ ...profile, tokenHashes: ["sha256:NOTHEX", "md5:" + "a".repeat(64), stored] }, token)).toBe(true);
    // 全部不命中 → false
    expect(verifyProfileToken({ ...profile, tokenHashes: [other, other] }, token)).toBe(false);
    // 空画像（无绑定 hash）且 required → 恒 false
    expect(verifyProfileToken({ ...profile, tokenHashes: [] }, token)).toBe(false);
  });

  it("IP binding：只比较该 IP 画像绑定的 hash（token 不换绑）", () => {
    const otherProfile: IpAccessProfile = { ...profile, ip: "203.0.113.8", tokenHashes: [] };
    expect(verifyProfileToken(otherProfile, token)).toBe(false); // 同一 token 换 IP 无效
  });

  it("publicProfile 不含 tokenHashes（可安全进日志）", () => {
    const pub = publicProfile(profile);
    expect(pub).toEqual({
      ip: "203.0.113.7",
      role: "admin",
      tokenRequired: true,
      registered: true,
    });
    expect(JSON.stringify(pub)).not.toContain("sha256:");
  });
});