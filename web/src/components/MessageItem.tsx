import { zhCN } from "../i18n/zh-CN.js";
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
      <div className="message-row row-user" data-testid={`message-${item.id}`}>
        <div className="message-user">
          {item.sourceLabel && <div className="subagent-message-source">{item.sourceLabel}</div>}
          <div className="user-bubble">
            {item.text && <div>{item.text}</div>}
            {readMessageImages(item.images).length > 0 && <div className="message-images">
              {readMessageImages(item.images).map((image, index) => <button type="button" key={index}
                aria-label={zhCN.message.previewImage(index + 1)} onClick={() => setPreview(imageDataUrl(image))}>
                <img src={imageDataUrl(image)} alt={zhCN.message.sentImage(index + 1)} />
              </button>)}
            </div>}
          </div>
          {preview && <dialog ref={dialogRef} className="message-image-preview" aria-label={zhCN.message.imagePreview}
            onCancel={() => setPreview(null)} onClose={() => setPreview(null)}>
            <button type="button" onClick={() => setPreview(null)} aria-label={zhCN.message.closePreview}><Icon name="close" /></button>
            <img src={preview} alt={zhCN.message.imagePreview} />
          </dialog>}
        </div>
      </div>
    );
  }

  return (
    <div className="message-row row-assistant" data-testid={`message-${item.id}`}>
      <div className="message-assistant">
        <div className="assistant-content">
          {item.text && <Markdown text={item.text} />}
          {item.streaming && <Icon name="dot" className="streaming-cursor" />}
          {item.stopReason === "aborted" && <div className="assistant-terminal-status" data-testid={`aborted-${item.id}`}>
            {zhCN.status.aborted}
          </div>}
        </div>
      </div>
    </div>
  );
});
