import { useState } from "react";
import { Icon } from "./Icon.js";
import type { TimelineItem } from "pi-agent-server/client";
import { useI18n } from "../i18n/I18nProvider.js";

export type ThinkingRowProps = {
  thinking: Extract<TimelineItem, { kind: "thinking" }>;
};

function thinkingPreview(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.replace(/\s+/g, " ").trim()).find(Boolean);
  return line ?? "";
}

export function ThinkingRow({ thinking }: ThinkingRowProps) {
  const { t } = useI18n();
  // Streaming opens by default, but an explicit user choice can still collapse it.
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const visible = manualExpanded ?? thinking.streaming;
  // Keep hooks and manual state mounted for this id, even before useful text arrives.
  if (!thinking.text.trim()) return null;
  const preview = thinkingPreview(thinking.text);

  return (
    <div
      className={`message-row thinking-row ${thinking.streaming ? "streaming" : ""}`}
      data-expanded={visible}
      data-testid={`thinking-${thinking.id}`}
    >
      <button
        type="button"
        className="thinking-header chevron-trigger"
        onClick={() => setManualExpanded(!visible)}
        aria-expanded={visible}
        aria-label={t("thinking.label")}
      >
        <span className="thinking-label">{thinking.streaming ? t("thinking.streaming") : t("thinking.done")}</span>
        {!visible && preview && <span className="thinking-summary">{preview}</span>}
        <Icon name="chevron" className="disclosure-chevron thinking-chevron" />
      </button>
      {visible && (
        <div className="thinking-body" data-testid={`thinking-body-${thinking.id}`}>
          {thinking.text}
          {thinking.streaming && <Icon name="dot" className="streaming-cursor" />}
        </div>
      )}
    </div>
  );
}
