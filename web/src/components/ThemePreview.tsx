import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Separator } from "@/components/ui/separator.js";

/** Off-screen shadcn token preview for phase-1 verification screenshots. */
export function ThemePreview() {
  return (
    <div
      className="shadcn-root pointer-events-none fixed -left-[9999px] top-0 z-[9999] flex gap-4 p-4"
      data-testid="theme-preview"
      aria-hidden="true"
    >
      <div className="w-56 rounded-lg border border-border bg-background p-3 shadow-sm">
        <p className="mb-2 text-[11px] font-medium text-muted-foreground">Light tokens</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm">Primary</Button>
          <Button size="sm" variant="secondary">Secondary</Button>
          <Badge>Badge</Badge>
        </div>
        <Separator className="my-2" />
        <p className="font-mono text-[12px] text-foreground">JetBrains Mono</p>
      </div>
      <div className="dark w-56 rounded-lg border border-border bg-background p-3 shadow-sm">
        <p className="mb-2 text-[11px] font-medium text-muted-foreground">Dark tokens</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm">Primary</Button>
          <Button size="sm" variant="outline">Outline</Button>
          <Badge variant="secondary">Badge</Badge>
        </div>
      </div>
    </div>
  );
}
