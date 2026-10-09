import { useCallback, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { AlertDialog, Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "../lib/cn.js";
import { useT } from "../../i18n/index.js";
import { Button } from "./button.js";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const overlayClass = "fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out";
const contentClass = [
  "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-dialog -translate-x-1/2 -translate-y-1/2",
  "rounded-xl bg-raised p-5 text-fg shadow-dialog outline-none",
  "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
];

export function DialogContent({ className, children, hideClose = false, ...props }: ComponentProps<typeof DialogPrimitive.Content> & { hideClose?: boolean }) {
  const t = useT();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-ui="" className={overlayClass} />
      <DialogPrimitive.Content data-ui="" className={cn(contentClass, className)} {...props}>
        {children}
        {!hideClose && (
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon-sm" className="absolute right-3 top-3" aria-label={t("common.close")}>
              <X />
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5 pr-8", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-5 flex justify-end gap-2", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-lg font-semibold tracking-tight", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-sm text-fg-muted", className)} {...props} />;
}

export type ConfirmOptions = {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
};

/**
 * Promise-based replacement for `window.confirm`: render `confirmElement` once,
 * then `await confirm({...})` resolves true/false. Escape and overlay clicks cancel.
 */
export function useConfirm(): { confirm: (options: ConfirmOptions) => Promise<boolean>; confirmElement: ReactNode } {
  const t = useT();
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setOpen(false);
  }, []);

  const confirm = useCallback((next: ConfirmOptions) => {
    resolveRef.current?.(false);
    setOptions(next);
    setOpen(true);
    return new Promise<boolean>((resolve) => { resolveRef.current = resolve; });
  }, []);

  const confirmElement = (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!next) settle(false); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay data-ui="" className={overlayClass} />
        <AlertDialog.Content data-ui="" className={cn(contentClass, "max-w-[400px]")}>
          <div className="flex flex-col gap-1.5">
            <AlertDialog.Title className="text-lg font-semibold tracking-tight">{options?.title}</AlertDialog.Title>
            {options?.description
              ? <AlertDialog.Description className="text-sm text-fg-muted">{options.description}</AlertDialog.Description>
              : <AlertDialog.Description className="sr-only">{options?.title}</AlertDialog.Description>}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" onClick={() => settle(false)}>{options?.cancelLabel ?? t("common.cancel")}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant={options?.tone === "danger" ? "danger" : "primary"} onClick={() => settle(true)}>
                {options?.confirmLabel ?? t("common.confirm")}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );

  return { confirm, confirmElement };
}
