// 图片输入测试 fixture：真实最小栅格图片（PNG/JPEG/WebP）与可可靠判断的畸形样本。
// 全部由标准编码器/手工构造生成，逐字节固定，测试不依赖网络与本地图像工具。

/** 2×2 RGB PNG（手工构造，zlib 压缩 IDAT，含 IHDR/IDAT/IEND）。 */
export const PNG_2X2_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mP4z8AARAwQCgAf7gP9Y167WwAAAABJRU5ErkJggg==";

/** 2×2 JPEG（基线、非渐进、标准霍夫曼表）。 */
export const JPEG_2X2_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCOALiMf//Z";

/** 2×2 无损 WebP（VP8L）。 */
export const WEBP_2X2_BASE64 = "UklGRhYAAABXRUJQVlA4TAoAAAAvAUAAAOh/RP8D";

/** 2×2 三字节 PNG signature + v3 header（用于构造截断样本的前缀）。 */
export const PNG_TRUNCATED_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mP4z8AARAwQCgAf7gP9Y167Ww==";

/** PNG 尾部追加 HTML（可可靠判断的 polyglot）。 */
export const PNG_TRAILING_HTML_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mP4z8AARAwQCgAf7gP9Y167WwAAAABJRU5ErkJggjxodG1sPjxib2R5Png8L2JvZHk+PC9odG1sPg==";

/** JPEG 尾部追加 GIF89a（polyglot 探针）。 */
export const JPEG_TRAILING_GIF_BASE64 = `${JPEG_2X2_BASE64}R0lGODlh`;

/** 动画 PNG（acTL 块）——宿主拒绝（与 SDK isAnimatedPng 拒绝姿态一致）。 */
export const PNG_ANIMATED_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACGFjVEwAAAACAAAAAPONk3AAAAAQSURBVHjaY/jPwABEDBAKAB/uA/1jXrtbAAAAAElFTkSuQmCC";

/** RIFF 长度字段与实际不符的 WebP。 */
export const WEBP_RIFF_SIZE_MISMATCH_BASE64 = "UklGRhYAAABXRUJQVlA4TAoAAAAvAUAAAOh/RP8DWA==";

/** 2×2 GIF（宿主不支持）。 */
export const GIF_2X2_BASE64 = "R0lGODdhAgACAIAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7";

/** SVG 文本（伪装成 data URL 的 common 攻击面）。 */
export const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>';

/** SVG 文本的 base64（声明为 image/png 的伪装样本）。 */
export const SVG_PRETENDING_PNG_BASE64 =
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyIiBoZWlnaHQ9IjIiPjwvc3ZnPg==";

/** 声明 100000×10 的 PNG（单边超上限）。 */
export const PNG_DIM_100000X10_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgABhqAAAAAKCAIAAAC423FBAAAADUlEQVR42mP4z8AARAAI/gH/GcBr5wAAAABJRU5ErkJggg==";

/** 声明 8000×8000 的 PNG（单边 8192 内，但总像素近 6400 万，超总像素上限）。 */
export const PNG_PIXELS_8000X8000_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAH0AAAB9ACAIAAACJkzqjAAAADUlEQVR42mP4z8AARAAI/gH/GcBr5wAAAABJRU5ErkJggg==";

/** 受支持图片的最小集合，便于「合法提交」类测试复用。 */
export const VALID_IMAGES = [
  { mediaType: "image/png", base64: PNG_2X2_BASE64 },
  { mediaType: "image/jpeg", base64: JPEG_2X2_BASE64 },
  { mediaType: "image/webp", base64: WEBP_2X2_BASE64 },
] as const;
