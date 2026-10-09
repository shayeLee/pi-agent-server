import type { ComponentProps } from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.js";

export const buttonVariants = cva(
  [
    "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium",
    "transition-[background-color,background-image,color,border-color,box-shadow]",
    "disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:size-4",
  ],
  {
    variants: {
      variant: {
        primary: "bg-accent text-on-accent hover:bg-accent-hover active:overlay-pressed",
        secondary: "border border-border bg-surface text-fg hover:border-border-strong hover:overlay-hover active:overlay-pressed",
        ghost: "text-fg-muted hover:bg-hover hover:text-fg active:bg-pressed data-[state=open]:bg-selected data-[state=open]:text-fg",
        danger: "bg-danger-solid text-on-accent hover:overlay-hover active:overlay-pressed",
        "danger-ghost": "text-danger hover:bg-danger-soft",
        link: "h-auto px-0 text-accent-text underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-6 gap-1 rounded-sm px-2 text-xs [&_svg]:size-3.5",
        sm: "h-7 px-2.5 text-sm",
        md: "h-8 px-3 text-sm",
        lg: "h-9 px-4 text-base",
        "icon-xs": "size-6 rounded-sm [&_svg]:size-3.5",
        "icon-sm": "size-7",
        icon: "size-8",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants> & {
  /** Render the single child element with button styling (e.g. a router link). */
  asChild?: boolean;
};

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...(asChild ? {} : { type: type ?? "button" })}
      {...props}
    />
  );
}
