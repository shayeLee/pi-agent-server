import { describe, expect, it } from "vitest";
import { parseAuthMode, resolveAuthConfig } from "../../src/auth/auth-config.js";

describe("PI_AUTH_MODE", () => {
  it("defaults to ip and accepts only ip or accounts", () => {
    expect(parseAuthMode(undefined)).toBe("ip");
    expect(parseAuthMode("")).toBe("ip");
    expect(parseAuthMode("ip")).toBe("ip");
    expect(parseAuthMode("accounts")).toBe("accounts");
    for (const value of ["Accounts", " accounts", "account", "off"]) expect(() => parseAuthMode(value), value).toThrow(/PI_AUTH_MODE/);
  });
});

describe("accounts mode settings from PI_PUBLIC_URL", () => {
  it("needs PI_PUBLIC_URL as an http(s) URL", () => {
    expect(resolveAuthConfig({ mode: "ip" })).toEqual({ mode: "ip" });
    expect(() => resolveAuthConfig({ mode: "accounts" })).toThrow(/PI_PUBLIC_URL/);
    expect(() => resolveAuthConfig({ mode: "accounts", publicUrl: "not a url" })).toThrow(/PI_PUBLIC_URL/);
    expect(() => resolveAuthConfig({ mode: "accounts", publicUrl: "ftp://h" })).toThrow(/http 或 https/);
  });

  it("names the cookie after the effective port, filling in the default port", () => {
    const cases: Array<[string, string, boolean]> = [
      ["https://pi.example.ts.net", "pi_session_443", true],
      ["http://pi.example", "pi_session_80", false],
      ["https://h:443", "pi_session_443", true],
      ["http://192.168.5.137:5180", "pi_session_5180", false],
      ["https://h:8443/base/path", "pi_session_8443", true],
    ];
    for (const [publicUrl, cookieName, secure] of cases) {
      const config = resolveAuthConfig({ mode: "accounts", publicUrl });
      expect(config.mode === "accounts" && config.cookieName, publicUrl).toBe(cookieName);
      expect(config.mode === "accounts" && config.cookieSecure, publicUrl).toBe(secure);
    }
  });

  it("uses only the origin of a URL with a path, and trusts just that origin by default", () => {
    const config = resolveAuthConfig({ mode: "accounts", publicUrl: "https://H.example:443/pi/" });
    expect(config).toMatchObject({ publicOrigin: "https://h.example", trustedOrigins: new Set(["https://h.example"]) });
  });

  it("PI_TRUSTED_ORIGINS replaces the default but must include the public origin", () => {
    const publicUrl = "http://192.168.5.137:5180";
    const config = resolveAuthConfig({ mode: "accounts", publicUrl, trustedOrigins: "http://192.168.5.137:5180, http://127.0.0.1:5173" });
    expect(config.mode === "accounts" && [...config.trustedOrigins]).toEqual(["http://192.168.5.137:5180", "http://127.0.0.1:5173"]);
    expect(() => resolveAuthConfig({ mode: "accounts", publicUrl, trustedOrigins: "http://127.0.0.1:5173" })).toThrow(/必须包含/);
  });

  it("rejects wildcards, null, paths and non-canonical origins in PI_TRUSTED_ORIGINS", () => {
    const publicUrl = "http://h:5180";
    for (const entry of ["*", "null", "http://h:5180/", "http://h:5180/x", "http://H:5180", "https://h:443", "http://h:5180?x"]) {
      expect(() => resolveAuthConfig({ mode: "accounts", publicUrl, trustedOrigins: `http://h:5180,${entry}` }), entry).toThrow(/PI_TRUSTED_ORIGINS/);
    }
  });
});
