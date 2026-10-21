// 模型登录（Pi TUI 的 /login、/logout 搬到 Web）：把 ModelRuntime.login 的交互回调变成可轮询的登录记录。
//
// - provider 发来的授权链接、设备码、进度按顺序记进 steps；要用户回答的问题挂在 prompt 上，
//   Web 回答后才继续。OAuth 回调落在服务所在机器的 localhost 上，远程打开 Web 时回调到不了，
//   provider 会同时给出 manual_code 问题，让用户把浏览器最后跳到的地址粘回来（和 TUI 在无界面机器上一样）。
// - 登录只对发起它的调用者可见；同一个 provider 再次发起会取消上一次；超过 10 分钟没完成自动取消。
// - 回答的内容（API key、授权码）只交给 SDK，不进记录、不进日志。

import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt, CredentialInfo, LoginOptions, Provider } from "@earendil-works/pi-ai";
import type {
  ProviderAuthEntry, ProviderAuthList, ProviderAuthMethod, ProviderLogin, ProviderLoginPrompt, ProviderLoginStep,
} from "../shared/provider-auth.js";

/** 本模块用到的 ModelRuntime 能力；测试可以注入假的。 */
export type ProviderLoginRuntime = {
  getProviders(): readonly Provider[];
  getProviderAuthStatus(providerId: string): { configured: boolean; source?: string; label?: string };
  isUsingOAuth(providerId: string): boolean;
  listCredentials(options?: { signal?: AbortSignal }): Promise<readonly CredentialInfo[]>;
  login(providerId: string, type: ProviderAuthMethod, interaction: AuthInteraction, options?: LoginOptions): Promise<unknown>;
  logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
};

export type ProviderLoginErrorCode = "unknown_provider" | "unsupported_method" | "unknown_login" | "stale_prompt" | "invalid_answer";

export class ProviderLoginError extends Error {
  constructor(readonly code: ProviderLoginErrorCode, message: string) {
    super(message);
    this.name = "ProviderLoginError";
  }
}

const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** 结束的登录再留一会儿，让 Web 能读到结果。 */
const FINISHED_RETENTION_MS = 5 * 60_000;
const CREDENTIAL_TIMEOUT_MS = 15_000;
const CANCELLED = "Login cancelled";

type PendingPrompt = {
  readonly view: ProviderLoginPrompt;
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
};

type LoginRecord = {
  readonly id: string;
  readonly ownerKey: string;
  readonly provider: string;
  readonly method: ProviderAuthMethod;
  readonly controller: AbortController;
  readonly timer: NodeJS.Timeout;
  state: ProviderLogin["state"];
  steps: ProviderLoginStep[];
  pending?: PendingPrompt;
  error?: string;
  finishedAt?: number;
};

export class ProviderLogins {
  private readonly logins = new Map<string, LoginRecord>();

  constructor(private readonly runtime: ProviderLoginRuntime, private readonly options: {
    /** OpenAI 等 provider 登录时要一个稳定的安装 ID（UUID）。 */
    readonly getDeviceId?: () => string;
    readonly now?: () => number;
  } = {}) {}

