// 模型登录（/v1/provider-auth，对应 Pi TUI 的 /login 与 /logout）的公开 DTO，服务端与 Web 共用。
// 凭证写进 Pi 的 auth.json，整个服务共用这一份身份，所以只有 admin 能看能改。

export type ProviderAuthMethod = "oauth" | "api_key";

export interface ProviderAuthEntry {
  readonly id: string;
  readonly name: string;
  /** 账号登录（OAuth）；loginLabel 是 provider 自己给的说法，例如 “Sign in with ChatGPT Plus/Pro”。 */
  readonly oauth?: { readonly name: string; readonly loginLabel?: string; readonly subscription: boolean };
  /** API key；interactive 为 false 时只能靠环境变量等外部来源（例如云厂商凭证），不能在这里填。 */
  readonly apiKey?: { readonly name: string; readonly interactive: boolean };
  /** 当前能不能用、凭证从哪来。 */
  readonly status: { readonly configured: boolean; readonly type?: ProviderAuthMethod; readonly source?: string };
  /** auth.json 里存的凭证类型；只有存了才能退出登录。 */
  readonly stored?: ProviderAuthMethod;
}

export interface ProviderAuthList {
  readonly providers: readonly ProviderAuthEntry[];
}

/** 登录过程中 provider 给出的信息，按先后顺序。 */
export type ProviderLoginStep =
  | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
  | { readonly type: "device_code"; readonly userCode: string; readonly verificationUri: string; readonly expiresInSeconds?: number }
  | { readonly type: "info"; readonly message: string; readonly links?: readonly { readonly url: string; readonly label?: string }[] }
  | { readonly type: "progress"; readonly message: string };

/** 等用户回答的问题；manual_code 是把浏览器最后跳到的地址或授权码粘回来。 */
export interface ProviderLoginPrompt {
  readonly id: string;
  readonly type: "text" | "secret" | "select" | "manual_code";
  readonly message: string;
  readonly placeholder?: string;
  readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
}

export interface ProviderLogin {
  readonly id: string;
  readonly provider: string;
  readonly method: ProviderAuthMethod;
  readonly state: "running" | "succeeded" | "failed" | "cancelled";
  readonly steps: readonly ProviderLoginStep[];
  readonly prompt?: ProviderLoginPrompt;
  readonly error?: string;
}

export interface ProviderLoginStart {
  readonly provider: string;
  readonly method: ProviderAuthMethod;
}

export interface ProviderLoginAnswer {
  readonly promptId: string;
  readonly value: string;
}
