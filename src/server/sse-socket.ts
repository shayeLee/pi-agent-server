// SSE 传输 socket 抽象：把 SSE 路由对 reply.raw / request.raw 的依赖收窄为可注入接口，
// 便于用 fake socket 确定性测试背压、断线清理等传输关注点（浏览器/fetch 无法触发 write=false）。

export interface SseSocket {
  writeHead(status: number, headers: Record<string, string>): void;
  flushHeaders(): void;
  /** 返回 false 表示底层缓冲已满（背压信号）。 */
  write(data: string): boolean;
  end(): void;
  /** 注册连接关闭回调（客户端断线）。 */
  onClose(cb: () => void): void;
}

export type SseReplyRaw = {
  writeHead(status: number, headers: Record<string, string>): void;
  flushHeaders(): void;
  write(data: string): boolean;
  end(): void;
};

export type SseRequestRaw = { on(event: "close", cb: () => void): void };

/** 默认实现：包装 Fastify 的 reply.raw 与 request.raw。 */
export function defaultSseSocket(replyRaw: SseReplyRaw, requestRaw: SseRequestRaw): SseSocket {
  return {
    writeHead: (status, headers) => replyRaw.writeHead(status, headers),
    flushHeaders: () => replyRaw.flushHeaders(),
    write: (data) => replyRaw.write(data),
    end: () => replyRaw.end(),
    onClose: (cb) => requestRaw.on("close", cb),
  };
}
