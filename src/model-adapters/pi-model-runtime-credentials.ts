// Pi ModelRuntime → application CredentialPort 适配层。
// 仅包装 application 当前需要的凭证操作，避免 Pi 凭证类型扩散到应用层。

import type { CredentialPort } from "../application/ports/credential-port.js";

type ModelRuntimeLike = {
  setRuntimeApiKey(provider: string, apiKey: string): Promise<void>;
  hasConfiguredAuth(provider: string): boolean;
};

export class PiModelRuntimeCredentials implements CredentialPort {
  constructor(private readonly runtime: ModelRuntimeLike) {}

  setRuntimeApiKey(provider: string, apiKey: string): Promise<void> {
    return this.runtime.setRuntimeApiKey(provider, apiKey);
  }

  hasConfiguredAuth(provider: string): boolean {
    return this.runtime.hasConfiguredAuth(provider);
  }
}
