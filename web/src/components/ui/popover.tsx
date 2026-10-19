import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-popover";
import { cn } from "../../lib/cn.js";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverAnchor = Primitive.Anchor;
export const PopoverClose = Primitive.Close;
export const PopoverArrow = Primitive.Arrow;
export function PopoverContent({ className, align = "center", sideOffset = 4, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal><Primitive.Content data-ui="popover" align={align} sideOffset={sideOffset} className={cn(
    "ui:z-[100] ui:w-72 ui:max-w-[calc(100vw-2rem)] ui:rounded-lg ui:border ui:border-solid ui:border-line ui:bg-surface ui:p-4 ui:font-sans ui:text-base-sm ui:text-foreground ui:shadow-md",
    className,
  )} {...props} /></Primitive.Portal>;
}
