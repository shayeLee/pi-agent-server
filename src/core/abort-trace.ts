// Temporary opt-in lifecycle diagnostics. No prompts, tool payloads, or credentials.
import { AsyncLocalStorage } from "node:async_hooks";
import { ChildProcess } from "node:child_process";

const context = new AsyncLocalStorage<{ sessionId: string }>();
let users = 0;
let uninstall: (() => void) | undefined;
export const abortTraceEnabled = () => process.env.PI_ABORT_TRACE === "1";

export function abortTrace(event: string, fields: Record<string, string | number | undefined> = {}, stack = false): void {
  if (!abortTraceEnabled()) return;
  try {
    process.stderr.write(JSON.stringify({ diagnostic: "abort-trace", timestamp: new Date().toISOString(), pid: process.pid,
      event, ...context.getStore(), ...fields,
      ...(stack ? { stack: new Error().stack?.split("\n").slice(2, 10).join("\n") } : {}) }) + "\n");
  } catch { /* Diagnostics must not change cancellation or signal delivery. */ }
}

export function withAbortTrace<T>(sessionId: string, run: () => T): T {
  return abortTraceEnabled() ? context.run({ sessionId }, run) : run();
}

/** Process-wide signal tracing, enabled only explicitly; always forwards the original call. */
export function installAbortTrace(): () => void {
  if (!abortTraceEnabled()) return () => {};
  if (users++ === 0) {
    const processKill = process.kill;
    const childKill = ChildProcess.prototype.kill;
    const tracedProcessKill: typeof process.kill = function (pid, signal) {
      if (signal !== 0) abortTrace("process.kill", { targetPid: pid, signal: signal ?? "SIGTERM" }, true);
      return processKill.call(process, pid, signal);
    };
    const tracedChildKill: typeof childKill = function (this: ChildProcess, signal) {
      if (signal !== 0) abortTrace("child.kill", { targetPid: this.pid, signal: signal ?? "SIGTERM" }, true);
      return childKill.call(this, signal);
    };
    process.kill = tracedProcessKill;
    ChildProcess.prototype.kill = tracedChildKill;
    uninstall = () => {
      if (process.kill === tracedProcessKill) process.kill = processKill;
      if (ChildProcess.prototype.kill === tracedChildKill) ChildProcess.prototype.kill = childKill;
    };
    abortTrace("enabled");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) { uninstall?.(); uninstall = undefined; }
  };
}

export function traceSessionLifecycle(session: object, sessionId: string): void {
  if (!abortTraceEnabled()) return;
  abortTrace("sdk.created", { sessionId });
  const target = session as Record<string, unknown>;
  for (const method of ["abort", "reload", "dispose"] as const) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = function (this: unknown, ...args: unknown[]) {
      return withAbortTrace(sessionId, () => {
        abortTrace(`sdk.${method}`, { sessionId }, true);
        return Reflect.apply(original, this, args);
      });
    };
  }
}
