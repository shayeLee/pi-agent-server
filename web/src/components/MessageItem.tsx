import { memo, useEffect, useRef, useState } from "react";
import { imageDataUrl, readMessageImages } from "../message-images.js";
import type { TimelineItem } from "pi-agent-server/client";
import { Markdown } from "./Markdown.js";
import { Icon } from "./Icon.js";
import { ThinkingRow } from "./ThinkingRow.js";

export type MessageItemProps = {
  item: Extract<TimelineItem, { kind: "message" | "thinking" }>;
};

export const MessageItem = memo(function MessageItem({ item }: MessageItemProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (preview) dialogRef.current?.showModal(); }, [preview]);
  if (item.kind === "thinking") {
    return <ThinkingRow thinking={item} />;
  }

  if (item.role === "user") {
    return (
      <div className="message-row row-user flex justify-end" data-testid={`message-${item.id}`}>
        <div className="message-user max-w-[min(520px,76%)]">
          <div className="user-bubble whitespace-pre-wrap rounded-[10px] bg-muted px-3 py-2 text-[15px] leading-relaxed">
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
      </div>
    );
  }

  return (
    <div className="message-row row-assistant" data-testid={`message-${item.id}`}>
      <div className="message-assistant">
        <div className="assistant-content text-[15px] leading-relaxed">
          {item.text && <Markdown text={item.text} />}
          {item.streaming && <Icon name="dot" className="streaming-cursor" />}
        </div>
      </div>
    </div>
  );
});
