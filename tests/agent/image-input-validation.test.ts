import { describe, it, expect } from "vitest";
import {
  EXPORT_IMAGE_BUDGET,
  IMAGE_INPUT_LIMITS,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  createExportImageProjectionState,
  decodeCanonicalBase64,
  normalizeImageInputs,
  parseImageHeader,
  projectExportImagesForMessage,
} from "../../src/agent/image-input.js";
import {
  GIF_2X2_BASE64,
  JPEG_2X2_BASE64,
  JPEG_TRAILING_GIF_BASE64,
  PNG_2X2_BASE64,
  PNG_ANIMATED_BASE64,
  PNG_DIM_100000X10_BASE64,
  PNG_PIXELS_8000X8000_BASE64,
  PNG_TRAILING_HTML_BASE64,
  PNG_TRUNCATED_BASE64,
  SVG_PRETENDING_PNG_BASE64,
  SVG_TEXT,
  WEBP_2X2_BASE64,
  WEBP_RIFF_SIZE_MISMATCH_BASE64,
} from "../helpers/image-fixtures.js";

// P7a：宿主图片输入规范化/验证（HTTP body schema 通过后、进入 session service/runtime 前）。
// 业务验证是权威；schema 只是预检。任何失败都是固定原因，绝不回显 base64/内容。

const img = (mediaType: string, base64: string) => ({ mediaType, base64 });

