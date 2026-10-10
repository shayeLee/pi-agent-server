import type { ComponentProps } from "react";
import { Icon } from "./Icon.js";
/** Preserve native select semantics/keyboard behavior, but share our SVG indicator. */
export function IconSelect({ className, ...props }: ComponentProps<"select">) {
  return <span className="icon-select chevron-trigger relative inline-flex min-h-8 items-center"><select {...props} className={`h-8 appearance-none rounded-md border border-border bg-background py-1 pl-2 pr-6 text-[13px] ${className ?? ""}`} /><Icon name="down" className="disclosure-chevron pointer-events-none absolute right-1.5" /></span>;
}
