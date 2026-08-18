// 能力提示词片段 → Pi appendSystemPrompt 条目。
// 只做纯映射，不读文件：file 片段作为路径交给 composition root 侧的 Pi 资源加载器读文件。

import type { PromptFragmentManifest } from "./manifest.js";

/**
 * 收集已启用能力的提示词片段来源：
 * - inline 片段直接作为文本；
 * - file 片段作为文件路径（由 Pi DefaultResourceLoader 的 appendSystemPrompt 读文件）。
 */
export function collectPromptFragmentSources(
  fragments: readonly PromptFragmentManifest[],
): string[] {
  return fragments
    .map((fragment) => fragment.inline ?? fragment.file)
    .filter((source): source is string => source !== undefined && source.trim() !== "");
}
