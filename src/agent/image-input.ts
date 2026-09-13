// 图片输入规范化与验证（P7a，宿主侧唯一权威实现）。
//
// 位置与职责：HTTP body 通过 JSON schema 预检之后、进入 session service / runtime 之前调用。
// schema 只做廉价预检（maxItems / maxLength / mediaType 枚举）；**业务验证以本模块为权威**——
// 真实 base64 canonical 校验、真实魔数与头部尺寸解析、声明 MIME 与内容一致性、体积与像素预算。
//
// 设计约束（docs/external-capability-plugin-plan.md A11 与 P7a）：
// - 参考图片只经 pi-agent-server 既有会话消息通道提交；宿主不新增图片数据库或上传路由。
// - **宿主不压缩、不转码**：不引入 sharp/任何原生图像依赖，也不伪造压缩结果。压缩由客户端
//   （onev UI）在提交前完成；宿主只接受「压缩后的安全结果」并对它重新做完整验证。
// - 接受明确栅格类型：image/png、image/jpeg、image/webp。GIF 拒绝：虽然当前 SDK 的
//   `detectSupportedImageMimeType` 能嗅探 image/gif，但宿主策略只接受静态栅格图；SDK 自身
//   对动态图也是拒绝姿态（`isAnimatedPng` 命中即返回 null），宿主不做比上游更宽的承诺。
// - 拒绝 SVG/XML/HTML 等文本伪装；拒绝截断、魔数不符、MIME 错配、以及能可靠判断的尾部 polyglot。
// - 规范化不重新编码 base64：通过校验的字符串原样保留，逐字节传给 SDK 的 ImageContent.data。

import { Buffer } from "node:buffer";

/**
 * 图片输入上限（唯一权威常量；HTTP JSON schema 的 maxItems/maxLength 由这里派生，只作预检）。
 *
 * 默认 10 MiB bodyLimit 下的取值：单图 4 MiB、总量 6 MiB —— 6 MiB 原始字节经 base64 后
 * 约 8 MiB，为 prompt 与其他字段留出余量；总量上限是业务侧约束，JSON schema 无法表达。
 */
export const IMAGE_INPUT_LIMITS = {
  /** 单次消息最多图片数。 */
  maxImages: 4,
  /** 单图解码后最大字节数（4 MiB）。 */
  maxImageDecodedBytes: 4 * 1024 * 1024,
  /** 单图 base64 字符串最大长度（= 4 * ceil(maxImageDecodedBytes / 3)）。 */
  maxImageBase64Length: 5_592_408,
  /** 单次消息所有图片解码后字节数之和上限（6 MiB）。 */
  maxTotalDecodedBytes: 6 * 1024 * 1024,
  /** 单边最大像素数。 */
  maxDimension: 8192,
  /** 单图最大总像素数（宽 × 高）。 */
  maxPixels: 40_000_000,
} as const;

/** 允许的栅格图片 MIME（严格 canonical，不接受 alias 如 image/jpg）。 */
export const SUPPORTED_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

/** 规范化后的图片：与 HTTP 入参同形状（mediaType + base64），base64 与输入逐字节一致。 */
export type NormalizedImage = { readonly mediaType: SupportedImageMediaType; readonly base64: string };

/**
 * 导出预算：JSONL 导出时对 user 消息图片块的投影上限。
 * 超出预算或结构不符的图片块被静默省略（fail-closed：绝不导出未经校验/超预算的数据），
 * 从而避免畸形 JSONL 造出巨型响应；文本投影行为完全不变。
 */
export const EXPORT_IMAGE_BUDGET = {
  /** 单条消息最多导出的图片数。 */
  maxImagesPerMessage: IMAGE_INPUT_LIMITS.maxImages,
  /** 单图 base64 字符串最大长度。 */
  maxImageBase64Length: IMAGE_INPUT_LIMITS.maxImageBase64Length,
  /** 整次导出所有消息图片 base64 长度之和上限（8 MiB）。 */
  maxTotalBase64Length: 8 * 1024 * 1024,
} as const;

