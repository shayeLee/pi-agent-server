import { memo, useEffect, useRef, useState } from "react";
import { ToolStatusIcon } from "./ToolStatusIcon.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";
import type { ToolCall } from "pi-agent-server/client";
import { CodeBlock } from "./CodeBlock.js";
import { formatToolDuration } from "../tools/duration.js";
import { rawToolData } from "../tools/raw.js";
import { toolPresentation } from "../tools/presentation.js";
// Existing callers/tests may keep these imports during migration.
export { rawToolData, stringify } from "../tools/raw.js";

/**
 * 一次工具调用的流式卡片。
 * tool_start → 创建（done=false，展示 args）；tool_update → 流式 partialResult；
 * tool_end → 展示 result 并标记完成（done=true）。
 */
export const ToolCallCard = memo(function ToolCallCard({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(!call.done);
  const userToggled = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rawModalOpen, setRawModalOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const menuRoot = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuOpen]);
  function closeMenu() {
    setMenuOpen(false);
    moreButton.current?.focus();
  }
  function viewRaw() {
    closeMenu();
    setRawModalOpen(true);
  }
  async function copyRaw() {
    setCopyStatus("");
    try {
      await navigator.clipboard.writeText(rawToolData(call));
      setCopyStatus("已复制原始数据");
    } catch {
      setCopyStatus("复制失败，请查看原始数据并选择原文复制");
    }
  }
  useEffect(() => {
    if (!userToggled.current) setExpanded(!call.done);
  }, [call.done]);
  const duration = call.done ? formatToolDuration(call.durationMs) : null;
  const durationTitle = `工具调用耗时：${call.durationMs} ms${call.toolName === "subagent_wait" ? "（本次 wait 调用，非子 agent 运行时长）" : ""}`;
  const status = call.done ? (call.isError ? "失败" : "已完成") : "进行中";
  const { header, Arguments, Result } = toolPresentation(call);
  const { summary, badge, priorityLabels, preview, target, outcome } = header;

  return (
    <div
      className={`tool-call ${call.done ? "tool-done" : "tool-running"} ${call.isError ? "tool-error" : ""}`}
      data-testid="tool-call-card"
      data-tool-call-id={call.toolCallId}
      data-done={String(call.done)}
    >
      <div className="tool-call-heading">
      <button
        type="button"
        className={`tool-call-header chevron-trigger${badge ? " tool-parallel-header" : ""}`}
        onClick={() => {
          userToggled.current = true;
          setExpanded((v) => !v);
        }}
        aria-expanded={expanded}
        aria-label={`工具调用 ${call.toolName}，状态：${status}`}
      >
        <ToolStatusIcon done={call.done} isError={call.isError} />
        <span className="tool-name" data-testid="tool-name" title={call.toolName}>
          {call.toolName}
        </span>
        {badge && <span className="tool-parallel-count">{badge}</span>}
        {(target || summary) && <span className={`tool-summary-preview${priorityLabels ? "" : " tool-target"}`} title={summary || target}>{priorityLabels
          ? <><span className="tool-parallel-names">{priorityLabels.join("、")}</span><span className="tool-parallel-preview">{preview}</span></>
          : <span>{target || summary}</span>}</span>}
        {outcome && <span className={`tool-result-badge${call.isError ? " is-error" : ""}`} title={outcome}>{outcome}</span>}
        <span className="tool-header-icons">
          {duration !== null && <span className="tool-duration" title={durationTitle} aria-label={durationTitle}>{duration}</span>}
          <Icon name={expanded ? "down" : "chevron"} className="disclosure-chevron tool-toggle" />
        </span>
      </button>
      </div>
      <div role="status" className="tool-raw-copy-status">{copyStatus}</div>
      {expanded && (
        <div className="tool-call-body">
          <Arguments value={call.args} args={call.args} />
          {call.done ? (
            <Result label="结果" value={call.result} args={call.args} onViewRaw={viewRaw} />
          ) : call.partialResult !== undefined ? (
            <Result label="部分结果" value={call.partialResult} args={call.args} onViewRaw={viewRaw} />
          ) : null}
        </div>
      )}
      <div className={`tool-more${expanded || menuOpen ? "" : " sr-only"}`} ref={menuRoot} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false);
      }}>
        <button type="button" className="tool-more-trigger" ref={moreButton} aria-label="工具更多操作" aria-haspopup="menu" aria-expanded={menuOpen}
          onClick={() => setMenuOpen(v => !v)} onKeyDown={event => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMenuOpen(true); }
          }}>原始数据</button>
        {menuOpen && <div className="tool-more-menu" role="menu" aria-label="工具更多操作" ref={menu} onKeyDown={event => {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); }
          else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus();
          }
        }}>
          <button type="button" role="menuitem" onClick={viewRaw}>查看原始数据</button>
          <button type="button" role="menuitem" onClick={() => { void copyRaw(); closeMenu(); }}>复制原始数据</button>
        </div>}
      </div>
      <Modal open={rawModalOpen} onClose={() => setRawModalOpen(false)} title={`原始数据 · ${call.toolName}`}>
        {rawModalOpen && <CodeBlock code={rawToolData(call)} language="json" copyLabel="复制原始数据" />}
      </Modal>
    </div>
  );
});
