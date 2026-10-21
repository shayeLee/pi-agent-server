import { describe, expect, it, vi } from "vitest";
import type { AuthInteraction, CredentialInfo, Provider } from "@earendil-works/pi-ai";
import { ProviderLoginError, ProviderLogins, type ProviderLoginRuntime } from "../../src/model-adapters/pi-provider-logins.js";
import type { ProviderLogin } from "../../src/shared/provider-auth.js";

type LoginImpl = (interaction: AuthInteraction) => Promise<unknown>;

function provider(id: string, name: string, auth: Record<string, unknown>): Provider {
  return { id, name, auth } as unknown as Provider;
}

function fakeRuntime(options: { stored?: CredentialInfo[]; login?: LoginImpl } = {}) {
  const stored = [...(options.stored ?? [])];
  const calls: { providerId: string; type: string; deviceId?: string }[] = [];
  const runtime: ProviderLoginRuntime = {
    getProviders: () => [
      provider("openai", "OpenAI", { oauth: { name: "ChatGPT", isSubscription: true, loginLabel: "Sign in with ChatGPT" }, apiKey: { name: "OpenAI API key", login: async () => ({}) } }),
      provider("bedrock", "Amazon Bedrock", { apiKey: { name: "AWS credentials" } }),
    ],
    getProviderAuthStatus: id => id === "openai" ? { configured: true, source: "stored" } : { configured: false },
    isUsingOAuth: id => id === "openai",
    listCredentials: async () => stored,
    login: (providerId, type, interaction, loginOptions) => {
      calls.push({ providerId, type, deviceId: loginOptions?.getDeviceId?.() });
      return (options.login ?? (async () => undefined))(interaction);
    },
    logout: async providerId => { stored.splice(stored.findIndex(item => item.providerId === providerId), 1); },
  };
  return { runtime, calls, stored };
}

