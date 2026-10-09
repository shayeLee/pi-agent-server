// 幂等请求载荷指纹：同一 (sessionId, requestId) 在不同载荷下复用时，用于识别「同 requestId
// 不同 payload」的冲突，避免静默返回旧结果。
//
// 背景（needs.md §4.2）：requestId 由客户端生成，仅当作幂等键。当前幂等记录只保存终态结果，
// 不保存载荷。历史上同一个 requestId 用不同 prompt/图片重放会命中 done 并原样返回旧结果，
// 客户端会误以为新输入已被处理。
//
// 边界（诚实的保证范围）：
// - 进程内可完整识别：本轮运行期内存幂等表同时保存载荷指纹，命中 done/processing 时比对。
// - 新迁移的 fingerprint 列用于已结算请求跨重启校验；旧记录没有指纹，
//   带 fileIds 的请求必须拒绝与这种旧记录重放。运行中崩溃窗口不承诺 exactly-once。

import { createHash } from "node:crypto";
import type { ImageInput } from "../agent/agent-adapter.js";

/** 计算一次提交的载荷指纹（不含 requestId：它就是被复用的那个键本身）。 */
export function payloadFingerprint(input: {
  prompt: string;
  parentId?: string;
  images?: readonly ImageInput[];
  fileIds?: readonly string[];
  /** Host-only native shared-session actor binding; preserves legacy private fingerprints. */
  idempotencyActor?: string;
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
  // Preserve legacy fingerprints for messages without files. File identity and order are
  // part of the submitted payload; repeated IDs are rejected at the HTTP boundary.
  if (input.fileIds?.length) {
    hash.update(`|fileIds:${input.fileIds.length}`);
    for (const id of input.fileIds) {
      hash.update(`|${Buffer.byteLength(id, "utf8")}:`);
      hash.update(id, "utf8");
    }
  }
  if (input.idempotencyActor !== undefined) {
    hash.update(`|actor:${Buffer.byteLength(input.idempotencyActor, "utf8")}:`);
    hash.update(input.idempotencyActor, "utf8");
  }
  const digest = hash.digest("hex");
  // File-bearing submissions remain de-duplicable for the life of their retained originals;
  // the storage prune operation preserves fingerprints with this explicit marker.
  return input.fileIds?.length ? `file-${digest}` : digest;
}