describe("image-input：合法最小 fixture", () => {
  it("接受 image/png、image/jpeg、image/webp 的真实最小图片且 base64 逐字节保留", () => {
    const result = normalizeImageInputs([
      img("image/png", PNG_2X2_BASE64),
      img("image/jpeg", JPEG_2X2_BASE64),
      img("image/webp", WEBP_2X2_BASE64),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toEqual([
      { mediaType: "image/png", base64: PNG_2X2_BASE64 },
      { mediaType: "image/jpeg", base64: JPEG_2X2_BASE64 },
      { mediaType: "image/webp", base64: WEBP_2X2_BASE64 },
    ]);
    // 不重新编码：字符串完全一致
    expect(result.images[0]!.base64).toBe(PNG_2X2_BASE64);
  });

  it("无 images（undefined/null）等价于空结果，无图消息不受影响", () => {
    expect(normalizeImageInputs(undefined)).toEqual({ ok: true, images: [] });
    expect(normalizeImageInputs(null)).toEqual({ ok: true, images: [] });
    expect(normalizeImageInputs([])).toEqual({ ok: true, images: [] });
  });

  it("导出的受支持类型常量与解析出的真实类型一致", () => {
    expect([...SUPPORTED_IMAGE_MEDIA_TYPES]).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(parseImageHeader(Buffer.from(PNG_2X2_BASE64, "base64"))).toMatchObject({ mediaType: "image/png", width: 2, height: 2 });
    expect(parseImageHeader(Buffer.from(JPEG_2X2_BASE64, "base64"))).toMatchObject({ mediaType: "image/jpeg", width: 2, height: 2 });
    expect(parseImageHeader(Buffer.from(WEBP_2X2_BASE64, "base64"))).toMatchObject({ mediaType: "image/webp", width: 2, height: 2 });
  });
});

describe("image-input：MIME 与结构", () => {
  it("声明 MIME 与真实魔数不符 → mime-mismatch", () => {
    expect(normalizeImageInputs([img("image/png", JPEG_2X2_BASE64)])).toEqual({ ok: false, reason: "mime-mismatch" });
    expect(normalizeImageInputs([img("image/webp", PNG_2X2_BASE64)])).toEqual({ ok: false, reason: "mime-mismatch" });
  });

  it("不支持的 mediaType（image/gif、别名、空）→ unsupported-media-type", () => {
    expect(normalizeImageInputs([img("image/gif", GIF_2X2_BASE64)])).toEqual({ ok: false, reason: "unsupported-media-type" });
    expect(normalizeImageInputs([img("image/jpg", JPEG_2X2_BASE64)])).toEqual({ ok: false, reason: "unsupported-media-type" });
    expect(normalizeImageInputs([img("", PNG_2X2_BASE64)])).toEqual({ ok: false, reason: "unsupported-media-type" });
  });

  it("条目形状非法（缺字段/类型不符/多余键）→ invalid-entry-shape", () => {
    expect(normalizeImageInputs([{ mediaType: "image/png" }])).toEqual({ ok: false, reason: "invalid-entry-shape" });
    expect(normalizeImageInputs([img("image/png", 5 as unknown as string)])).toEqual({ ok: false, reason: "invalid-entry-shape" });
    expect(normalizeImageInputs([{ ...img("image/png", PNG_2X2_BASE64), extra: "x" }])).toEqual({ ok: false, reason: "invalid-entry-shape" });
    expect(normalizeImageInputs(["x"])).toEqual({ ok: false, reason: "invalid-entry-shape" });
  });

  it("images 不是数组 → not-an-array", () => {
    expect(normalizeImageInputs("x")).toEqual({ ok: false, reason: "not-an-array" });
    expect(normalizeImageInputs(42)).toEqual({ ok: false, reason: "not-an-array" });
  });
});

describe("image-input：base64 canonical 校验", () => {
  it("拒绝非 canonical base64（长度/字符/填充/空白）", () => {
    for (const bad of ["not base64!!!", "aGVsbG8", "aGVsbG8===", "aGVs bG8=", "aGVsbG8-", "====", "YQ=", "AB=C", "aGVsbG8=\n"]) {
      expect(decodeCanonicalBase64(bad), bad).toBeNull();
      expect(normalizeImageInputs([img("image/png", bad)])).toEqual({ ok: false, reason: "invalid-base64" });
    }
  });

  it("0 字节 / 空串 → empty-data", () => {
    expect(normalizeImageInputs([img("image/png", "")])).toEqual({ ok: false, reason: "empty-data" });
  });

  it("canonical 但非图片内容 → unrecognized-image（不误判为合法图片）", () => {
    expect(normalizeImageInputs([img("image/png", "aGVsbG8=")])).toEqual({ ok: false, reason: "unrecognized-image" });
  });
});

describe("image-input：数量 / 单图 / 总量 / 像素预算", () => {
  it("超过数量上限 → too-many-images", () => {
    const many = Array.from({ length: IMAGE_INPUT_LIMITS.maxImages + 1 }, () => img("image/png", PNG_2X2_BASE64));
    expect(normalizeImageInputs(many)).toEqual({ ok: false, reason: "too-many-images" });
    // 恰好上限则通过
    expect(normalizeImageInputs(many.slice(0, IMAGE_INPUT_LIMITS.maxImages)).ok).toBe(true);
  });

  it("单图 base64 超过长度上限 → image-too-large（预算在解码前先拦住）", () => {
    const oversized = "A".repeat(IMAGE_INPUT_LIMITS.maxImageBase64Length + 4);
    expect(normalizeImageInputs([img("image/png", oversized)])).toEqual({ ok: false, reason: "image-too-large" });
  });

  it("单图解码字节超上限 → image-too-large", () => {
    // canonical base64 长度合法但解码字节超过单图上限（长度与字节预算互为兜底）
    const bytes = Buffer.alloc(IMAGE_INPUT_LIMITS.maxImageDecodedBytes + 3, 0x41);
    const base64 = bytes.toString("base64");
    expect(normalizeImageInputs([img("image/png", base64)])).toEqual({ ok: false, reason: "image-too-large" });
  });

  it("总量超上限 → images-too-large", () => {
    // 两张各自合法（接近单图上限）的结构完整 PNG，合计超过总量上限
    const single = buildPngWithIdatBytes(IMAGE_INPUT_LIMITS.maxImageDecodedBytes - 64);
    expect(single.length).toBeLessThanOrEqual(IMAGE_INPUT_LIMITS.maxImageDecodedBytes);
    const base64 = single.toString("base64");
    expect(normalizeImageInputs([img("image/png", base64)])).toMatchObject({ ok: true });
    expect(normalizeImageInputs([img("image/png", base64), img("image/png", base64)])).toEqual({
      ok: false,
      reason: "images-too-large",
    });
  });

  it("单边超上限 / 总像素超上限 → image-dimensions", () => {
    expect(normalizeImageInputs([img("image/png", PNG_DIM_100000X10_BASE64)])).toEqual({ ok: false, reason: "image-dimensions" });
    expect(normalizeImageInputs([img("image/png", PNG_PIXELS_8000X8000_BASE64)])).toEqual({ ok: false, reason: "image-dimensions" });
  });
});

describe("image-input：欺骗与完整性问题", () => {
  it("SVG/HTML 文本伪装（声明 image/png）→ non-raster-image", () => {
    expect(normalizeImageInputs([img("image/png", SVG_PRETENDING_PNG_BASE64)])).toEqual({ ok: false, reason: "non-raster-image" });
    // 带 BOM 与前后空白的 XML/HTML 同样拒绝
    const html = `\ufeff  \n<html><body>x</body></html>`;
    expect(normalizeImageInputs([img("image/png", Buffer.from(html).toString("base64"))])).toEqual({ ok: false, reason: "non-raster-image" });
    expect(SVG_TEXT.startsWith("<")).toBe(true);
  });

  it("截断图片 → truncated-image", () => {
    expect(normalizeImageInputs([img("image/png", PNG_TRUNCATED_BASE64)])).toEqual({ ok: false, reason: "truncated-image" });
  });

  it("尾部 polyglot（IEND 后/JPEG EOI 后有额外内容）→ polyglot-image", () => {
    expect(normalizeImageInputs([img("image/png", PNG_TRAILING_HTML_BASE64)])).toEqual({ ok: false, reason: "polyglot-image" });
    expect(normalizeImageInputs([img("image/jpeg", JPEG_TRAILING_GIF_BASE64)])).toEqual({ ok: false, reason: "polyglot-image" });
    expect(normalizeImageInputs([img("image/webp", WEBP_RIFF_SIZE_MISMATCH_BASE64)])).toEqual({ ok: false, reason: "polyglot-image" });
  });

  it("动画 PNG/WebP 拒绝（与 SDK isAnimatedPng 拒绝姿态一致）", () => {
    expect(normalizeImageInputs([img("image/png", PNG_ANIMATED_BASE64)])).toEqual({ ok: false, reason: "unrecognized-image" });
  });
});

describe("image-input：导出投影（EXPECT 预算 / fail-closed）", () => {
  it("把 SDK 图片块 {type,data,mimeType} 投影为 {mediaType,base64} 并逐字节一致", () => {
    const state = createExportImageProjectionState();
    const images = projectExportImagesForMessage(
      [{ type: "text", text: "看图" }, { type: "image", data: PNG_2X2_BASE64, mimeType: "image/png" }],
      state,
    );
    expect(images).toEqual([{ mediaType: "image/png", base64: PNG_2X2_BASE64 }]);
    expect(images[0]!.base64).toBe(PNG_2X2_BASE64);
  });

  it("畸形/未验证图片块被静默省略（fail-closed），其余合法块保留", () => {
    const state = createExportImageProjectionState();
    const images = projectExportImagesForMessage(
      [
        { type: "image", data: SVG_PRETENDING_PNG_BASE64, mimeType: "image/png" }, // MIME 伪装
        { type: "image", data: PNG_TRUNCATED_BASE64, mimeType: "image/png" }, // 截断
        { type: "image", data: PNG_2X2_BASE64, mimeType: "image/png" }, // 合法
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" }, // 非图片
        { type: "image", data: PNG_2X2_BASE64 }, // 缺 mimeType
        { type: "image", mimeType: "image/png" }, // 缺 data
        { type: "image", data: PNG_2X2_BASE64, mimeType: "image/gif" }, // 不支持类型
        { type: "text", text: "忽略" },
        "not-an-object",
      ],
      state,
    );
    expect(images).toEqual([{ mediaType: "image/png", base64: PNG_2X2_BASE64 }]);
  });

  it("历史上 source.base64 形态不被猜测兼容（严格只认 SDK 实际持久化结构）", () => {
    const state = createExportImageProjectionState();
    const images = projectExportImagesForMessage(
      [{ type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_2X2_BASE64 } }],
      state,
    );
    expect(images).toEqual([]);
  });

  it("单条消息图片数与整次导出总量超预算时省略，避免巨型响应", () => {
    const state = createExportImageProjectionState();
    const tooMany = Array.from({ length: EXPORT_IMAGE_BUDGET.maxImagesPerMessage + 1 }, () => ({
      type: "image",
      data: PNG_2X2_BASE64,
      mimeType: "image/png",
    }));
    expect(projectExportImagesForMessage(tooMany, state)).toHaveLength(EXPORT_IMAGE_BUDGET.maxImagesPerMessage);

    // 总量预算：两张接近单图上限的结构完整 PNG，第二张会被整次导出总量拦下
    const single = buildPngWithIdatBytes(IMAGE_INPUT_LIMITS.maxImageDecodedBytes - 64).toString("base64");
    const bigState = createExportImageProjectionState();
    const blocks = [
      { type: "image", data: single, mimeType: "image/png" },
      { type: "image", data: single, mimeType: "image/png" },
    ];
    const projected = projectExportImagesForMessage(blocks, bigState);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.base64).toBe(single);
    expect(bigState.totalBase64Length).toBe(single.length);
  });
});

/**
 * 构造结构完整的 PNG（signature + IHDR 2×2 + 一个大 IDAT + IEND），使总解码长度约为 idatBytes + 头部开销。
 * 只用于预算路径测试：解析器只校验 chunk 边界与 IHDR，不解压 IDAT（真实解码/像素校验由上游模型完成）。
 */
function buildPngWithIdatBytes(idatBytes: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk("IHDR", Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x08, 0x02, 0x00, 0x00, 0x00]));
  const idat = pngChunk("IDAT", Buffer.alloc(idatBytes, 0x78));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** PNG chunk：长度(4 BE) + 类型(4) + 数据 + CRC(4)。CRC 不参与宿主验证，这里填 0。 */
function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  return Buffer.concat([header, Buffer.from(type, "ascii"), data, crc]);
}
