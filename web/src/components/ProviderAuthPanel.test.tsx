import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProviderAuthList, ProviderLogin } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { useProviderAuth } from "./ProviderAuthPanel.js";

const text = zhCN.providerAuth;

const providers: ProviderAuthList = { providers: [
  { id: "openai", name: "OpenAI", oauth: { name: "ChatGPT", subscription: true }, apiKey: { name: "OpenAI API key", interactive: true },
    status: { configured: false } },
  { id: "anthropic", name: "Anthropic", apiKey: { name: "Anthropic API key", interactive: true },
    status: { configured: true, type: "api_key", source: "ANTHROPIC_API_KEY" }, stored: "api_key" },
  { id: "bedrock", name: "Amazon Bedrock", apiKey: { name: "AWS credentials", interactive: false }, status: { configured: false } },
  { id: "retired", name: "retired", status: { configured: false }, stored: "oauth" },
] };

function login(patch: Partial<ProviderLogin> = {}): ProviderLogin {
  return { id: "l1", provider: "openai", method: "oauth", state: "running", steps: [], ...patch };
}

function setup(overrides: Partial<Record<string, unknown>> = {}) {
  const api = {
    listProviderAuth: vi.fn(async () => providers),
    startProviderLogin: vi.fn(async () => login()),
    getProviderLogin: vi.fn(async () => login()),
    answerProviderLogin: vi.fn(async () => login()),
    cancelProviderLogin: vi.fn(async () => login({ state: "cancelled" })),
    removeProviderCredential: vi.fn(async () => providers),
    ...overrides,
  };
  render(<Entry api={api as Parameters<typeof useProviderAuth>[0]["api"]} />);
  return api;
}

/** 代替侧栏“设置”菜单里的那一项。 */
function Entry({ api }: { api: Parameters<typeof useProviderAuth>[0]["api"] }) {
  const auth = useProviderAuth({ api });
  return <>{auth.available && <button type="button" data-testid="provider-auth-open" onClick={auth.openPanel}>open</button>}{auth.dialog}</>;
}

async function openPanel() {
  fireEvent.click(await screen.findByTestId("provider-auth-open"));
  return screen.findByTestId("provider-auth-panel");
}

const row = (provider: string) => screen.getAllByTestId("provider-auth-row").find(item => item.dataset.provider === provider)!;

describe("ProviderAuthPanel", () => {
  it("is hidden from callers who cannot read the list", async () => {
    const api = setup({ listProviderAuth: vi.fn(async () => { throw new Error("HTTP 403"); }) });
    await waitFor(() => expect(api.listProviderAuth).toHaveBeenCalled());
    expect(screen.queryByTestId("provider-auth-open")).toBeNull();
  });

  it("lists usable providers first with their methods, and filters", async () => {
    setup();
    await openPanel();
    expect(screen.getAllByTestId("provider-auth-row").map(item => item.dataset.provider)).toEqual(["anthropic", "bedrock", "openai", "retired"]);
    expect(within(row("anthropic")).getByText(text.status.configuredFrom("API key", "ANTHROPIC_API_KEY"))).toBeTruthy();
    expect(within(row("anthropic")).getByTestId("provider-auth-api-key").textContent).toBe(text.replaceKey);
    expect(within(row("bedrock")).getByText(text.ambientOnly("AWS credentials"))).toBeTruthy();
    expect(within(row("openai")).getByTestId("provider-auth-oauth").textContent).toBe(text.signIn);
    expect(within(row("openai")).queryByTestId("provider-auth-remove")).toBeNull();
    expect(within(row("retired")).getByText(text.status.notLoaded)).toBeTruthy();
    expect(within(row("retired")).getByTestId("provider-auth-remove").textContent).toBe(text.logout);

    fireEvent.change(screen.getByTestId("provider-auth-filter"), { target: { value: "open" } });
    expect(screen.getAllByTestId("provider-auth-row").map(item => item.dataset.provider)).toEqual(["openai"]);
  });

  it("walks through an OAuth login: link, pasted redirect URL, success", async () => {
    const steps = [{ type: "auth_url" as const, url: "https://auth.openai.com/authorize?x=1" }];
    const prompt = { id: "p1", type: "manual_code" as const, message: "Paste the redirect URL" };
    const api = setup({
      startProviderLogin: vi.fn(async () => login({ steps, prompt })),
      answerProviderLogin: vi.fn(async () => login({ steps })),
      getProviderLogin: vi.fn(async () => login({ steps, state: "succeeded" })),
    });
    await openPanel();
    fireEvent.click(within(row("openai")).getByTestId("provider-auth-oauth"));
    const progress = await within(row("openai")).findByTestId("provider-auth-login");
    expect(api.startProviderLogin).toHaveBeenCalledWith({ provider: "openai", method: "oauth" });
    expect(within(progress).getByTestId("provider-auth-url").getAttribute("href")).toBe(steps[0].url);
    expect(within(progress).getByText(text.manualCodeHint)).toBeTruthy();
    // 进行中时，别的行不能再发起登录。
    expect((within(row("anthropic")).getByTestId("provider-auth-api-key") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(progress).getByTestId("provider-auth-answer"), { target: { value: "http://localhost:1455/auth/callback?code=c" } });
    fireEvent.submit(within(progress).getByTestId("provider-auth-prompt"));
    await waitFor(() => expect(api.answerProviderLogin).toHaveBeenCalledWith("l1", { promptId: "p1", value: "http://localhost:1455/auth/callback?code=c" }));
    expect(await within(row("openai")).findByText(text.done.oauth, {}, { timeout: 3000 })).toBeTruthy();
    expect(api.listProviderAuth).toHaveBeenCalledTimes(3);
  });

  it("asks for an API key as a password field and lets the login be cancelled", async () => {
    const api = setup({ startProviderLogin: vi.fn(async () => login({ provider: "anthropic", method: "api_key", prompt: { id: "p1", type: "secret", message: "API key" } })),
      cancelProviderLogin: vi.fn(async () => login({ provider: "anthropic", method: "api_key", state: "cancelled" })) });
    await openPanel();
    fireEvent.click(within(row("anthropic")).getByTestId("provider-auth-api-key"));
    const progress = await within(row("anthropic")).findByTestId("provider-auth-login");
    expect(within(progress).getByTestId("provider-auth-answer").getAttribute("type")).toBe("password");
    fireEvent.click(within(progress).getByTestId("provider-auth-cancel"));
    expect(await within(row("anthropic")).findByText(text.cancelled)).toBeTruthy();
    expect(api.cancelProviderLogin).toHaveBeenCalledWith("l1");
  });

  it("removes a stored credential after confirmation", async () => {
    const api = setup();
    await openPanel();
    fireEvent.click(within(row("anthropic")).getByTestId("provider-auth-remove"));
    expect(within(row("anthropic")).getByText(text.confirmRemoveKey)).toBeTruthy();
    fireEvent.click(within(row("anthropic")).getByText(text.confirm));
    await waitFor(() => expect(api.removeProviderCredential).toHaveBeenCalledWith("anthropic"));
  });
});