/** 拒绝原因（固定枚举，绝不回显调用方内容）。 */
export type ImageInputRejection =
  | "not-an-array"
  | "invalid-entry-shape"
  | "too-many-images"
  | "unsupported-media-type"
  | "empty-data"
  | "invalid-base64"
  | "image-too-large"
  | "images-too-large"
  | "non-raster-image"
  | "unrecognized-image"
  | "mime-mismatch"
  | "truncated-image"
  | "polyglot-image"
  | "image-dimensions";

export type ImageInputResult =
  | { readonly ok: true; readonly images: readonly NormalizedImage[] }
  | { readonly ok: false; readonly reason: ImageInputRejection };

/** 拒绝原因 → 固定 HTTP 400 文案（不含任何调用方数据）。 */
export const IMAGE_INPUT_REJECTION_MESSAGES: Readonly<Record<ImageInputRejection, string>> = {
  "not-an-array": "images 必须是数组",
  "invalid-entry-shape": "images 项必须只包含 mediaType 与 base64 字符串",
  "too-many-images": `最多支持 ${IMAGE_INPUT_LIMITS.maxImages} 张图片`,
  "unsupported-media-type": "仅支持 image/png、image/jpeg、image/webp",
  "empty-data": "图片内容为空",
  "invalid-base64": "图片不是规范的 base64 数据",
  "image-too-large": "单张图片超过体积上限",
  "images-too-large": "图片总量超过体积上限",
  "non-raster-image": "不支持 SVG/XML/HTML 等非栅格图片",
  "unrecognized-image": "无法识别的图片格式",
  "mime-mismatch": "声明的 mediaType 与图片实际格式不一致",
  "truncated-image": "图片数据不完整或已损坏",
  "polyglot-image": "图片尾部包含额外内容",
  "image-dimensions": "图片尺寸超过上限",
};

type HeaderParse =
  | { readonly ok: true; readonly mediaType: SupportedImageMediaType; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly reason: "non-raster-image" | "unrecognized-image" | "truncated-image" | "polyglot-image" };

/**
 * 规范化并验证一次消息的 images 字段。
 * - `undefined` → 合法空结果（无图消息完全不受影响）；
 * - 任意失败 → 固定原因（调用方映射为 400 固定文案），绝不回显 base64/prompt 内容。
 */
export function normalizeImageInputs(value: unknown): ImageInputResult {
  if (value === undefined || value === null) return { ok: true, images: [] };
  if (!Array.isArray(value)) return { ok: false, reason: "not-an-array" };
  if (value.length > IMAGE_INPUT_LIMITS.maxImages) return { ok: false, reason: "too-many-images" };
  if (value.length === 0) return { ok: true, images: [] };

  const images: NormalizedImage[] = [];
  let totalDecodedBytes = 0;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: "invalid-entry-shape" };
    }
    const record = entry as Record<string, unknown>;
    // 严格结构：只接受 mediaType + base64 两个键（schema 已拦截多余键，这里是权威复核）。
    if (Object.keys(record).some((key) => key !== "mediaType" && key !== "base64")) {
      return { ok: false, reason: "invalid-entry-shape" };
    }
    const { mediaType, base64 } = record;
    if (typeof mediaType !== "string" || typeof base64 !== "string") {
      return { ok: false, reason: "invalid-entry-shape" };
    }
    const validated = validateSingleImage(mediaType, base64);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    totalDecodedBytes += validated.decodedBytes;
    if (totalDecodedBytes > IMAGE_INPUT_LIMITS.maxTotalDecodedBytes) {
      return { ok: false, reason: "images-too-large" };
    }
    // 不重新编码：原始 base64 字符串原样保留，保证逐字节进入 SDK。
    images.push(validated.image);
  }
  return { ok: true, images };
}

/**
 * 校验单张图片（不含「总量」预算，总量由调用方按场景累加）。
 * 只接受严格 canonical 的 mediaType/base64 字符串；返回值中的 `image` 与输入逐字节一致。
 * 供 HTTP 入口与 JSONL 导出投影共用，保证两条路径的判定完全一致。
 */
