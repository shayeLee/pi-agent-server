// model-failback host transport：扩展通过会话专属 EventBus 同步取得，绝不走 ExtensionAPI.sendUserMessage。
export const FAILBACK_HOST_TRANSPORT_EVENT = "model-failback:host-transport";

export type FailbackHostTransport = {
  begin(attemptId: string): boolean;
  cancelled(): boolean;
  enqueue(text: string): Promise<boolean>;
  end(attemptId: string): void;
};

export type FailbackHostTransportHandshake = {
  readonly version: 1;
  accept(transport: FailbackHostTransport): void;
};

export function isFailbackHostTransportHandshake(value: unknown): value is FailbackHostTransportHandshake {
  return typeof value === "object" && value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { accept?: unknown }).accept === "function";
}
