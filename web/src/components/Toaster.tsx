import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { dismissToast, useToasts } from "@/lib/toast.js";
import { cn } from "@/lib/utils.js";
import { useI18n } from "@/i18n/I18nProvider.js";

const ICONS = { error: AlertCircle, info: Info, success: CheckCircle2 } as const;

export function Toaster() {
  const toasts = useToasts();
  const { t } = useI18n();
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
      data-testid="toaster"
    >
      {toasts.map((item) => {
        const Icon = ICONS[item.tone];
        return (
          <div
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
            data-testid="toast"
            data-tone={item.tone}
            className="pointer-events-auto flex items-start gap-2.5 rounded-[10px] border bg-popover px-3 py-2.5 text-popover-foreground shadow-lg ui-enter"
          >
            <Icon
              aria-hidden="true"
              className={cn(
                "mt-px size-4 shrink-0",
                item.tone === "error" ? "text-destructive" : item.tone === "success" ? "text-success" : "text-primary",
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-5">{item.title}</p>
              {item.description && (
                <p className="mt-0.5 break-words text-[12px] leading-[18px] text-muted-foreground">{item.description}</p>
              )}
            </div>
            <button
              type="button"
              className="-mr-1 -mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t("common.dismiss")}
              onClick={() => dismissToast(item.id)}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
