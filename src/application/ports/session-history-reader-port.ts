// SessionHistoryReaderPort：只读会话历史解析口（WP5D-3 reviewer P1：read-only export）。
//
// 背景：GET /v1/sessions/:id/export 过去经 SessionService.findEntry → registry.getOrCreate
// 把尚无 runtime 的会话实例化（createAdapter 可能触达 Pi SDK 会话创建/写 JSONL/写 DB 的副作用）。
// 导出是纯读操作，不得产生任何 runtime/adapter/DB/piSessionFile 副作用。
//
// 契约（实现者必须满足）：
// - readSessionHistory(piSessionFile) 只读解析 Pi JSONL 会话文件，返回与
//   PiAgentAdapter.exportSession 完全一致的投影（{ role, text }[]，仅 user/assistant，
//   提取 text 块忽略 thinking/toolResult）——实现必须复用 agent/pi-agent-adapter.ts 的
//   projectExportMessages，保证两类导出投影逐字节一致；
// - 绝不创建 agent adapter / agent session，绝不写 DB，绝不写/改 piSessionFile（零写）；
//   实现应验证零写（如读取前后文件指纹比对）并在被破坏时失败；
// - 解析失败抛脱敏错误：消息不含文件路径/内容/内部细节（HTTP 层会以固定响应体呈现）。

export type SessionHistoryReader = {
  /**
   * 只读解析 piSessionFile（Pi JSONL 会话文件）并返回与活会话导出相同的 {role,text}[] 投影。
   * 失败一律抛脱敏错误（不含路径/内容细节）；实现保证零写。
   */
  readSessionHistory(piSessionFile: string): Promise<unknown>;
};