// 应用层凭证端口：只暴露启动阶段实际需要的运行时 API key 操作。
// 不把 authPath、token、OAuth 或 Pi SDK 凭证类型带入 application/server/runtime。

export interface CredentialPort {
  setRuntimeApiKey(provider: string, apiKey: string): Promise<void>;
  hasConfiguredAuth(provider: string): boolean;
}
