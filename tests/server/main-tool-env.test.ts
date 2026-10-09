// 仅验证入口 TOOLS 解析；启动函数截断，不启动服务或调用模型。
import { afterEach, describe, expect, it, vi } from "vitest";

const startup = vi.hoisted(() => ({ startServer: vi.fn(), stop: new Error("env-probe-stop") }));
vi.mock("../../src/server/start.js", () => ({ startServer: startup.startServer }));
vi.mock("../../src/core/ip-access-config.js", () => ({ parseIpAccessEnv: () => ({ allowedClientCidrs: [] }) }));
vi.mock("../../src/core/ip-access-policy-file.js", () => ({ loadIpAccessPolicy: () => null }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("main TOOLS 环境变量语义", () => {
  it.each([undefined, "", "   ", " , , "])("%j 归一化为未配置，不传空数组", async (value) => {
    vi.resetModules();
    vi.stubEnv("TOOLS", value);
    vi.stubEnv("PI_MIGRATION_GATE", undefined);
    vi.stubEnv("PI_DEFAULT_MODEL", undefined);
    vi.stubEnv("PI_EXTENSION_PATHS", undefined);
    vi.stubEnv("PI_PROVIDER_EXTENSION_PATHS", undefined);
    startup.startServer.mockRejectedValue(startup.stop);
    await expect(import("../../src/main.js")).rejects.toBe(startup.stop);
    expect(startup.startServer.mock.calls[0]![0].tools).toBeUndefined();
  });

  it("非空值按既有 trim/filter 规则传完整白名单", async () => {
    vi.resetModules();
    vi.stubEnv("TOOLS", " read, ,fixture_extension_tool, grep ");
    vi.stubEnv("PI_MIGRATION_GATE", undefined);
    vi.stubEnv("PI_DEFAULT_MODEL", undefined);
    vi.stubEnv("PI_EXTENSION_PATHS", undefined);
    vi.stubEnv("PI_PROVIDER_EXTENSION_PATHS", undefined);
    startup.startServer.mockRejectedValue(startup.stop);
    await expect(import("../../src/main.js")).rejects.toBe(startup.stop);
    expect(startup.startServer.mock.calls[0]![0].tools).toEqual(["read", "fixture_extension_tool", "grep"]);
  });
});
