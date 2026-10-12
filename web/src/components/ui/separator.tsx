import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-separator";
import { cn } from "../../lib/cn.js";

export function Separator({ className, orientation = "horizontal", decorative = true, ...props }: ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root data-ui="separator" orientation={orientation} decorative={decorative} className={cn(
    "ui:shrink-0 ui:bg-line",
    orientation === "horizontal" ? "ui:h-px ui:w-full" : "ui:h-full ui:w-px",
    className,
  )} {...props} />;
}
