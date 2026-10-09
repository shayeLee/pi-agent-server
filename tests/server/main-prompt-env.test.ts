// Entry wiring only: no service, credentials, or model requests.
import { afterEach, describe, expect, it, vi } from "vitest";

const startup = vi.hoisted(() => ({ startServer: vi.fn(), stop: new Error("prompt-env-stop") }));
vi.mock("../../src/server/start.js", () => ({ startServer: startup.startServer }));
vi.mock("../../src/core/ip-access-config.js", () => ({ parseIpAccessEnv: () => ({ allowedClientCidrs: [] }) }));
vi.mock("../../src/core/ip-access-policy-file.js", () => ({ loadIpAccessPolicy: () => null }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("main prompt environment wiring", () => {
  it.each([undefined, "", " \n\t ", "/tmp/explicit.txt", "relative.txt"])("passes explicit PI_APPEND_SYSTEM_FILE %j without reading at the env boundary", async (value) => {
    vi.resetModules();
    vi.stubEnv("PI_APPEND_SYSTEM_FILE", value);
    vi.stubEnv("PI_APPEND_SYSTEM", "literal text");
    vi.stubEnv("PI_SYSTEM_PROMPT", "whole prompt override");
    for (const key of ["PI_MIGRATION_GATE", "PI_DEFAULT_MODEL", "PI_EXTENSION_PATHS", "PI_PROVIDER_EXTENSION_PATHS"]) vi.stubEnv(key, undefined);
    startup.startServer.mockRejectedValue(startup.stop);
    await expect(import("../../src/main.js")).rejects.toBe(startup.stop);
    expect(startup.startServer.mock.calls[0]![0]).toMatchObject({
      systemPrompt: "whole prompt override", appendSystemPrompt: "literal text", appendSystemPromptFile: value,
    });
  });
  it.each([undefined, "", " \n\t ", "  first line\nsecond line  "])("passes raw PI_APPEND_SYSTEM %j alongside PI_SYSTEM_PROMPT", async (value) => {
    vi.resetModules();
    vi.stubEnv("PI_APPEND_SYSTEM", value);
    vi.stubEnv("PI_SYSTEM_PROMPT", "whole prompt override");
    vi.stubEnv("PI_APPEND_SYSTEM_FILE", undefined);
    for (const key of ["PI_MIGRATION_GATE", "PI_DEFAULT_MODEL", "PI_EXTENSION_PATHS", "PI_PROVIDER_EXTENSION_PATHS"]) vi.stubEnv(key, undefined);
    startup.startServer.mockRejectedValue(startup.stop);
    await expect(import("../../src/main.js")).rejects.toBe(startup.stop);
    expect(startup.startServer.mock.calls[0]![0]).toMatchObject({
      systemPrompt: "whole prompt override", appendSystemPrompt: value,
    });
  });
});
