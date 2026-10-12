import type { ComponentProps } from "react";
import * as Primitive from "@radix-ui/react-dialog";
import { cn } from "../../lib/cn.js";

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
export const DialogPortal = Primitive.Portal;
export function DialogOverlay({ className, ...props }: ComponentProps<typeof Primitive.Overlay>) {
  return <Primitive.Overlay data-ui="dialog-overlay" className={cn("ui:fixed ui:inset-0 ui:z-50 ui:bg-black/45", className)} {...props} />;
}
/** Compose a Title, Description and explicit Close inside; no hidden/default actions. */
export function DialogContent({ className, children, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <DialogPortal><DialogOverlay /><Primitive.Content data-ui="dialog" className={cn(
    "ui:fixed ui:top-1/2 ui:left-1/2 ui:z-50 ui:grid ui:max-h-[calc(100dvh-2rem)] ui:w-[calc(100%-2rem)] ui:max-w-lg ui:-translate-x-1/2 ui:-translate-y-1/2 ui:gap-4 ui:overflow-y-auto ui:rounded-lg ui:border ui:border-solid ui:border-line ui:bg-surface ui:p-6 ui:font-sans ui:text-foreground ui:shadow-lg",
    className,
  )} {...props}>{children}</Primitive.Content></DialogPortal>;
}
export function DialogTitle({ className, ...props }: ComponentProps<typeof Primitive.Title>) {
  return <Primitive.Title data-ui="dialog-title" className={cn("ui:m-0 ui:text-lg ui:font-semibold ui:leading-6", className)} {...props} />;
}
export function DialogDescription({ className, ...props }: ComponentProps<typeof Primitive.Description>) {
  return <Primitive.Description data-ui="dialog-description" className={cn("ui:m-0 ui:text-sm ui:text-muted-foreground", className)} {...props} />;
}
