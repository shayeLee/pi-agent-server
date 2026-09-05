import { describe, it, expect } from "vitest";
import { isInCidr, isInAnyCidr } from "../../src/core/cidr.js";

// IPv4 CIDR 匹配（needs.md §4.2 内网判定）
describe("isInCidr", () => {
  describe("常见网段命中", () => {
    it("10.0.0.0/8 命中内网 10.x.x.x", () => {
      expect(isInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
      expect(isInCidr("10.255.255.255", "10.0.0.0/8")).toBe(true);
    });

    it("192.168.0.0/16 命中 192.168.x.x", () => {
      expect(isInCidr("192.168.1.1", "192.168.0.0/16")).toBe(true);
      expect(isInCidr("192.168.254.254", "192.168.0.0/16")).toBe(true);
    });

    it("172.16.0.0/12 命中 172.16-172.31", () => {
      expect(isInCidr("172.20.5.1", "172.16.0.0/12")).toBe(true);
      expect(isInCidr("172.31.255.255", "172.16.0.0/12")).toBe(true);
    });
  });

  describe("不命中", () => {
    it("10.0.0.0/8 不命中 11.x、公网 IP", () => {
      expect(isInCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
      expect(isInCidr("8.8.8.8", "10.0.0.0/8")).toBe(false);
    });

    it("192.168.0.0/16 不命中 192.169.0.1", () => {
      expect(isInCidr("192.169.0.1", "192.168.0.0/16")).toBe(false);
    });

    it("172.16.0.0/12 不命中 172.32.0.1", () => {
      expect(isInCidr("172.32.0.1", "172.16.0.0/12")).toBe(false);
    });
  });

  describe("边界（前缀 0、/32）", () => {
    it("0.0.0.0/0 命中任意 IP", () => {
      expect(isInCidr("0.0.0.0", "0.0.0.0/0")).toBe(true);
      expect(isInCidr("255.255.255.255", "0.0.0.0/0")).toBe(true);
      expect(isInCidr("8.8.8.8", "0.0.0.0/0")).toBe(true);
    });

    it("/32 仅精确命中单个 IP", () => {
      expect(isInCidr("10.1.2.3", "10.1.2.3/32")).toBe(true);
      expect(isInCidr("10.1.2.4", "10.1.2.3/32")).toBe(false);
      expect(isInCidr("10.1.2.3", "10.1.2.4/32")).toBe(false);
    });

    it("网段/32 边界相邻 IP 不命中", () => {
      expect(isInCidr("203.0.113.5", "203.0.113.0/24")).toBe(true);
      expect(isInCidr("203.0.114.0", "203.0.113.0/24")).toBe(false);
    });

    it("非规范网段（网络位含主机位）仍按前缀匹配", () => {
      expect(isInCidr("10.9.9.9", "10.1.0.0/8")).toBe(true);
    });
  });

  describe("非法输入返回 false（不抛错）", () => {
    it("非法 IP 返回 false", () => {
      expect(isInCidr("999.1.1.1", "10.0.0.0/8")).toBe(false);
      expect(isInCidr("1.2.3", "10.0.0.0/8")).toBe(false);
      expect(isInCidr("1.2.3.4.5", "10.0.0.0/8")).toBe(false);
      expect(isInCidr("a.b.c.d", "10.0.0.0/8")).toBe(false);
      expect(isInCidr("", "10.0.0.0/8")).toBe(false);
      expect(isInCidr("256.1.1.1", "10.0.0.0/8")).toBe(false);
    });

    it("非法 CIDR 返回 false", () => {
      expect(isInCidr("10.1.1.1", "10.0.0.0")).toBe(false); // 无前缀
      expect(isInCidr("10.1.1.1", "10.0.0.0/33")).toBe(false); // 前缀超界
      expect(isInCidr("10.1.1.1", "10.0.0.0/-1")).toBe(false);
      expect(isInCidr("10.1.1.1", "10.0.0.0/8/8")).toBe(false);
      expect(isInCidr("10.1.1.1", "not-a-cidr")).toBe(false);
      expect(isInCidr("10.1.1.1", "")).toBe(false);
    });

    it("IP 与 CIDR 均非法返回 false", () => {
      expect(isInCidr("bad-ip", "bad-cidr")).toBe(false);
    });
  });
});

describe("isInAnyCidr（多网段）", () => {
  const CIDRS = ["10.0.0.0/8", "192.168.0.0/16", "172.16.0.0/12"];

  it("命中任一网段返回 true", () => {
    expect(isInAnyCidr("10.1.2.3", CIDRS)).toBe(true);
    expect(isInAnyCidr("192.168.0.5", CIDRS)).toBe(true);
    expect(isInAnyCidr("172.25.1.1", CIDRS)).toBe(true); // 命中最后一个网段
  });

  it("都不命中返回 false", () => {
    expect(isInAnyCidr("8.8.8.8", CIDRS)).toBe(false);
    expect(isInAnyCidr("203.0.113.9", CIDRS)).toBe(false);
  });

  it("空网段表返回 false", () => {
    expect(isInAnyCidr("10.1.2.3", [])).toBe(false);
  });

  it("含非法网段时忽略该网段", () => {
    expect(isInAnyCidr("10.1.2.3", ["bad-cidr", "10.0.0.0/8"])).toBe(true);
    expect(isInAnyCidr("8.8.8.8", ["bad-cidr", "10.0.0.0/8"])).toBe(false);
  });
});

describe("legacy CIDR API（IPv4-only 回归）", () => {
  it("IPv6 与 IPv4-mapped IPv6 均不命中旧 API", () => {
    expect(isInCidr("2001:db8::1", "2001:db8::/32")).toBe(false);
    expect(isInCidr("::ffff:10.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(isInCidr("10.1.2.3", "::ffff:10.0.0.0/104")).toBe(false);
    expect(isInAnyCidr("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(false);
  });

  it("非法输入仍静默返回 false", () => {
    expect(isInCidr("::ffff:not-an-ip", "10.0.0.0/8")).toBe(false);
    expect(isInAnyCidr("2001:db8::1", ["bad-cidr", "10.0.0.0/8"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WP5D-1 扩展：IPv6 / canonicalization / ::ffff 映射归一 v4 / 严格 API
// （上面的旧用例是宽松兼容层的回归契约，全部保持原语义）

import {
  canonicalCidr,
  canonicalIp,
  cidrContains,
  ipFamily,
  isCanonicalIp,
  isInAnyCidrStrict,
  isInCidrStrict,
  parseCidr,
  parseCidrStrict,
  parseIp,
  parseIpStrict,
} from "../../src/core/cidr.js";

describe("IPv6 CIDR 匹配（新双栈 API）", () => {
  it("2001:db8::/32 命中对应 v6 地址", () => {
    expect(isInCidrStrict("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(isInCidrStrict("2001:db8:ffff:ffff::1", "2001:db8::/32")).toBe(true);
  });

  it("2001:db8::/32 不命中相邻网段", () => {
    expect(isInCidrStrict("2001:db9::1", "2001:db8::/32")).toBe(false);
  });

  it("fe80::/10 链路本地", () => {
    expect(isInCidrStrict("fe80::1", "fe80::/10")).toBe(true);
    expect(isInCidrStrict("fe81::1", "fe80::/10")).toBe(true); // fe80::/10 覆盖 fe80-febf
    expect(isInCidrStrict("fec0::1", "fe80::/10")).toBe(false);
  });

  it("/128 仅精确命中单个地址", () => {
    expect(isInCidrStrict("2001:db8::1", "2001:db8::1/128")).toBe(true);
    expect(isInCidrStrict("2001:db8::2", "2001:db8::1/128")).toBe(false);
  });

  it(":: 全零地址", () => {
    expect(isInCidrStrict("::", "::/128")).toBe(true);
    expect(isInCidrStrict("::1", "::/128")).toBe(false);
    expect(isInCidrStrict("::1", "::/0")).toBe(true);
  });

  it("新宽松解析 API 仍按前缀掩码匹配非规范 v6 网段", () => {
    expect(cidrContains(parseCidr("2001:db8:1:1::/48")!, parseIp("2001:db8:1::1")!)).toBe(true);
  });
});

describe("::ffff IPv4-mapped 归一 v4（新双栈 API）", () => {
  it("点分 mapped 归一为 v4 并命中 v4 网段", () => {
    expect(isInCidrStrict("::ffff:192.168.1.10", "192.168.0.0/16")).toBe(true);
    expect(isInCidrStrict("::ffff:8.8.8.8", "192.168.0.0/16")).toBe(false);
  });

  it("十六进制 mapped 形式同样归一为 v4", () => {
    expect(isInCidrStrict("::ffff:c0a8:010a", "192.168.0.0/16")).toBe(true);
    expect(isInCidrStrict("::ffff:c0a8:010a", "::ffff:0:0/96")).toBe(true); // /96 映射为 v4 /0
  });

  it("mapped 前缀 ≥96 映射为 v4 前缀减 96", () => {
    expect(parseCidr("::ffff:192.168.1.0/120")?.text).toBe("192.168.1.0/24");
    expect(parseCidr("::ffff:0:0/96")?.text).toBe("0.0.0.0/0");
  });

  it("mapped 前缀 <96 拒绝（跨族语义歧义）", () => {
    expect(parseCidr("::ffff:1.2.3.4/64")).toBeNull();
    expect(isInCidr("::ffff:1.2.3.4", "::ffff:1.2.3.4/64")).toBe(false);
  });

  it("ipFamily 对 mapped 返回 v4", () => {
    expect(ipFamily("::ffff:1.2.3.4")).toBe("v4");
    expect(ipFamily("::1")).toBe("v6");
    expect(ipFamily("1.2.3.4")).toBe("v4");
    expect(ipFamily("bad")).toBeNull();
  });
});

describe("canonicalization（canonicalIp / isCanonicalIp / canonicalCidr）", () => {
  it("v4 前导零消零", () => {
    expect(canonicalIp("01.2.3.4")).toBe("1.2.3.4");
    expect(canonicalIp("192.168.001.010")).toBe("192.168.1.10");
    expect(isCanonicalIp("01.2.3.4")).toBe(false);
    expect(isCanonicalIp("1.2.3.4")).toBe(true);
  });

  it("v6 小写、去前导零、压缩最左最长全零段（RFC 5952）", () => {
    expect(canonicalIp("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(canonicalIp("2001:db8:0:0:1:0:0:1")).toBe("2001:db8::1:0:0:1"); // 两个等长段压缩最左
    expect(canonicalIp("::1")).toBe("::1");
    expect(canonicalIp("::")).toBe("::");
    expect(canonicalIp("0:0:0:0:0:0:0:1")).toBe("::1");
    expect(isCanonicalIp("2001:DB8::1")).toBe(false);
    expect(isCanonicalIp("2001:db8::1")).toBe(true);
  });

  it("mapped 归一为 v4 canonical 文本", () => {
    expect(canonicalIp("::ffff:192.168.1.1")).toBe("192.168.1.1");
    expect(canonicalIp("::ffff:c0a8:0101")).toBe("192.168.1.1");
    // 非标准混合形式 ::ffff:0:x 不作 mapped 映射（不是 RFC 4291 mapped 布局），保持 v6
    expect(canonicalIp("::ffff:0:192.168.1.1")).toBe("::ffff:0:c0a8:101");
    expect(isCanonicalIp("::ffff:192.168.1.1")).toBe(false); // canonical 形式是 v4
  });

  it("canonicalCidr 输出规范网络地址文本", () => {
    expect(canonicalCidr("10.1.0.0/8")).toBe("10.0.0.0/8"); // 主机位消零
    expect(canonicalCidr("2001:db8::1/128")).toBe("2001:db8::1/128");
    expect(canonicalCidr("bad")).toBeNull();
  });

  it("非法输入返回 null / false", () => {
    expect(canonicalIp("1.2.3")).toBeNull();
    expect(canonicalIp("1.2.3.4.5")).toBeNull();
    expect(canonicalIp("::ffff:1.2.3.4.5")).toBeNull();
    expect(canonicalIp("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(canonicalIp("1::2::3")).toBeNull();
    expect(canonicalIp("1:2:3:4:5:6:7:8::9")).toBeNull();
    expect(canonicalIp("1.2.3.4:1")).toBeNull();
    expect(canonicalIp("")).toBeNull();
    expect(isCanonicalIp("bad")).toBe(false);
  });
});

describe("parseIp / parseCidr（宽松结构解析）", () => {
  it("parseIp 返回族别与 canonical 文本", () => {
    expect(parseIp("10.0.0.1")?.family).toBe("v4");
    expect(parseIp("::1")?.family).toBe("v6");
    expect(parseIp("::ffff:1.2.3.4")?.family).toBe("v4");
    expect(parseIp("::")?.text).toBe("::");
  });

  it("parseCidr 掩码掉主机位", () => {
    const v4 = parseCidr("10.1.2.3/8");
    expect(v4?.prefix).toBe(8);
    expect(v4?.text).toBe("10.0.0.0/8");
    const v6 = parseCidr("2001:db8::1/64");
    expect(v6?.prefix).toBe(64);
    expect(v6?.text).toBe("2001:db8::/64");
  });

  it("非法 CIDR 结构返回 null（不抛错）", () => {
    expect(parseCidr("10.0.0.0")).toBeNull();
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0.0/-1")).toBeNull();
    expect(parseCidr("10.0.0.0/8/8")).toBeNull();
    expect(parseCidr("::/129")).toBeNull();
    expect(parseCidr("not-a-cidr")).toBeNull();
    expect(parseCidr("1.2.3.4/08")?.text).toBe("1.0.0.0/8"); // 前缀前导零宽松归一（严格层才拒绝）
    expect(() => parseCidrStrict("10.0.0.0/08")).toThrow();
    expect(() => parseCidrStrict("10.0.0.0/8 ")).toThrow(); // 尾随空白非 canonical
  });
});

describe("严格 API（parseIpStrict / parseCidrStrict / isInCidrStrict）", () => {
  it("canonical 输入通过", () => {
    expect(parseIpStrict("10.0.0.1").text).toBe("10.0.0.1");
    expect(parseIpStrict("2001:db8::1").text).toBe("2001:db8::1");
    expect(parseCidrStrict("10.0.0.0/8").text).toBe("10.0.0.0/8");
    expect(parseCidrStrict("2001:db8::/32").text).toBe("2001:db8::/32");
  });

  it("mapped 输入严格解析后归一为 v4", () => {
    expect(parseIpStrict("::ffff:1.2.3.4").family).toBe("v4");
    expect(parseIpStrict("::ffff:1.2.3.4").text).toBe("1.2.3.4");
    expect(parseCidrStrict("::ffff:1.2.3.0/120").text).toBe("1.2.3.0/24"); // 映射为 v4 前缀-96
  });

  it("非法/非规范 IP 抛错", () => {
    expect(() => parseIpStrict("01.2.3.4")).toThrow();
    expect(() => parseIpStrict("1.2.3")).toThrow();
    expect(() => parseIpStrict("not-an-ip")).toThrow();
    expect(() => parseIpStrict("")).toThrow();
  });

  it("非法/非规范 CIDR 抛错（主机位、前导零、大写、映射形式均拒绝）", () => {
    expect(() => parseCidrStrict("10.1.0.0/8")).toThrow(); // 主机位非零
    expect(() => parseCidrStrict("010.0.0.0/8")).toThrow();
    expect(() => parseCidrStrict("2001:DB8::/32")).toThrow();
    expect(() => parseCidrStrict("10.0.0.0/33")).toThrow();
    expect(() => parseCidrStrict("10.0.0.0")).toThrow();
    expect(parseCidrStrict("::ffff:1.2.3.0/128").text).toBe("1.2.3.0/32"); // /128 主机条目映射为 /32
    expect(parseCidrStrict("::ffff:1.2.3.9/128").text).toBe("1.2.3.9/32"); // mapped 无独立主机位语义，合法
    expect(() => parseCidrStrict("::ffff:1.2.3.4/64")).toThrow(); // mapped 前缀 <96
    expect(() => parseCidrStrict("::ffff:0:1.2.3.0/120")).toThrow(); // 混合形式保持 v6 且文本非 canonical
  });

  it("严格匹配 equals 宽松匹配的命中语义", () => {
    const cidr = parseCidrStrict("192.168.0.0/16");
    expect(isInCidrStrict("192.168.1.1", cidr)).toBe(true);
    expect(isInCidrStrict(parseIpStrict("192.168.1.1"), "192.168.0.0/16")).toBe(true);
    expect(isInCidrStrict("8.8.8.8", cidr)).toBe(false);
    expect(isInAnyCidrStrict("192.168.1.1", ["10.0.0.0/8", "192.168.0.0/16"])).toBe(true);
  });

  it("严格 API 对非法输入抛错（不静默 false）", () => {
    expect(() => isInCidrStrict("bad-ip", "10.0.0.0/8")).toThrow();
    expect(() => isInCidrStrict("10.1.1.1", "10.0.0.0")).toThrow();
    expect(() => isInAnyCidrStrict("10.1.1.1", ["bad-cidr"])).toThrow();
  });
});

describe("IPv6 语法严格性（反例）", () => {
  it(":::ffff 等重叠压缩/多个 :: 拒绝", () => {
    for (const bad of [":::ffff", "1::2::3", "::1::2", "1:::2", "::::", "::1:2:3:4:5:6:7::8"]) {
      expect(parseIp(bad)).toBeNull();
      expect(canonicalIp(bad)).toBeNull();
      expect(() => parseIpStrict(bad)).toThrow();
    }
  });

  it("压缩之外的空组拒绝（开头/结尾冒号、连续冒号）", () => {
    for (const bad of [":1::2", "1::2:", ":1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:", "1::2:3::", "::1:"]) {
      expect(parseIp(bad)).toBeNull();
      expect(canonicalIp(bad)).toBeNull();
      expect(() => parseIpStrict(bad)).toThrow();
    }
    expect(parseIp("::")).not.toBeNull(); // “::” 本身合法（全零地址）
  });

  it("嵌入 IPv4 仅允许地址末尾：跟在 :: 之后或尾组拒绝", () => {
    // v4 后跟压缩零段 → v4 不在最后 32 bit，拒绝
    expect(parseIp("1:2:3:4:5:1.2.3.4::")).toBeNull();
    expect(parseIp("1.2.3.4::5")).toBeNull();
    expect(parseIp("::1.2.3.4:5")).toBeNull();
    expect(parseIp("1:2:3:1.2.3.4::")).toBeNull();
    // v4 在末尾才合法：无压缩形式与 mapped 形式
    expect(canonicalIp("1:2:3:4:5:6:1.2.3.4")).toBe("1:2:3:4:5:6:102:304");
    expect(canonicalIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    // 7 组 hex + v4 = 144 bit > 128，拒绝
    expect(parseIp("1:2:3:4:5:6:7:1.2.3.4")).toBeNull();
  });
});

describe("严格 CIDR 映射与主机位（反例）", () => {
  it("mapped 精确 IP 合法归一，但 mapped CIDR 必须主机位为零", () => {
    expect(parseIpStrict("::ffff:1.2.3.4").text).toBe("1.2.3.4"); // 精确 IP 归一合法
    // 映射前缀/120 对应 v4 /24：1.2.3.4 含主机位 → 拒绝
    expect(() => parseCidrStrict("::ffff:1.2.3.4/120")).toThrow();
    // 网络地址 1.2.3.0 → 合法并映射归一
    expect(parseCidrStrict("::ffff:1.2.3.0/120").text).toBe("1.2.3.0/24");
    // /121 对应 v4 /25：1.2.3.0 是网络地址、1.2.3.1 含主机位
    expect(parseCidrStrict("::ffff:1.2.3.0/121").text).toBe("1.2.3.0/25");
    expect(() => parseCidrStrict("::ffff:1.2.3.1/121")).toThrow();
    expect(() => parseCidrStrict("::ffff:1.2.3.127/121")).toThrow();
    expect(parseCidrStrict("::ffff:1.2.3.128/121").text).toBe("1.2.3.128/25"); // /25 网络地址本身合法
    // /32 无主机位，任意 v4 均合法
    expect(parseCidrStrict("::ffff:1.2.3.9/128").text).toBe("1.2.3.9/32");
    // legacy API 保持 IPv4-only；新 API 承担 mapped 双栈语义。
    expect(isInCidr("1.2.3.4", "::ffff:1.2.3.4/120")).toBe(false); // legacy IPv4-only API
    expect(isInCidrStrict("1.2.3.4", "::ffff:1.2.3.0/120")).toBe(true);
    expect(parseCidr("::ffff:1.2.3.4/120")?.text).toBe("1.2.3.0/24");
  });

  it("一般 strict CIDR 要求 canonical 网络地址（无主机位）", () => {
    expect(() => parseCidrStrict("2001:db8::1/64")).toThrow(); // v6 主机位非零
    expect(() => parseCidrStrict("10.1.0.0/8")).toThrow(); // v4 主机位非零
    expect(parseCidrStrict("2001:db8::/64").text).toBe("2001:db8::/64");
    expect(() => parseCidrStrict("::ffff:0:1.2.3.0/120")).toThrow(); // 非 mapped 布局 → 保持 v6，文本非 canonical
  });
});

describe("跨族与 cidrContains", () => {
  it("v4 与 v6 永远不互相匹配", () => {
    expect(isInCidr("10.1.2.3", "2001:db8::/32")).toBe(false);
    expect(isInCidr("2001:db8::1", "10.0.0.0/8")).toBe(false);
    expect(isInCidr("::ffff:1.2.3.4", "2001:db8::/32")).toBe(false);
  });

  it("cidrContains 以解析结果直接判断", () => {
    const cidr = parseCidrStrict("10.0.0.0/8");
    expect(cidrContains(cidr, parseIpStrict("10.9.9.9"))).toBe(true);
    expect(cidrContains(cidr, parseIpStrict("11.1.1.1"))).toBe(false);
  });
});
