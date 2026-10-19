import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-tooltip";
import { cn } from "../../lib/cn.js";

export const TooltipProvider = Primitive.Provider;
export const Tooltip = Primitive.Root;
export const TooltipTrigger = Primitive.Trigger;
export function TooltipContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal><Primitive.Content data-ui="tooltip" sideOffset={sideOffset} className={cn(
    "ui:z-[100] ui:max-w-xs ui:rounded-lg ui:border ui:border-solid ui:border-line ui:bg-surface ui:px-3 ui:py-1.5 ui:font-sans ui:text-xs ui:text-foreground ui:shadow-md",
    className,
  )} {...props} /></Primitive.Portal>;
}