export function validateSingleImage(
  mediaType: unknown,
  base64: unknown,
): { readonly ok: true; readonly image: NormalizedImage; readonly decodedBytes: number } | { readonly ok: false; readonly reason: ImageInputRejection } {
  if (typeof mediaType !== "string" || typeof base64 !== "string") {
    return { ok: false, reason: "invalid-entry-shape" };
  }
  if (!isSupportedMediaType(mediaType)) return { ok: false, reason: "unsupported-media-type" };
  if (base64.length === 0) return { ok: false, reason: "empty-data" };
  if (base64.length > IMAGE_INPUT_LIMITS.maxImageBase64Length) return { ok: false, reason: "image-too-large" };
  const bytes = decodeCanonicalBase64(base64);
  if (bytes === null) return { ok: false, reason: "invalid-base64" };
  if (bytes.length > IMAGE_INPUT_LIMITS.maxImageDecodedBytes) return { ok: false, reason: "image-too-large" };
  const parsed = parseImageHeader(bytes);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.mediaType !== mediaType) return { ok: false, reason: "mime-mismatch" };
  if (
    parsed.width <= 0 ||
    parsed.height <= 0 ||
    parsed.width > IMAGE_INPUT_LIMITS.maxDimension ||
    parsed.height > IMAGE_INPUT_LIMITS.maxDimension ||
    parsed.width * parsed.height > IMAGE_INPUT_LIMITS.maxPixels
  ) {
    return { ok: false, reason: "image-dimensions" };
  }
  return { ok: true, image: { mediaType, base64 }, decodedBytes: bytes.length };
}

/**
 * JSONL / 活会话导出时跨消息累计的图片预算状态（每次导出新建一个，绝不共享）。
 * 预算超限的图片块只被省略，不报错——导出必须 fail-closed（不泄漏、不抛错、不畸变）。
 */
export type ExportImageProjectionState = { totalBase64Length: number };

/** 新建一次导出的图片预算状态。 */
export function createExportImageProjectionState(): ExportImageProjectionState {
  return { totalBase64Length: 0 };
}

/**
 * 把一条消息的 content blocks 投影为可选图片数组：
 * - 只接受 SDK 实际持久化的图片块结构 `{ type:"image", data, mimeType }`（经当前依赖的类型与
 *   JSONL fixture 核实）；其他结构（包括历史遗留的 `source.base64` 形态）一律忽略，不猜。
 * - 每个块重新走与 HTTP 入口完全相同的 {@link validateSingleImage}；声明 MIME、魔数、体积、
 *   尺寸任一不符即整块丢弃（fail-closed），避免畸形 JSONL 造成巨型/不安全响应。
 * - 张数与总量均受 {@link EXPORT_IMAGE_BUDGET} 限制；超出后不再累计后续图片。
 */
export function projectExportImagesForMessage(
  content: unknown,
  state: ExportImageProjectionState,
): readonly NormalizedImage[] {
  if (!Array.isArray(content)) return [];
  const images: NormalizedImage[] = [];
  for (const block of content) {
    if (images.length >= EXPORT_IMAGE_BUDGET.maxImagesPerMessage) break;
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "image") continue;
    if (typeof record.mimeType !== "string" || typeof record.data !== "string") continue;
    if (record.data.length > EXPORT_IMAGE_BUDGET.maxImageBase64Length) continue;
    if (state.totalBase64Length + record.data.length > EXPORT_IMAGE_BUDGET.maxTotalBase64Length) continue;
    const validated = validateSingleImage(record.mimeType, record.data);
    if (!validated.ok) continue;
    state.totalBase64Length += record.data.length;
    images.push(validated.image);
  }
  return images;
}

/** mediaType 是否为受支持的严格 canonical 类型。 */
export function isSupportedMediaType(value: string): value is SupportedImageMediaType {
  return (SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * 严格 canonical base64 校验（RFC 4648 §4）：长度 4 的倍数、仅标准字母表、仅尾部 padding，
 * 并通过「解码后重新编码等于原串」做权威判定（Node 会静默忽略非法字符，round-trip 才能拦住）。
 */
export function decodeCanonicalBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) return null;
  if (bytes.toString("base64") !== value) return null;
  return bytes;
}

