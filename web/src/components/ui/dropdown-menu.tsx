import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-dropdown-menu";
import { cn } from "../../lib/cn.js";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;
export function DropdownMenuContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal><Primitive.Content data-ui="dropdown-menu" sideOffset={sideOffset} className={cn(
    "ui:z-50 ui:min-w-40 ui:max-w-[calc(100vw-2rem)] ui:max-h-[var(--radix-dropdown-menu-content-available-height)] ui:overflow-y-auto ui:rounded-md ui:border ui:border-solid ui:border-line ui:bg-surface ui:p-1 ui:font-sans ui:text-base-sm ui:text-foreground ui:shadow-md",
    className,
  )} {...props} /></Primitive.Portal>;
}
// Radix data-highlighted tracks keyboard focus too; only pointer hover paints a fill.
const itemClass = "ui:relative ui:flex ui:cursor-default ui:select-none ui:items-center ui:gap-2 ui:rounded-sm ui:px-2 ui:py-1.5 ui:outline-none ui:hover:bg-muted ui:data-[disabled]:pointer-events-none ui:data-[disabled]:opacity-50";
export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item data-ui="dropdown-item" className={cn(itemClass, className)} {...props} />;
}
export function DropdownMenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof Primitive.CheckboxItem>) {
  return <Primitive.CheckboxItem data-ui="dropdown-checkbox" className={cn(itemClass, "ui:pl-7", className)} {...props}>
    <span className="ui:absolute ui:left-2"><Primitive.ItemIndicator>✓</Primitive.ItemIndicator></span>{children}
  </Primitive.CheckboxItem>;
}
export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof Primitive.RadioItem>) {
  return <Primitive.RadioItem data-ui="dropdown-radio" className={cn(itemClass, "ui:pl-7", className)} {...props}>
    <span className="ui:absolute ui:left-2" aria-hidden="true"><Primitive.ItemIndicator>●</Primitive.ItemIndicator></span>{children}
  </Primitive.RadioItem>;
}
export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Primitive.Label>) {
  return <Primitive.Label data-ui="dropdown-label" className={cn("ui:px-2 ui:py-1.5 ui:font-semibold", className)} {...props} />;
}
export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator data-ui="dropdown-separator" className={cn("ui:-mx-1 ui:my-1 ui:h-px ui:bg-line", className)} {...props} />;
}
