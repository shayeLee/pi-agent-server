import type { ComponentProps } from "react";
import { DropdownMenu as Menu } from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "../lib/cn.js";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuRadioGroup = Menu.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 4, align = "start", ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        data-ui=""
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "z-50 min-w-44 max-w-menu overflow-hidden rounded-lg bg-raised p-1 text-fg shadow-popover",
          "origin-(--radix-dropdown-menu-content-transform-origin) data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

const itemClass = [
  "relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none",
  "data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
  "[&_svg]:size-4 [&_svg]:text-fg-subtle",
];

export function DropdownMenuItem({ className, tone = "default", ...props }: ComponentProps<typeof Menu.Item> & { tone?: "default" | "danger" }) {
  return (
    <Menu.Item
      className={cn(itemClass, tone === "danger" && "text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger", className)}
      {...props}
    />
  );
}

export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(itemClass, "pr-8", className)} {...props}>
      {children}
      <Menu.ItemIndicator className="absolute right-2 inline-flex">
        <Check className="text-accent-text!" />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return <Menu.Label className={cn("px-2 pb-1 pt-1.5 text-xs font-medium text-fg-subtle", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("ml-auto pl-4 text-xs text-fg-faint", className)} {...props} />;
}