  async list(): Promise<ProviderAuthList> {
    const stored = new Map((await this.runtime.listCredentials({ signal: AbortSignal.timeout(CREDENTIAL_TIMEOUT_MS) }))
      .map(credential => [credential.providerId, credential.type] as const));
    const providers = this.runtime.getProviders().map((provider): ProviderAuthEntry => {
      const status = this.runtime.getProviderAuthStatus(provider.id);
      const source = status.label ?? status.source;
      const oauth = provider.auth.oauth;
      const apiKey = provider.auth.apiKey;
      const storedType = stored.get(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        ...(oauth ? { oauth: { name: oauth.name, subscription: oauth.isSubscription === true, ...(oauth.loginLabel ? { loginLabel: oauth.loginLabel } : {}) } } : {}),
        ...(apiKey ? { apiKey: { name: apiKey.name, interactive: typeof apiKey.login === "function" } } : {}),
        status: status.configured
          ? { configured: true, type: this.runtime.isUsingOAuth(provider.id) ? "oauth" : "api_key", ...(source ? { source } : {}) }
          : { configured: false },
        ...(storedType ? { stored: storedType } : {}),
      };
    });
    // 已经存过凭证、但 provider 现在不在了（扩展被卸载等）：仍然列出来，好让人退出登录。
    for (const [id, type] of stored) {
      if (!providers.some(provider => provider.id === id)) providers.push({ id, name: id, status: { configured: false }, stored: type });
    }
    return { providers: providers.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  start(ownerKey: string, providerId: string, method: ProviderAuthMethod): ProviderLogin {
    this.prune();
    const provider = this.runtime.getProviders().find(item => item.id === providerId);
    if (!provider) throw new ProviderLoginError("unknown_provider", `没有 provider ${providerId}`);
    const supported = method === "oauth" ? Boolean(provider.auth.oauth) : typeof provider.auth.apiKey?.login === "function";
    if (!supported) throw new ProviderLoginError("unsupported_method", method === "oauth" ? "这个 provider 不支持账号登录" : "这个 provider 不能在这里填 API key");
    for (const other of this.logins.values()) {
      if (other.provider === providerId && other.state === "running") this.abort(other);
    }
    const controller = new AbortController();
    const record: LoginRecord = {
      id: randomUUID(), ownerKey, provider: providerId, method, controller,
      timer: setTimeout(() => this.abort(record, "登录超过 10 分钟没有完成，已取消"), LOGIN_TIMEOUT_MS),
      state: "running", steps: [],
    };
    record.timer.unref?.();
    this.logins.set(record.id, record);
    const interaction: AuthInteraction = {
      signal: controller.signal,
      notify: event => { if (record.state === "running") record.steps.push(toStep(event)); },
      prompt: prompt => this.ask(record, prompt),
    };
    const getDeviceId = this.options.getDeviceId;
    this.runtime.login(providerId, method, interaction, getDeviceId ? { getDeviceId } : undefined).then(
      () => this.finish(record, "succeeded"),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (record.state !== "running") return;
        if (controller.signal.aborted || message === CANCELLED) this.finish(record, "cancelled");
        else if (error instanceof Error && error.name === "CredentialSynchronizationError") {
          // 凭证已经写进 auth.json，只是本进程的模型列表没同步上。
          this.finish(record, "succeeded", `凭证已保存，但模型列表没有更新：${message}`);
        } else this.finish(record, "failed", message);
      },
    );
    return view(record);
  }

  get(ownerKey: string, id: string): ProviderLogin {
    return view(this.find(ownerKey, id));
  }

  answer(ownerKey: string, id: string, promptId: string, value: string): ProviderLogin {
    const record = this.find(ownerKey, id);
    const pending = record.pending;
    if (record.state !== "running" || !pending || pending.view.id !== promptId) {
      throw new ProviderLoginError("stale_prompt", "这个问题已经不需要回答了");
    }
    if (pending.view.type === "select" && !pending.view.options?.some(option => option.id === value)) {
      throw new ProviderLoginError("invalid_answer", "选项不存在");
    }
    record.pending = undefined;
    pending.resolve(value);
    return view(record);
  }

  cancel(ownerKey: string, id: string): ProviderLogin {
    const record = this.find(ownerKey, id);
    this.abort(record);
    return view(record);
  }

  async logout(providerId: string): Promise<void> {
    await this.runtime.logout(providerId, { signal: AbortSignal.timeout(CREDENTIAL_TIMEOUT_MS) });
  }

  /** 服务关闭时取消所有进行中的登录，放掉 OAuth 回调端口。 */
  close(): void {
    for (const record of this.logins.values()) this.abort(record);
    this.logins.clear();
  }

  private ask(record: LoginRecord, prompt: AuthPrompt): Promise<string> {
    if (record.state !== "running") return Promise.reject(new Error(CANCELLED));
    return new Promise<string>((resolve, reject) => {
      const promptView: ProviderLoginPrompt = {
        id: randomUUID(), type: prompt.type, message: prompt.message,
        ...("placeholder" in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
        ...(prompt.type === "select" ? { options: prompt.options.map(option => ({ id: option.id, label: option.label, ...(option.description ? { description: option.description } : {}) })) } : {}),
      };
      // 问题被别的途径解决了（例如 OAuth 回调先到），就收起它。
      const onAbort = () => {
        if (record.pending?.view.id === promptView.id) record.pending = undefined;
        reject(new Error(CANCELLED));
      };
      if (prompt.signal?.aborted) return onAbort();
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      record.pending = {
        view: promptView,
        resolve: value => { prompt.signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject: error => { prompt.signal?.removeEventListener("abort", onAbort); reject(error); },
      };
    });
  }

  private find(ownerKey: string, id: string): LoginRecord {
    this.prune();
    const record = this.logins.get(id);
    if (!record || record.ownerKey !== ownerKey) throw new ProviderLoginError("unknown_login", "登录不存在或已过期");
    return record;
  }

  private abort(record: LoginRecord, error?: string): void {
    if (record.state !== "running") return;
    record.controller.abort();
    this.finish(record, error ? "failed" : "cancelled", error);
  }

  private finish(record: LoginRecord, state: Exclude<ProviderLogin["state"], "running">, error?: string): void {
    if (record.state !== "running") return;
    clearTimeout(record.timer);
    record.state = state;
    record.error = error;
    record.finishedAt = this.now();
    const pending = record.pending;
    record.pending = undefined;
    pending?.reject(new Error(CANCELLED));
  }

  private prune(): void {
    const now = this.now();
    for (const [id, record] of this.logins) {
      if (record.finishedAt !== undefined && now - record.finishedAt > FINISHED_RETENTION_MS) this.logins.delete(id);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function toStep(event: AuthEvent): ProviderLoginStep {
  switch (event.type) {
    case "auth_url": return { type: "auth_url", url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) };
    case "device_code": return {
      type: "device_code", userCode: event.userCode, verificationUri: event.verificationUri,
      ...(event.expiresInSeconds !== undefined ? { expiresInSeconds: event.expiresInSeconds } : {}),
    };
    case "info": return { type: "info", message: event.message, ...(event.links?.length ? { links: event.links.map(link => ({ url: link.url, ...(link.label ? { label: link.label } : {}) })) } : {}) };
    default: return { type: "progress", message: event.message };
  }
}

function view(record: LoginRecord): ProviderLogin {
  return {
    id: record.id, provider: record.provider, method: record.method, state: record.state, steps: [...record.steps],
    ...(record.pending ? { prompt: record.pending.view } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}
