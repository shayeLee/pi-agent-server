import type { ComponentProps } from "react";
import { Icon } from "./Icon.js";
/** Preserve native select semantics/keyboard behavior, but share our SVG indicator. */
export function IconSelect(props: ComponentProps<"select">) {
  return <span className="icon-select chevron-trigger"><select {...props} /><Icon name="down" className="disclosure-chevron" /></span>;
}