/** 让 SDK 那一侧的 promise 链跑完。 */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("ProviderLogins", () => {
  it("lists sign-in methods, status, and stored credentials of providers that are gone", async () => {
    const { runtime } = fakeRuntime({ stored: [{ providerId: "openai", type: "oauth" }, { providerId: "retired", type: "api_key" }] });
    expect(await new ProviderLogins(runtime).list()).toEqual({ providers: [
      { id: "bedrock", name: "Amazon Bedrock", apiKey: { name: "AWS credentials", interactive: false }, status: { configured: false } },
      {
        id: "openai", name: "OpenAI", oauth: { name: "ChatGPT", subscription: true, loginLabel: "Sign in with ChatGPT" },
        apiKey: { name: "OpenAI API key", interactive: true }, status: { configured: true, type: "oauth", source: "stored" }, stored: "oauth",
      },
      { id: "retired", name: "retired", status: { configured: false }, stored: "api_key" },
    ] });
  });

  it("records what the provider shows and waits for answers", async () => {
    let manualCode = "";
    const { runtime, calls } = fakeRuntime({ login: async interaction => {
      interaction.notify({ type: "auth_url", url: "https://auth.example.com/authorize", instructions: "Open in a browser" });
      const account = await interaction.prompt({ type: "select", message: "Workspace", options: [{ id: "team", label: "Team" }] });
      manualCode = await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
      interaction.notify({ type: "progress", message: `Signed in to ${account}` });
    } });
    const logins = new ProviderLogins(runtime, { getDeviceId: () => "device-1" });
    const started = logins.start("owner-a", "openai", "oauth");
    await settle();
    let login = logins.get("owner-a", started.id);
    expect(login).toMatchObject({ provider: "openai", method: "oauth", state: "running", steps: [{ type: "auth_url", url: "https://auth.example.com/authorize" }] });
    expect(login.prompt).toMatchObject({ type: "select", options: [{ id: "team", label: "Team" }] });
    expect(calls).toEqual([{ providerId: "openai", type: "oauth", deviceId: "device-1" }]);

    expect(() => logins.answer("owner-a", login.id, login.prompt!.id, "other")).toThrow(expect.objectContaining({ code: "invalid_answer" }));
    logins.answer("owner-a", login.id, login.prompt!.id, "team");
    await settle();
    login = logins.get("owner-a", login.id);
    expect(login.prompt).toMatchObject({ type: "manual_code" });
    expect(() => logins.answer("owner-a", login.id, "stale", "x")).toThrow(expect.objectContaining({ code: "stale_prompt" }));
    logins.answer("owner-a", login.id, login.prompt!.id, "http://localhost:1455/callback?code=abc");
    await settle();

    login = logins.get("owner-a", login.id);
    expect(manualCode).toBe("http://localhost:1455/callback?code=abc");
    expect(login.state).toBe("succeeded");
    expect(login.prompt).toBeUndefined();
    expect(login.steps.at(-1)).toEqual({ type: "progress", message: "Signed in to team" });
    // 回答的内容不进记录。
    expect(JSON.stringify(login)).not.toContain("code=abc");
  });

  it("drops a prompt the provider resolved another way", async () => {
    const callback = new AbortController();
    const { runtime } = fakeRuntime({ login: async interaction => {
      const pasted = interaction.prompt({ type: "manual_code", message: "Paste", signal: callback.signal }).catch(() => "callback");
      await new Promise(resolve => setTimeout(resolve, 5));
      callback.abort();
      return pasted;
    } });
    const logins = new ProviderLogins(runtime);
    const { id } = logins.start("owner-a", "openai", "oauth");
    await settle();
    expect(logins.get("owner-a", id).prompt?.type).toBe("manual_code");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(logins.get("owner-a", id)).toMatchObject({ state: "succeeded" });
    expect(logins.get("owner-a", id).prompt).toBeUndefined();
  });

  it("keeps logins to the caller who started them, and cancels on request", async () => {
    const { runtime } = fakeRuntime({ login: interaction => interaction.prompt({ type: "secret", message: "API key" }) });
    const logins = new ProviderLogins(runtime);
    const { id } = logins.start("owner-a", "openai", "api_key");
    await settle();
    expect(() => logins.get("owner-b", id)).toThrow(ProviderLoginError);
    expect(() => logins.cancel("owner-b", id)).toThrow(expect.objectContaining({ code: "unknown_login" }));
    expect(logins.cancel("owner-a", id)).toMatchObject({ state: "cancelled" });
    await settle();
    expect(logins.get("owner-a", id)).toMatchObject({ state: "cancelled" });
    expect(logins.get("owner-a", id).prompt).toBeUndefined();
  });

  it("cancels the earlier login when the same provider starts again", async () => {
    const { runtime } = fakeRuntime({ login: interaction => interaction.prompt({ type: "secret", message: "API key" }) });
    const logins = new ProviderLogins(runtime);
    const first = logins.start("owner-a", "openai", "api_key");
    const second = logins.start("owner-b", "openai", "oauth");
    await settle();
    expect(logins.get("owner-a", first.id).state).toBe("cancelled");
    expect(logins.get("owner-b", second.id).state).toBe("running");
  });

  it("reports failures, refuses methods a provider lacks, and expires unfinished logins", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const { runtime } = fakeRuntime({ login: interaction => interaction.prompt({ type: "text", message: "Code" }) });
      const logins = new ProviderLogins(runtime, { now: () => now });
      expect(() => logins.start("owner-a", "missing", "oauth")).toThrow(expect.objectContaining({ code: "unknown_provider" }));
      expect(() => logins.start("owner-a", "bedrock", "api_key")).toThrow(expect.objectContaining({ code: "unsupported_method" }));
      expect(() => logins.start("owner-a", "bedrock", "oauth")).toThrow(expect.objectContaining({ code: "unsupported_method" }));

      const { id } = logins.start("owner-a", "openai", "oauth");
      now = 10 * 60_000 + 1;
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      expect(logins.get("owner-a", id)).toMatchObject({ state: "failed", error: expect.stringContaining("10 分钟") });
      now += 5 * 60_000 + 1;
      expect(() => logins.get("owner-a", id)).toThrow(expect.objectContaining({ code: "unknown_login" }));
    } finally { vi.useRealTimers(); }

    const { runtime } = fakeRuntime({ login: async () => { throw new Error("invalid_grant"); } });
    const logins = new ProviderLogins(runtime);
    const { id } = logins.start("owner-a", "openai", "oauth");
    await settle();
    const failed: ProviderLogin = logins.get("owner-a", id);
    expect(failed).toMatchObject({ state: "failed", error: "invalid_grant" });
  });

  it("removes stored credentials", async () => {
    const { runtime, stored } = fakeRuntime({ stored: [{ providerId: "openai", type: "oauth" }] });
    await new ProviderLogins(runtime).logout("openai");
    expect(stored).toEqual([]);
  });
});
