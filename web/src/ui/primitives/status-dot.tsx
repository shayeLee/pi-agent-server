import type { ComponentProps } from "react";
import { cn } from "../lib/cn.js";

export type RunStatus = "running" | "queued" | "idle" | "error" | "aborted" | "done";

const toneByStatus: Record<RunStatus, string> = {
  running: "bg-accent animate-pulse-dot",
  queued: "bg-warning",
  idle: "bg-fg-faint/60",
  error: "bg-danger",
  aborted: "border border-fg-subtle bg-transparent",
  done: "bg-success",
};

/** A 6px session/run status indicator. Pass `label` when the dot is the only status cue. */
export function StatusDot({ status, label, className, ...props }: ComponentProps<"span"> & { status: RunStatus; label?: string }) {
  return (
    <span
      data-slot="status-dot"
      data-status={status}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", toneByStatus[status], className)}
      {...props}
    />
  );
}
