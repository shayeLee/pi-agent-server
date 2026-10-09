import type { ComponentProps } from "react";
import { Separator as SeparatorPrimitive } from "radix-ui";
import { LoaderCircle } from "lucide-react";
import { cn } from "../lib/cn.js";

export function Separator({ className, orientation = "horizontal", ...props }: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)}
      {...props}
    />
  );
}

export function Spinner({ className, ...props }: ComponentProps<typeof LoaderCircle>) {
  return <LoaderCircle aria-hidden className={cn("size-4 animate-spin text-fg-subtle", className)} {...props} />;
}
