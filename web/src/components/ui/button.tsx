import type { ComponentProps } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/cn.js";

const variants = {
  default: "ui:border-transparent ui:bg-primary ui:text-primary-foreground ui:hover:opacity-90",
  outline: "ui:border-line ui:bg-surface ui:text-foreground ui:hover:bg-muted",
  ghost: "ui:border-transparent ui:bg-transparent ui:text-foreground ui:hover:bg-muted",
  destructive: "ui:border-transparent ui:bg-danger ui:text-surface ui:hover:opacity-90",
};
const sizes = { default: "ui:h-9 ui:px-4 ui:py-2", sm: "ui:h-8 ui:px-3", icon: "ui:size-9 ui:p-0" };
type ButtonOptions = {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
};
export type ButtonProps = ButtonOptions & (
  | (ComponentProps<"button"> & { asChild?: false })
  | (Omit<ComponentProps<"button">, "disabled"> & { asChild: true; disabled?: never })
);
export function Button({ className, variant = "default", size = "default", asChild = false, type, disabled, ...props }: ButtonProps) {
  if (asChild && disabled !== undefined) {
    throw new Error("Button: disabled is not supported with asChild");
  }
  const Comp = asChild ? Slot : "button";
  return <Comp data-ui="button" type={asChild ? type : (type ?? "button")} className={cn(
    "ui:inline-flex ui:shrink-0 ui:items-center ui:justify-center ui:gap-2 ui:rounded-md ui:border ui:border-solid ui:font-sans ui:text-base-sm ui:font-medium ui:leading-5 ui:cursor-pointer ui:disabled:pointer-events-none ui:disabled:opacity-50",
    variants[variant], sizes[size], className,
  )} {...props} {...(disabled === undefined ? {} : { disabled })} />;
}
