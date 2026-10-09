import type { ComponentProps, ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "../lib/cn.js";

export function TooltipProvider({ delayDuration = 400, skipDelayDuration = 200, ...props }: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />;
}

export function TooltipContent({ className, sideOffset = 6, children, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-ui=""
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-64 select-none rounded-sm bg-fg px-2 py-1 text-xs text-canvas",
          "origin-(--radix-tooltip-content-transform-origin) animate-fade-in data-[state=closed]:animate-fade-out",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/** Label + optional shortcut tooltip around a single focusable trigger. */
export function Tooltip({ content, side = "top", children }: { content: ReactNode; side?: "top" | "right" | "bottom" | "left"; children: ReactNode }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </TooltipPrimitive.Root>
  );
}