/** 解析真实魔数与头部尺寸；不信任声明 MIME。 */
export function parseImageHeader(bytes: Uint8Array): HeaderParse {
  if (looksLikeTextualMarkup(bytes)) return { ok: false, reason: "non-raster-image" };
  if (startsWith(bytes, PNG_SIGNATURE)) {
    const parsed = parsePng(bytes);
    return parsed.ok
      ? { ok: true, mediaType: "image/png", width: parsed.width, height: parsed.height }
      : parsed;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const parsed = parseJpeg(bytes);
    return parsed.ok
      ? { ok: true, mediaType: "image/jpeg", width: parsed.width, height: parsed.height }
      : parsed;
  }
  if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")) {
    const parsed = parseWebp(bytes);
    return parsed.ok
      ? { ok: true, mediaType: "image/webp", width: parsed.width, height: parsed.height }
      : parsed;
  }
  return { ok: false, reason: "unrecognized-image" };
}

// --- 内部实现 ---

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** PNGOUT 允许的 IHDR 组合：bitDepth × colorType（compression/filter 必须为 0）。 */
const PNG_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

type RasterParse =
  | { readonly ok: true; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly reason: "truncated-image" | "polyglot-image" | "unrecognized-image" };

/** 文本伪装（SVG/XML/HTML 等）：跳过 UTF-8 BOM 与 ASCII 空白后以 '<' 开头。 */
function looksLikeTextualMarkup(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  return i < bytes.length && bytes[i] === 0x3c; // '<'
}

function parsePng(bytes: Uint8Array): RasterParse {
  const length = bytes.length;
  if (length < 8 + 12 + 13 + 4) return { ok: false, reason: "truncated-image" };
  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let width = 0;
  let height = 0;
  while (offset < length) {
    if (offset + 12 > length) return { ok: false, reason: "truncated-image" };
    const chunkLength = readUint32BE(bytes, offset);
    const type = asciiAt(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return { ok: false, reason: "truncated-image" };
    // chunk 数据 + 4 字节 CRC 必须完整落在文件内
    if (chunkLength > length - (offset + 12)) return { ok: false, reason: "truncated-image" };
    if (type === "IHDR") {
      if (sawIhdr || offset !== 8 || chunkLength !== 13) return { ok: false, reason: "truncated-image" };
      width = readUint32BE(bytes, offset + 8);
      height = readUint32BE(bytes, offset + 12);
      const bitDepth = bytes[offset + 16]!;
      const colorType = bytes[offset + 17]!;
      const compression = bytes[offset + 18]!;
      const filter = bytes[offset + 19]!;
      const interlace = bytes[offset + 20]!;
      if (
        compression !== 0 ||
        filter !== 0 ||
        (interlace !== 0 && interlace !== 1) ||
        !(PNG_BIT_DEPTHS[colorType]?.includes(bitDepth) ?? false)
      ) {
        return { ok: false, reason: "truncated-image" };
      }
      sawIhdr = true;
    } else if (type === "acTL") {
      // 动画 PNG：与 SDK `detectSupportedImageMimeType`（isAnimatedPng → null）保持同一拒绝姿态。
      return { ok: false, reason: "unrecognized-image" };
    } else if (type === "IDAT") {
      sawIdat = true;
    } else if (type === "IEND") {
      if (chunkLength !== 0) return { ok: false, reason: "truncated-image" };
      offset += 12;
      // IEND 之后必须恰好是文件结尾：可可靠判断的尾部 polyglot 一律拒绝
      if (offset !== length) return { ok: false, reason: "polyglot-image" };
      if (!sawIhdr || !sawIdat) return { ok: false, reason: "truncated-image" };
      return { ok: true, width, height };
    }
    offset += 12 + chunkLength;
  }
  return { ok: false, reason: "truncated-image" };
}

function parseJpeg(bytes: Uint8Array): RasterParse {
  const length = bytes.length;
  if (length < 4) return { ok: false, reason: "truncated-image" };
  // FFD8 FF F7（JPEG-LS/SOF55）：与 SDK mime 嗅探同样拒绝
  if (bytes[2] === 0xff && bytes[3] === 0xf7) return { ok: false, reason: "unrecognized-image" };
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawSof = false;
  let sawSos = false;
  while (offset < length) {
    if (bytes[offset] !== 0xff) return { ok: false, reason: "truncated-image" };
    while (offset < length && bytes[offset] === 0xff) offset++; // 允许 marker 填充字节
    if (offset >= length) return { ok: false, reason: "truncated-image" };
    const marker = bytes[offset]!;
    offset++;
    if (marker === 0xd9) break; // EOI（无 SOS 的场景）
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // 无负载的独立 marker
    if (offset + 2 > length) return { ok: false, reason: "truncated-image" };
    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > length) return { ok: false, reason: "truncated-image" };
    if (isJpegSofMarker(marker)) {
      if (segmentLength < 7) return { ok: false, reason: "truncated-image" };
      height = readUint16BE(bytes, offset + 3);
      width = readUint16BE(bytes, offset + 5);
      sawSof = true;
    }
    if (marker === 0xda) {
      // SOS：其后是熵编码数据，无法按段长继续解析；只做「最后两字节必须是 EOI」的完整性判定。
      sawSos = true;
      break;
    }
    offset += segmentLength;
  }
  if (!sawSof || !sawSos) return { ok: false, reason: "truncated-image" };
  if (length >= 2 && bytes[length - 2] === 0xff && bytes[length - 1] === 0xd9) {
    return { ok: true, width, height };
  }
  // 尾部还有内容：若更早处存在 EOI 则是 polyglot，否则是截断
  return { ok: false, reason: lastIndexOfEoi(bytes) >= 0 ? "polyglot-image" : "truncated-image" };
}

