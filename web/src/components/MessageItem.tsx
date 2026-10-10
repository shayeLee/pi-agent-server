import { memo, useEffect, useRef, useState } from "react";
import { imageDataUrl, readMessageImages } from "../message-images.js";
import type { TimelineItem } from "pi-agent-server/client";
import { Markdown } from "./Markdown.js";
import { Icon } from "./Icon.js";
import { ThinkingRow } from "./ThinkingRow.js";

export type MessageItemProps = {
  item: Extract<TimelineItem, { kind: "message" | "thinking" }>;
};

function messageClock(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export const MessageItem = memo(function MessageItem({ item }: MessageItemProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (preview) dialogRef.current?.showModal(); }, [preview]);
  if (item.kind === "thinking") {
    return <ThinkingRow thinking={item} />;
  }

  const clock = messageClock("timestamp" in item ? (item as { timestamp?: unknown }).timestamp : undefined);

  if (item.role === "user") {
    return (
      <div className="message-row row-user flex items-start justify-end gap-2" data-testid={`message-${item.id}`}>
        <div className="message-user max-w-[min(520px,76%)]">
          <div className="user-bubble whitespace-pre-wrap rounded-xl px-3 py-1.5 text-[14px] leading-normal">
            {item.text && <div>{item.text}</div>}
            {readMessageImages(item.images).length > 0 && <div className="message-images">
              {readMessageImages(item.images).map((image, index) => <button type="button" key={index}
                aria-label={`预览图片 ${index + 1}`} onClick={() => setPreview(imageDataUrl(image))}>
                <img src={imageDataUrl(image)} alt={`已发送图片 ${index + 1}`} />
              </button>)}
            </div>}
          </div>
          {preview && <dialog ref={dialogRef} className="message-image-preview" aria-label="图片预览"
            onCancel={() => setPreview(null)} onClose={() => setPreview(null)}>
            <button type="button" onClick={() => setPreview(null)} aria-label="关闭图片预览"><Icon name="close" /></button>
            <img src={preview} alt="图片预览" />
          </dialog>}
        </div>
        {clock && <time className="message-time shrink-0 pt-1 text-[12px] tabular-nums text-muted-foreground" dateTime={String((item as { timestamp?: unknown }).timestamp)}>{clock}</time>}
      </div>
    );
  }

  return (
    <div className="message-row row-assistant flex items-start gap-3" data-testid={`message-${item.id}`}>
      {clock && <time className="message-time w-10 shrink-0 pt-0.5 text-[12px] tabular-nums text-muted-foreground" dateTime={String((item as { timestamp?: unknown }).timestamp)}>{clock}</time>}
      <div className="message-assistant min-w-0 flex-1">
        <div className="assistant-content text-[14px] leading-normal">
          {item.text && <Markdown text={item.text} />}
          {item.streaming && <Icon name="caret" className="streaming-cursor" />}
        </div>
      </div>
    </div>
  );
});
