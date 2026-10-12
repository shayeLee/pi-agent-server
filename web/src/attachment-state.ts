import type { UploadedFile } from "pi-agent-server/client";

export type FileKind = "text" | "code" | "csv" | "json" | "pdf" | "docx" | "xlsx" | "pptx";

export type UnsentAttachment = {
  localId: string;
  name: string;
  size: number;
  mediaType: string;
  kind: "image" | FileKind;
  status: "processing" | "uploading" | "ready" | "error" | "interrupted";
  error?: string;
  /** Retained only in this page for an explicit retry after a definite upload rejection. */
  file?: File;
  uploadKey?: string;
  server?: UploadedFile;
  image?: { mediaType: string; base64: string; preview: string };
};

export type UnsentMessage = {
  text: string;
  attachments: UnsentAttachment[];
  /** Only explicit new-session choices are submitted, never synthetic defaults. */
  settings: { modelProvider?: string; modelId?: string; thinkingLevel?: string };
};

export type SubmitSnapshot = {
  scope: string;
  projectId: string;
  sessionId: string | null;
  requestId: string;
  createRequestId: string;
  text: string;
  localIds: string[];
  fileIds: string[];
  images: { mediaType: string; base64: string }[];
  settings: UnsentMessage["settings"];
};

export type SubmitOutcome = "accepted" | "failed" | "unknown";
export type SubmissionState = {
  snapshot: SubmitSnapshot;
  phase: "creating" | "configuring" | "submitting" | "failed" | "unknown" | "accepted";
  stage: "create" | "config" | "send";
  error?: string;
};

export const EMPTY_MESSAGE: UnsentMessage = { text: "", attachments: [], settings: {} };
export const IMAGE_LIMITS = { maxCount: 4, maxEach: 4 * 1024 * 1024, maxTotal: 6 * 1024 * 1024 } as const;
export const FILE_LIMITS = { maxCount: 5, maxEach: 20 * 1024 * 1024, maxTotal: 50 * 1024 * 1024 } as const;

const EXT_KIND: Record<string, FileKind> = {
  txt: "text", text: "text", md: "text", markdown: "text", log: "text", rst: "text",
  js: "code", mjs: "code", cjs: "code", ts: "code", tsx: "code", jsx: "code", py: "code", java: "code",
  c: "code", h: "code", cc: "code", cpp: "code", go: "code", rs: "code", html: "code", css: "code", xml: "code",
  yaml: "code", yml: "code", toml: "code", sql: "code", csv: "csv", json: "json", pdf: "pdf",
  docx: "docx", xlsx: "xlsx", pptx: "pptx",
};
const LEGACY = new Set(["doc", "xls", "ppt"]);
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export function classifyFile(file: Pick<File, "name" | "type" | "size">):
  | { kind: "image" | FileKind }
  | { error: string } {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (LEGACY.has(extension)) return { error: "旧版 .doc/.xls/.ppt 不受支持；请另存为 .docx/.xlsx/.pptx" };
  if (IMAGE_MIME.has(file.type)) return { kind: "image" };
  if (["png", "jpg", "jpeg", "webp"].includes(extension)) return { error: "图片类型无法确认；请选择 PNG/JPEG/WebP" };
  const kind = EXT_KIND[extension];
  return kind ? { kind } : { error: "不支持该格式；压缩包与可执行文件不能上传" };
}

export function validateSelection(current: readonly UnsentAttachment[], file: Pick<File, "name" | "type" | "size">):
  | { kind: "image" | FileKind }
  | { ignored: true }
  | { error: string } {
  const classification = classifyFile(file);
  if ("error" in classification) return classification;
  const image = classification.kind === "image";
  const existing = current.filter((item) => (item.kind === "image") === image);
  const limit = image ? IMAGE_LIMITS : FILE_LIMITS;
  // All retained images reserve a slot, including processing and failed reads.
  // Ignore excess images before size checks or any draft/read/preview work.
  if (existing.length >= limit.maxCount) return image ? { ignored: true } : { error: "每条消息最多 5 个文件" };
  if (file.size > limit.maxEach) return { error: image ? "单张图片不能超过 4 MiB" : "单个文件不能超过 20 MiB" };
  if (existing.reduce((total, item) => total + item.size, 0) + file.size > limit.maxTotal) {
    return { error: image ? "图片总量不能超过 6 MiB" : "文件总量不能超过 50 MiB" };
  }
  return classification;
}
