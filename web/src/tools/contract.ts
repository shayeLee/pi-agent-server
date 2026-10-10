import type { ToolCall } from "pi-agent-server/client";
import type { ComponentType } from "react";
import type { IconName } from "../components/Icon.js";

/** Presentation only: no lifecycle, transport, child state, or mutation. */
export type ToolHeader = {
  icon: IconName;
  summary: string;
  /** Path, command, or other target, without the result suffix. */
  target?: string;
  /** Short result hint, shown apart from the target. */
  outcome?: string;
  badge?: string;
  priorityLabels?: string[];
  /** Preview following priority labels, kept separate from the full summary. */
  preview?: string;
};
export type ToolMetadata = {
  icon: IconName;
  outputLines?: number | "last";
  summarize: (call: ToolCall) => Omit<ToolHeader, "icon">;
};
export type ArgumentsProps = { value: unknown; args: unknown };
export type ResultProps = { label: string; value: unknown; args: unknown; onViewRaw: () => void };
export type ToolRenderers = {
  Arguments: ComponentType<ArgumentsProps>;
  Result: ComponentType<ResultProps>;
};
export type ToolPresentation = ToolRenderers & { header: ToolHeader };