/** SOF0-SOF15（排除 DHT=0xC4、JPG=0xC8、DAC=0xCC）。 */
function isJpegSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function lastIndexOfEoi(bytes: Uint8Array): number {
  for (let i = bytes.length - 2; i >= 0; i--) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return i;
  }
  return -1;
}

function parseWebp(bytes: Uint8Array): RasterParse {
  const length = bytes.length;
  if (length < 20) return { ok: false, reason: "truncated-image" };
  const riffSize = readUint32LE(bytes, 4);
  if (riffSize > length - 8) return { ok: false, reason: "truncated-image" };
  if (riffSize < length - 8) return { ok: false, reason: "polyglot-image" };
  const fourCc = asciiAt(bytes, 12, 4);
  const chunkSize = readUint32LE(bytes, 16);
  const paddedChunkSize = chunkSize + (chunkSize % 2);
  if (20 + paddedChunkSize > length) return { ok: false, reason: "truncated-image" };
  if (fourCc === "ANIM") return { ok: false, reason: "unrecognized-image" }; // 动画 WebP
  if (fourCc === "VP8 ") {
    if (chunkSize < 10) return { ok: false, reason: "truncated-image" };
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return { ok: false, reason: "truncated-image" };
    }
    return { ok: true, width: readUint16LE(bytes, 26) & 0x3fff, height: readUint16LE(bytes, 28) & 0x3fff };
  }
  if (fourCc === "VP8L") {
    if (chunkSize < 5 || bytes[20] !== 0x2f) return { ok: false, reason: "truncated-image" };
    const b1 = bytes[21]!;
    const b2 = bytes[22]!;
    const b3 = bytes[23]!;
    const b4 = bytes[24]!;
    const width = 1 + (b1 | ((b2 & 0x3f) << 8));
    const height = 1 + (((b2 & 0xc0) >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10));
    return { ok: true, width, height };
  }
  if (fourCc === "VP8X") {
    if (chunkSize < 10) return { ok: false, reason: "truncated-image" };
    const width = 1 + readUint24LE(bytes, 24);
    const height = 1 + readUint24LE(bytes, 27);
    return { ok: true, width, height };
  }
  return { ok: false, reason: "unrecognized-image" };
}

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[i] !== signature[i]) return false;
  return true;
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, size: number): string {
  let result = "";
  for (let i = 0; i < size; i++) result += String.fromCharCode(bytes[offset + i] ?? 0);
  return result;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    (bytes[offset + 3] ?? 0) * 0x1000000
  );
}
