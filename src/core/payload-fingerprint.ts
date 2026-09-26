// 幂等请求载荷指纹：同一 (sessionId, requestId) 在不同载荷下复用时，用于识别「同 requestId
// 不同 payload」的冲突，避免静默返回旧结果。
//
// 背景（needs.md §4.2）：requestId 由客户端生成，仅当作幂等键。当前幂等记录只保存终态结果，
// 不保存载荷。历史上同一个 requestId 用不同 prompt/图片重放会命中 done 并原样返回旧结果，
// 客户端会误以为新输入已被处理。
//
// 边界（诚实的保证范围）：
// - 进程内可完整识别：本轮运行期内存幂等表同时保存载荷指纹，命中 done/processing 时比对。
// - 跨重启**无法**识别：持久化表 `idempotency(result TEXT)` 不含指纹；新增列属于 schema 变更
//   （canonical baseline 不可变 + 备份/恢复 golden checksum），本任务不做，见
//   README.zh-CN.md §公共 API 契约 v1。因此跨重启的同 requestId 重放仍返回旧结果，
//   此为已知且明确记录的限制，不伪装成已修复。

import { createHash } from "node:crypto";
import type { ImageInput } from "../agent/agent-adapter.js";

/** 计算一次提交的载荷指纹（不含 requestId：它就是被复用的那个键本身）。 */
export function payloadFingerprint(input: {
  prompt: string;
  parentId?: string;
  images?: readonly ImageInput[];
}): string {
  const images = input.images?.map((image) => ({ mediaType: image.mediaType, base64: image.base64 })) ?? [];
  const hash = createHash("sha256");
  // 分字段喂入并带长度前缀，避免字段拼接歧义（如 prompt="a",parent="bc" vs "ab","c"）。
  hash.update(`${Buffer.byteLength(input.prompt, "utf8")}:`);
  hash.update(input.prompt, "utf8");
  hash.update("|parent:");
  hash.update(input.parentId === undefined ? "-" : input.parentId, "utf8");
  hash.update(`|images:${images.length}`);
  for (const image of images) {
    hash.update(`|${image.mediaType}:`);
    hash.update(image.base64, "utf8");
  }
  return hash.digest("hex");
}
