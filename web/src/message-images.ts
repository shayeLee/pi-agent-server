import type { TimelineItem } from "pi-agent-server/client";

export type MessageImages = NonNullable<Extract<TimelineItem, { kind: "message" }>["images"]>;

/** Export images have already passed backend raster validation and export budgets.
 * Never interpret paths, URLs or arbitrary MIME types as image sources. */
export function readMessageImages(value: unknown): MessageImages {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { mediaType, base64 } = item as Record<string, unknown>;
    return typeof mediaType === "string" && ["image/png", "image/jpeg", "image/webp"].includes(mediaType) &&
      typeof base64 === "string" && base64.length > 0 && base64.length <= 5_592_408 &&
      base64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64)
      ? [{ mediaType, base64 }] : [];
  });
}

export function imageDataUrl(image: MessageImages[number]): string {
  return `data:${image.mediaType};base64,${image.base64}`;
}
