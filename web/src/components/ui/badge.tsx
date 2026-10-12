import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

export function Badge({ className, variant = "default", ...props }: ComponentProps<"span"> & { variant?: "default" | "secondary" | "outline" }) {
  return <span data-ui="badge" className={cn(
    "ui:inline-flex ui:items-center ui:rounded-md ui:border ui:border-solid ui:px-2 ui:py-0.5 ui:font-sans ui:text-xs ui:font-medium",
    variant === "default" && "ui:border-transparent ui:bg-primary ui:text-primary-foreground",
    variant === "secondary" && "ui:border-transparent ui:bg-muted ui:text-foreground",
    variant === "outline" && "ui:border-line ui:text-foreground",
    className,
  )} {...props} />;
}
