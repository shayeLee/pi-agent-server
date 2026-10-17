// codemode 并发准入与超时（docs/mcp-integration.md §9）。
// SDK 的 QuickJS worker 上限是进程级的 2 个，超出时直接报错；这里在 tool_call 中排队，
// 并给每个脚本加上超时（SDK 默认不限时）。

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const CODEMODE_TOOL = "codemode";
const OPTIONS_PREFIX = "// @options:";
/** 与 SDK 的 MAX_CONCURRENT_CODEMODE_WORKERS 一致。 */
export const CODEMODE_CAPACITY = 2;
export const DEFAULT_CODEMODE_TIMEOUT_MS = 120_000;
export const DEFAULT_CODEMODE_QUEUE_WAIT_MS = 60_000;

/** 进程级信号量：所有会话共享，先到先得。 */
export class CodemodeGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(readonly capacity = CODEMODE_CAPACITY) {}

  get running(): number { return this.active; }
  get queued(): number { return this.waiters.length; }

  /** 取得名额后返回只生效一次的释放函数；超时或中止时返回 null。 */
  async acquire(maxWaitMs: number, signal?: AbortSignal): Promise<(() => void) | null> {
    if (this.active < this.capacity) return this.grant();
    if (signal?.aborted) return null;
    return new Promise(resolve => {
      const wake = () => {
        cleanup();
        resolve(this.grant());
      };
      const giveUp = () => {
        cleanup();
        const index = this.waiters.indexOf(wake);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve(null);
      };
      const timer = setTimeout(giveUp, maxWaitMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", giveUp);
      };
      signal?.addEventListener("abort", giveUp, { once: true });
      this.waiters.push(wake);
    });
  }

  private grant(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      // 名额直接交给下一个等待者，避免被新来的调用插队。
      const next = this.waiters.shift();
      next?.();
    };
  }
}

/**
 * 给脚本加上 timeout_ms：没有 `// @options:` 首行时插入；已有时把 timeout_ms 钳到上限。
 * 首行不是合法 JSON 对象时原样返回，交给 SDK 报出原本的错误。
 */
export function withCodemodeTimeout(code: string, maxTimeoutMs: number): string {
  if (code.trim() === "") return code;
  const newline = code.indexOf("\n");
  const firstLine = (newline === -1 ? code : code.slice(0, newline)).replace(/\r$/, "").trimStart();
  if (!firstLine.startsWith(OPTIONS_PREFIX)) return `${OPTIONS_PREFIX} ${JSON.stringify({ timeout_ms: maxTimeoutMs })}\n${code}`;
  let options: unknown;
  try { options = JSON.parse(firstLine.slice(OPTIONS_PREFIX.length).trim()); }
  catch { return code; }
  if (typeof options !== "object" || options === null || Array.isArray(options)) return code;
  const current = (options as { timeout_ms?: unknown }).timeout_ms;
  const timeout = typeof current === "number" && Number.isSafeInteger(current) && current > 0 ? Math.min(current, maxTimeoutMs) : maxTimeoutMs;
  const rest = newline === -1 ? "" : code.slice(newline);
  return `${OPTIONS_PREFIX} ${JSON.stringify({ ...options, timeout_ms: timeout })}${rest}`;
}

export function createCodemodeAdmissionExtension(options: {
  gate: CodemodeGate;
  timeoutMs?: number;
  queueWaitMs?: number;
}): Extract<InlineExtension, { factory: unknown }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CODEMODE_TIMEOUT_MS;
  const queueWaitMs = options.queueWaitMs ?? DEFAULT_CODEMODE_QUEUE_WAIT_MS;
  return {
    name: "pi-agent-server-codemode-admission",
    factory: pi => {
      const held = new Map<string, () => void>();
      const release = (toolCallId: string) => {
        held.get(toolCallId)?.();
        held.delete(toolCallId);
      };
      pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== CODEMODE_TOOL) return undefined;
        const input = event.input as { code?: unknown };
        if (typeof input.code === "string") input.code = withCodemodeTimeout(input.code, timeoutMs);
        const granted = await options.gate.acquire(queueWaitMs, ctx.signal);
        if (!granted) {
          return { block: true, reason: `codemode is busy: ${options.gate.capacity} scripts are already running on this server; try again shortly` };
        }
        held.set(event.toolCallId, granted);
        return undefined;
      });
      // tool_result 与 tool_execution_end 都释放（幂等），被其他 hook 拦下的调用也不会占着名额。
      pi.on("tool_result", event => { release(event.toolCallId); });
      pi.on("tool_execution_end", event => { release(event.toolCallId); });
      pi.on("session_shutdown", () => {
        for (const toolCallId of [...held.keys()]) release(toolCallId);
      });
    },
  };
}
