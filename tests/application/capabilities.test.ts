import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../../src/application/capabilities/registry.js";
import { composeCapabilities } from "../../src/application/capabilities/compose.js";
import { collectPromptFragmentSources } from "../../src/application/capabilities/prompt-composer.js";
import type { CapabilityManifest } from "../../src/application/capabilities/manifest.js";

const knowledgeQa: CapabilityManifest = {
  id: "knowledge-qa",
  version: 1,
  name: "知识库问答",
  tools: [
    { name: "search_knowledge", category: "read", scope: "repo", outputLimitBytes: 8192 },
    { name: "read_knowledge_file", category: "read", scope: "repo", outputLimitBytes: 16384 },
  ],
  promptFragments: [{ inline: "回答须给出仓库相对路径与行号证据。" }],
};

const dingtalkSync: CapabilityManifest = {
  id: "dingtalk-sync",
  version: 2,
  tools: [
    { name: "search_knowledge", category: "read", scope: "repo", outputLimitBytes: 8192 },
    { name: "sync_dingtalk_doc", category: "write", scope: "docs/dingtalk" },
  ],
};

describe("能力 manifest 组合（阶段 4）", () => {
  it("新增能力只需注册 manifest，工具清单为已启用能力并集去重", () => {
    const registry = new CapabilityRegistry();
    registry.register(knowledgeQa);
    registry.register(dingtalkSync);

    const snapshot = registry.snapshot();
    expect(snapshot.toolNames).toEqual(["search_knowledge", "read_knowledge_file", "sync_dingtalk_doc"]);
    expect(snapshot.versions).toEqual({ "knowledge-qa": 1, "dingtalk-sync": 2 });
  });

  it("未注册能力的工具不可达", () => {
    const registry = new CapabilityRegistry();
    registry.register(knowledgeQa);

    expect(registry.snapshot().toolNames).not.toContain("sync_dingtalk_doc");
    expect(registry.get("dingtalk-sync")).toBeUndefined();
  });

  it("重复能力 id 拒绝注册", () => {
    const registry = new CapabilityRegistry();
    registry.register(knowledgeQa);
    expect(() => registry.register({ ...knowledgeQa, version: 2 })).toThrow(/能力已注册/);
  });

  it("composeCapabilities 拒绝重复 id 与工具名冲突", () => {
    expect(() => composeCapabilities([knowledgeQa, knowledgeQa])).toThrow(/能力重复声明/);

    const conflicting: CapabilityManifest = {
      id: "other",
      version: 1,
      tools: [
        { name: "search_knowledge", category: "write", scope: "elsewhere" },
      ],
    };
    expect(() => composeCapabilities([knowledgeQa, conflicting])).toThrow(/工具名冲突: search_knowledge/);
  });

  it("提示词片段按已启用能力收集", () => {
    const snapshot = composeCapabilities([knowledgeQa, dingtalkSync]);
    expect(snapshot.promptFragments).toEqual([
      { inline: "回答须给出仓库相对路径与行号证据。" },
    ]);
  });

  it("提示词片段映射为 appendSystemPrompt 条目（inline 文本 / file 路径，过滤空片段）", () => {
    expect(
      collectPromptFragmentSources([
        { inline: "片段 A" },
        { file: "resources/prompt.md" },
        { inline: "  " },
      ]),
    ).toEqual(["片段 A", "resources/prompt.md"]);
  });
});
