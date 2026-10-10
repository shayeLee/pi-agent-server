import type { ReactNode } from "react";
import { cn } from "@/lib/utils.js";

export const isMacPlatform = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Platform modifier glyph: ⌘ on Apple platforms, Ctrl elsewhere. */
export function modKey(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-border bg-background px-1 font-sans text-[11px] font-medium leading-none text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
