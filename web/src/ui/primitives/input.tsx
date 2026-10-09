import type { ComponentProps } from "react";
import { cn } from "../lib/cn.js";

const fieldClass = [
  "w-full min-w-0 rounded-md border border-border bg-surface px-2.5 text-sm text-fg",
  "transition-[border-color,box-shadow] hover:border-border-strong",
  "focus-visible:border-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
  "aria-invalid:border-danger aria-invalid:focus-visible:ring-danger-soft",
  "disabled:opacity-50",
];

export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return <input data-slot="input" type={type} className={cn(fieldClass, "h-8", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClass, "min-h-20 resize-y py-2 leading-relaxed", className)}
      {...props}
    />
  );
}
