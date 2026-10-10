import type { ToolCall } from "pi-agent-server/client";
import { line, record, resultText } from "./summary-data.js";

const ACTIONS: Record<string, string> = {
  read: "读取文件",
  grep: "搜索代码",
  search: "搜索代码",
  find: "搜索代码",
  rg: "搜索代码",
  edit: "编辑文件",
  write: "写入文件",
  test: "运行测试",
  vitest: "运行测试",
};

const TEST_COMMAND = /\b(vitest|jest|pytest|playwright|cargo test|go test|bun test|(?:pnpm|npm|yarn)(?:\s+\S+)*\s+(?:run\s+)?test)\b/;

/** Visible action title. Unknown tools keep their raw name. */
export function toolActionLabel(call: ToolCall): string {
  if (call.toolName === "bash" || call.toolName === "shell") {
    const command = line(record(call.args).command);
    return TEST_COMMAND.test(command) ? "运行测试" : "运行命令";
  }
  return ACTIONS[call.toolName] ?? call.toolName;
}

export type ToolBadge =
  | { kind: "passed"; text: string }
  | { kind: "diff"; add: number; del: number };

/** Header target. File paths stay as given; search and shell commands are shortened. */
export function formatToolTarget(call: ToolCall): string | null {
  const args = record(call.args);
  if (call.toolName === "grep" || call.toolName === "search" || call.toolName === "find" || call.toolName === "rg") {
    const pattern = line(args.pattern ?? args.query ?? args.q ?? args.regex);
    const path = line(args.path ?? args.paths ?? args.dir ?? args.cwd);
    if (pattern && path) return `${pattern} in ${path}`;
  }
  if ((call.toolName === "bash" || call.toolName === "shell") && typeof args.command === "string") {
    return shortenCommand(args.command);
  }
  return null;
}

/** Drop `volta run` and shorten file-path arguments to their basename. */
export function shortenCommand(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim().replace(/^(?:volta run\s+)+/, "");
  return flat.replace(/(^|\s)(\S*\/\S+\.[A-Za-z0-9]+)(?=\s|$)/g, (_match, lead: string, path: string) => `${lead}${path.split("/").pop()}`);
}

/** A badge is a count or a diff, never a snippet of output. */
export function toolResultBadge(call: ToolCall): ToolBadge | null {
  if (!call.done) return null;
  const output = resultText(call.result);
  const failed = output.match(/(\d+)\s+failed\b/i);
  if (failed && Number(failed[1]) > 0) return null;
  const testsPassed = output.match(/^\s*Tests\b[^\n]*?\b(\d+)\s+passed\b/im);
  if (!call.isError && testsPassed) return { kind: "passed", text: `${testsPassed[1]} passed` };
  if (/^\s*Test Files\b/im.test(output)) return null;
  const passed = output.match(/(\d+)\s+passed\b/i);
  if (!call.isError && passed) return { kind: "passed", text: `${passed[1]} passed` };
  if (call.isError) return null;
  if (call.toolName === "edit") {
    const stats = editStats(call.args);
    if (stats.add || stats.del) return { kind: "diff", ...stats };
  }
  if (call.toolName === "write") {
    const content = record(call.args).content;
    if (typeof content === "string" && content.length > 0) {
      const add = content.replace(/\n$/, "").split("\n").length;
      if (add > 0) return { kind: "diff", add, del: 0 };
    }
  }
  return null;
}

function editStats(args: unknown): { add: number; del: number } {
  const fields = record(args);
  const edits = Array.isArray(fields.edits) ? fields.edits : [fields];
  return edits.reduce<{ add: number; del: number }>((sum, item) => {
    const row = record(item);
    if (typeof row.oldText !== "string" || typeof row.newText !== "string") return sum;
    const next = lineDiff(row.oldText, row.newText);
    return { add: sum.add + next.add, del: sum.del + next.del };
  }, { add: 0, del: 0 });
}

function lineDiff(before: string, after: string): { add: number; del: number } {
  const a = before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  if (a.length * b.length > 40_000) {
    return { add: Math.max(0, b.length - a.length), del: Math.max(0, a.length - b.length) };
  }
  const dp = Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const current = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j]!, dp[j - 1]!);
      prev = current;
    }
  }
  const common = dp[b.length]!;
  return { add: b.length - common, del: a.length - common };
}

const THINKING_RANK = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** off, low, medium, high, … Unknown names follow, in locale order. */
export function sortThinkingLevels(levels: readonly string[]): string[] {
  return [...new Set(levels)].sort((left, right) => {
    const a = THINKING_RANK.indexOf(left.toLowerCase());
    const b = THINKING_RANK.indexOf(right.toLowerCase());
    if (a === -1 && b === -1) return left.localeCompare(right);
    if (a === -1) return 1;
    if (b === -1) return -1;
    return a - b;
  });
}

export function readPreviewIsShort(call: ToolCall): boolean {
  const text = resultText(call.result);
  if (!text.trim()) return false;
  const limit = record(call.args).limit;
  const windowed = typeof limit === "number" && limit > 0 && limit <= 40;
  return windowed || (text.length <= 4000 && text.split("\n").length <= 40);
}

/** Running, failed, and short file reads start open. Long successes stay collapsed. */
export function toolCallStartsOpen(call: ToolCall): boolean {
  if (!call.done || call.isError) return true;
  if (call.toolName === "read") return readPreviewIsShort(call);
  return false;
}
