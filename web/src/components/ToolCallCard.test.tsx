import { describe, it, expect, vi } from "vitest";
import { applySseEvent, createChatState } from "pi-agent-server/client";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCallCard, rawToolData } from "./ToolCallCard.js";

function viewRaw() {
  fireEvent.click(screen.getByRole("button", { name: "工具更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "查看原始数据" }));
}
function rawValue(key: string) {
  return JSON.parse(document.querySelector("dialog pre")!.textContent!)[key];
}
import type { ToolCall } from "pi-agent-server/client";

function expand() {
  const header = screen.getByRole("button", { name: /工具调用/ });
  if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
}

function card(partial: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId: "t1",
    toolName: "search",
    args: { q: "x" },
    partialResult: undefined,
    result: undefined,
    isError: false,
    done: false,
    ...partial,
  };
}

describe("ToolCallCard（工具调用流式卡片）", () => {
  it("简单数组紧凑一行，保留参数/进度区域且 raw 使用独立 dialog", () => {
    const args = { runIds: ["1", "2"], timeoutMs: 600000, flags: [0, false, null] };
    const { container } = render(<ToolCallCard call={card({ toolName: "subagent_wait", args, partialResult: "0/2 settled\nworker: reading" })} />);
    const parameters = screen.getByRole("region", { name: "参数" });
    const output = screen.getByRole("region", { name: "部分结果" });
    expect(parameters.querySelector("ol")).toBeNull();
    expect(parameters).toHaveTextContent('["1","2"]');
    expect(parameters).toHaveTextContent('[0,false,null]');
    expect(container.querySelector(".json-label")).toBeNull();
    expect(parameters.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    viewRaw();
    const raw = screen.getByRole("dialog");
    expect(output.compareDocumentPosition(raw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rawValue("args")).toEqual(args);
  });
  it.each([false, true])("未手动选择时流式展开、完成收起（isError=%s），重新展开可读最终原文", (isError) => {
    const base = card({ toolName: "subagent_wait", args: { runIds: ["r1"] } });
    const { rerender } = render(<ToolCallCard call={base} />);
    const header = screen.getByRole("button", { name: /工具调用/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    for (const text of ["0/1 settled after 1s", "0/1 settled after 2s"]) {
      rerender(<ToolCallCard call={{ ...base, partialResult: { content: [{ type: "text", text }] } }} />);
      expect(screen.getByTestId("tool-result-text").textContent).toBe(text);
      expect(header).toHaveAttribute("aria-expanded", "true");
    }
    const result = "Waited 2s: 0/1 finished, 1 still running.\n最终原文";
    const final = { ...base, done: true, result, isError };
    rerender(<ToolCallCard call={final} />);
    expect(screen.getByRole("img", { name: isError ? "失败" : "已完成" })).toBeInTheDocument();
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header.querySelector(".tool-summary-preview")?.textContent).toContain("still running");
    expect(screen.queryByTestId("tool-result-text")).toBeNull();
    rerender(<ToolCallCard call={{ ...final }} />);
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(header);
    rerender(<ToolCallCard call={{ ...final }} />);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("tool-result-text").textContent).toBe(result);
  });
  it("展开与收起保留同一参数和最新快照预览", () => {
    const base = card({ toolName: "bash", args: { command: "printf snapshots" }, partialResult: "first\nlatest" });
    const { rerender } = render(<ToolCallCard call={base} />);
    const header = screen.getByRole("button", { name: /工具调用/ });
    const preview = () => header.querySelector(".tool-summary-preview");
    expect(preview()).toHaveTextContent("printf snapshots · latest");
    const initial = preview();
    fireEvent.click(header);
    expect(preview()).toBe(initial);
    expect(preview()).toHaveTextContent("printf snapshots · latest");
    rerender(<ToolCallCard call={{ ...base, partialResult: "first\nnew snapshot" }} />);
    expect(preview()).toHaveTextContent("printf snapshots · new snapshot");
    fireEvent.click(header);
    expect(preview()).toHaveTextContent("printf snapshots · new snapshot");
    rerender(<ToolCallCard call={{ ...base, done: true, result: "final" }} />);
    expect(preview()).toHaveTextContent("printf snapshots · final");
  });
  it.each([false, true])("恢复历史完成工具初始收起（isError=%s）", (isError) => {
    render(<ToolCallCard call={card({ done: true, isError, result: "历史原文" })} />);
    expect(screen.getByRole("button", { name: /工具调用/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("tool-result-text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    expect(screen.getByTestId("tool-result-text").textContent).toBe("历史原文");
  });
  it.each([false, true])("手动选择 %s 不被 partial/done/error 或重渲染覆盖", (expanded) => {
    const base = card();
    const { rerender } = render(<ToolCallCard call={base} />);
    const header = screen.getByRole("button", { name: /工具调用/ });
    fireEvent.click(header);
    if (expanded) fireEvent.click(header);
    for (const next of [{ partialResult: "first" }, { partialResult: "latest" }, { done: true, result: "final" }, { done: true, isError: true, result: "error" }]) {
      rerender(<ToolCallCard call={{ ...base, ...next }} />);
      expect(header).toHaveAttribute("aria-expanded", String(expanded));
    }
  });
  it("正常 timeline key 更换后不继承手动偏好（即使 toolCallId 复用）", () => {
    const { rerender } = render(<ToolCallCard key="timeline-1" call={card()} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    rerender(<ToolCallCard key="timeline-2" call={card()} />);
    expect(screen.getByRole("button", { name: /工具调用/ })).toHaveAttribute("aria-expanded", "true");
  });
  it.each([
    { done: false, isError: false, state: "running", label: "进行中" },
    { done: false, isError: true, state: "running", label: "进行中" },
    { done: true, isError: false, state: "success", label: "已完成" },
    { done: true, isError: true, state: "error", label: "失败" },
  ])("状态仅由 done/isError 映射：$state，子任务 waiting 不影响工具状态", ({ done, isError, state, label }) => {
    render(<ToolCallCard call={card({ toolName: "subagent_wait", done, isError, result: "child status: waiting" })} />);
    const icon = screen.getByRole("img", { name: label });
    expect(icon).toHaveClass(`tool-status-${state}`);
    expect(icon.querySelector("title")).toHaveTextContent(label);
    expect(screen.getByRole("button", { name: `工具调用 subagent_wait，状态：${label}` })).toHaveAttribute("aria-expanded", String(!done));
    expect(document.querySelector(".tool-status-pending,.tool-status-waiting")).toBeNull();
  });
  it.each([undefined, null, {}, []])("空参数 %j 隐藏整个区域", (args) => {
    render(<ToolCallCard call={card({ args })} />);
    expand();
    expect(screen.queryByRole("region", { name: "参数" })).toBeNull();
    expect(screen.queryByText("参数原始数据")).toBeNull();
    expect(screen.queryByText("无参数")).toBeNull();
  });
  it.each([false, 0, { value: "" }])("非空参数 %j 保留区域及 raw", (args) => {
    render(<ToolCallCard call={card({ args })} />);
    expand();
    expect(screen.getByRole("region", { name: "参数" })).toBeVisible();
    viewRaw();
    expect(rawValue("args")).toEqual(args);
  });
  it("bash 收起预览原命令，快照保留收起且展开完整高亮", () => {
    const command = '  printf "%s\\n" "long command"\n' + "x".repeat(300);
    const { rerender } = render(<ToolCallCard call={card({ toolName: "bash", args: { command } })} />);
    expand();
    const header = screen.getByRole("button", { name: /工具调用/ });
    expect(header.querySelector(".tool-summary-preview")?.textContent).toContain("printf");
    fireEvent.click(header);
    expect(header.querySelector(".tool-summary-preview")?.textContent).toContain("printf");
    rerender(<ToolCallCard call={card({ toolName: "bash", args: { command }, done: true })} />);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("img", { name: "已完成" })).toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.getByRole("region", { name: "参数" }).querySelector('[data-language="bash"] pre')?.textContent).toContain("printf");
  });
  it.each([["a.py", "python"], ["a.ts", "typescript"], ["a.html", "html"], ["a.json", "json"], ["a.txt", "plain"], ["a.unknown", "plain"]])("write %s 保留原文、高亮和复制", async (path, language) => {
    const content = '  print("hello")\n\n  # **not Markdown**\n';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ToolCallCard call={card({ toolName: "write", args: { path, content, nested: { path: "nested.py", content: "untouched" } } })} />);
    expand();
    const region = screen.getByRole("region", { name: "参数" });
    const block = region.querySelector(".code-block")!;
    expect(block).toHaveAttribute("data-language", language);
    expect(block.querySelector("pre")?.textContent).toBe(content);
    expect(region.querySelectorAll(".code-block")).toHaveLength(1); // content; raw lives after output
    expect(region.querySelector(".tool-readable-value")?.textContent).toBe("nested.py");
    expect(region.textContent).not.toContain(path);
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await screen.findByText("已复制");
    expect(writeText).toHaveBeenCalledWith(content);
  });
  it("write 显式语言优先，嵌套 content 不继承顶层语言", () => {
    render(<ToolCallCard call={card({ toolName: "write", args: { path: "a.py", language: "ts", content: "const n = 0;", other: { content: "plain" } } })} />);
    expand();
    expect(screen.getByRole("region", { name: "参数" }).querySelector('.code-block')).toHaveAttribute("data-language", "typescript");
    expect(screen.getByText("plain", { selector: ".tool-readable-value" })).toBeVisible();
  });
  it.each(["single", "batch"])("edit %s supports languages, empty replacements, exact copy and raw", async (schema) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { rerender } = render(<ToolCallCard call={card()} />);
    expand();
    for (const [path, language, oldText, newText] of [
      ["a.py", "python", '  print("old")\n', '  print("new")\n\n'],
      ["a.ts", "typescript", "const n = 0;\n", "const n = 1;\n"],
      ["a.json", "json", '{"x":0}\n', '{"x":false}\n'],
      ["a.unknown", "plain", "<img onerror=alert(1)>\n", "**not markdown**\n"],
      ["a.py", "python", "", "  inserted\n"],
      ["a.ts", "typescript", "  deleted\n", ""],
      ["a.json", "json", "", ""],
    ]) {
      const replacement = { oldText, newText, nested: { oldText: "untouched", newText: "plain" } };
      const args = { path, ...(schema === "single" ? replacement : { edits: [replacement, { oldText: "second\n", newText: "last\n" }] }), flag: false, count: 0 };
      rerender(<ToolCallCard call={card({ toolName: "edit", args })} />);
      const region = screen.getByRole("region", { name: "参数" });
      const blocks = region.querySelectorAll(".diff-block");
      expect(blocks).toHaveLength(schema === "single" ? 1 : 2);
      expect(region.querySelector("details, .code-block")).toBeNull();
      expect(region.querySelector("dt")?.textContent).not.toBe("path");
      expect(blocks[0].textContent).toContain(oldText.trim());
      expect(blocks[0].textContent).toContain(newText.trim());
      expect(language).toBeTruthy();
      expect(region.querySelector("img")).toBeNull();
      expect(screen.getByText("false", { selector: ".tool-readable-value" })).toBeVisible();
      expect(screen.getByText("0", { selector: ".tool-readable-value" })).toBeVisible();
      expect(screen.getByText("untouched", { selector: ".tool-readable-value" })).toBeVisible();
      if (schema === "batch") expect(blocks[1].textContent).toContain("second");
      viewRaw();
      expect(rawValue("args")).toEqual(args);
      fireEvent.click(screen.getByRole("dialog").querySelector(".code-block button")!);
      expect(JSON.parse(writeText.mock.calls.at(-1)![0]).args).toEqual(args);
      await screen.findByText("已复制");
      fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
    }
  });
  it("edit explicit language wins; subagent and nested same-name fields stay ordinary parameters", () => {
    const args = { path: "a.py", language: "ts", oldText: "const a = 0;", newText: "const a = 1;", nested: { edits: [{ oldText: "plain", newText: "plain" }] } };
    const { rerender } = render(<ToolCallCard call={card({ toolName: "edit", args })} />);
    expand();
    expect(screen.getByRole("region", { name: "参数" }).querySelectorAll('.diff-block')).toHaveLength(1);
    expect(screen.getByText("ts", { selector: ".tool-readable-value" })).toBeVisible();
    rerender(<ToolCallCard call={card({ toolName: "subagent", args: { agent: "worker", task: "edit", ...args } })} />);
    expect(screen.getByRole("region", { name: "参数" }).querySelectorAll(".code-block")).toHaveLength(0); // raw lives after output
  });
  it.each(["subagent", "team.subagent"])("%s 默认展示实际单任务和受理结果，不宣称子任务完成", (toolName) => {
    const task = "  完整提示词\n" + "长任务原文".repeat(100);
    render(<ToolCallCard call={card({ toolName, args: { agent: "worker", task, cwd: "/fixture" }, done: true,
      result: { content: [{ type: "text", text: "Background subagent started (runId: run-1, agent: worker)." }], details: { liveRunIds: ["run-1"] } } })} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    expect(screen.getByRole("button", { name: /工具调用.*完成/ })).toHaveAttribute("aria-expanded", "true");
    if (toolName === "subagent") {
      expect(screen.getByText("worker", { selector: ".tool-subagent-agent" })).toBeVisible();
      expect(screen.getByText(task, { normalizer: value => value, selector: ".tool-readable-value" }).textContent).toBe(task);
    } else {
      expect(screen.getByText("agent")).toBeVisible();
      expect(screen.getByText("worker", { selector: ".tool-readable-value" })).toBeVisible();
    }
    expect(screen.getByTestId("tool-result-text")).toHaveTextContent("run-1");
    expect(screen.getByRole("img", { name: "已完成" })).toBeInTheDocument(); // This is the tool's status, not an invented child result.
    const header = screen.getByRole("button", { name: /工具调用/ });
    expect(header.lastElementChild).toHaveClass("tool-header-icons");
    expect(header.lastElementChild?.lastElementChild).toHaveClass("tool-toggle", "disclosure-chevron");
    expect(header.querySelector(".tool-toggle")?.previousElementSibling).toHaveClass("tool-status-icon");
    viewRaw();
    expect(rawValue("args")).toEqual({ agent: "worker", task, cwd: "/fixture" });
  });

  it("并行 tasks 逐项显示真实代理与完整任务，未知字段原值保留", () => {
    const tasks = [{ agent: "scout", task: "第一任务\n原文", cwd: "/one" }, { agent: "worker", task: "第二任务", unknown: { flag: false } }];
    render(<ToolCallCard call={card({ toolName: "subagent", args: { tasks, agentScope: "both" }, done: true })} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    expect(screen.getByText("并行 2")).toBeVisible();
    expect(screen.queryByText("tasks", { selector: "dt" })).not.toBeInTheDocument();
    const items = screen.getByRole("list", { name: "代理任务" }).querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector(".tool-subagent-agent")).toHaveTextContent("scout");
    expect(items[0].textContent).not.toContain("agent");
    expect(items[0].textContent).not.toContain("task");
    expect(items[0].querySelector("pre")?.textContent).toBe(tasks[0].task);
    expect(items[0]).toHaveTextContent("/one");
    expect(items[1].querySelector(".tool-subagent-agent")).toHaveTextContent("worker");
    viewRaw();
    expect(rawValue("args")).toEqual({ tasks, agentScope: "both" });
  });

  it("仅 subagent 对象形式的单任务也用代理名标题，其他工具结构不变", () => {
    const task = { agent: "reviewer", task: "  原文\n第二行", cwd: "/work" };
    const { rerender } = render(<ToolCallCard call={card({ toolName: "subagent", args: task })} />);
    expand();
    expect(screen.getByText("reviewer", { selector: ".tool-subagent-agent" })).toBeVisible();
    expect(screen.getByText(task.task, { selector: ".tool-readable-value", normalizer: value => value }).textContent).toBe(task.task);
    expect(screen.getByText("/work")).toBeVisible();
    rerender(<ToolCallCard call={card({ toolName: "other", args: task })} />);
    expect(screen.queryByText("reviewer", { selector: ".tool-subagent-agent" })).not.toBeInTheDocument();
    expect(screen.getByText("agent")).toBeVisible();
  });

  it("wait 快照更新与成功完成保持默认可读，手动折叠在错误更新后仍保留", () => {
    const base = { toolName: "subagent_wait", args: { runIds: ["r1", "r2"] } };
    const { rerender } = render(<ToolCallCard call={card({ ...base, partialResult: "0/2 settled" })} />);
    // Explicitly reopen while running so the user preference survives completion.
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    rerender(<ToolCallCard call={card({ ...base, partialResult: "1/2 settled" })} />);
    expect(screen.getByTestId("tool-result-text").textContent).toBe("1/2 settled");
    const text = "2/2 background subagent(s) finished.\n\n### [scout] run r1 — completed\n\n结果一\n\n---\n\n### [worker] run r2 — completed\n\n结果二";
    const result = { content: [{ type: "text", text }], details: { results: [{ unknown: [false, 0] }] } };
    rerender(<ToolCallCard call={card({ ...base, done: true, result })} />);
    expect(screen.getByRole("heading", { name: "[scout] run r1 — completed" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "[worker] run r2 — completed" })).toBeInTheDocument();
    expect(screen.getByText("结果一")).toBeInTheDocument();
    expect(screen.getByText("结果二")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Markdown 展示" }));
    expect(screen.getByTestId("tool-result-text").textContent).toBe(text);
    viewRaw();
    expect(rawValue("result")).toEqual(result);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    rerender(<ToolCallCard call={card({ ...base, isError: true, done: true, result: "Wait aborted" })} />);
    expect(screen.getByRole("button", { name: /工具调用/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("tool-result-text")).not.toBeInTheDocument();
  });
  it("bash partial 与 final 输出保持精确纯文本，不提供 Markdown 切换并保留命令高亮", () => {
    const raw = "### literal heading\n- `literal` list\n```bash\necho 'quotes'\n```\n  aligned   spaces\n";
    const { rerender } = render(<ToolCallCard call={card({ toolName: "bash", args: { command: "echo hi" }, partialResult: raw })} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    expect(screen.getByTestId("tool-result-text").querySelector("pre")?.textContent).toBe(raw);
    expect(screen.queryByRole("button", { name: "Markdown 展示" })).not.toBeInTheDocument();
    expect(screen.getByTestId("tool-call-card").querySelector(".code-block pre")?.textContent).toBe("echo hi");
    rerender(<ToolCallCard call={card({ toolName: "bash", args: { command: "echo hi" }, done: true, result: raw })} />);
    expect(screen.getByTestId("tool-result-text").querySelector("pre")?.textContent).toBe(raw);
    expect(screen.queryByRole("button", { name: "Markdown 展示" })).not.toBeInTheDocument();
  });

  it("运行中的工具默认展示参数与部分结果", () => {
    render(<ToolCallCard call={card({ partialResult: "读取中" })} />);
    expand();
    expect(screen.getByTestId("tool-name")).toHaveTextContent("search");
    expect(screen.getByTestId("tool-call-card").dataset.done).toBe("false");
    expect(screen.getByRole("img", { name: "进行中" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "参数" })).toBeVisible();
    expect(screen.getByText("读取中", { selector: ".tool-readable-value" })).toBeInTheDocument();
  });

  it("成功完成的工具默认展示完整名称、参数和结果", () => {
    render(<ToolCallCard call={card({ result: { output: "完整输出" }, done: true })} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    const header = screen.getByRole("button", { name: /工具调用 search.*完成/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("tool-name")).toHaveTextContent("search");
    expect(screen.getByRole("region", { name: "参数" })).toBeVisible();
    expect(screen.getByText("q")).toBeVisible();
    expect(screen.getByText("x")).toBeVisible();
    viewRaw();
    expect(rawValue("result")).toEqual({ output: "完整输出" });
  });

  it("多次真实 tool_update 快照替换而不重复，tool_end 用最终正文替换", () => {
    let state = applySseEvent(createChatState(), { type: "tool_start", toolCallId: "t1", toolName: "search", args: { q: "x" } });
    const current = () => (state.timeline[0] as Extract<typeof state.timeline[number], { kind: "tool" }>).call;
    const { rerender } = render(<ToolCallCard call={current()} />);
    expand();
    expect(screen.queryByTestId("tool-result-text")).not.toBeInTheDocument();
    for (const text of ["第一行\n", "第一行\n第二行\n"]) {
      state = applySseEvent(state, { type: "tool_update", toolCallId: "t1", toolName: "search", partialResult: { content: [{ type: "text", text }] } });
      rerender(<ToolCallCard call={current()} />);
      expect(screen.getByTestId("tool-result-text").textContent).toBe(text);
    }
    // Manual expand wins over automatic completion collapse.
    const header = screen.getByRole("button", { name: /工具调用/ });
    fireEvent.click(header);
    fireEvent.click(header);
    state = applySseEvent(state, { type: "tool_end", toolCallId: "t1", toolName: "search", result: "最终\n原文", isError: false });
    rerender(<ToolCallCard call={current()} />);
    expect(screen.getByTestId("tool-result-text").textContent).toBe("最终\n原文");
    expect(screen.queryByText("第二行")).not.toBeInTheDocument();
  });

  it("标准文本数组顺序完整，非文本、metadata 和未知值可从原始数据复制", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const result = { content: [{ type: "text", text: "  第一块\n" }, { type: "image", data: "<img onerror=alert(1)>", mimeType: "image/png" }, { type: "text", text: "第二块\n末行" }], details: { nested: { unknown: 0 } } };
    render(<ToolCallCard call={card({ isError: true, done: true, result })} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    const blocks = screen.getByTestId("tool-result-text").querySelectorAll("pre");
    expect(Array.from(blocks, block => block.textContent)).toEqual(["  第一块\n", "第二块\n末行"]);
    expect(screen.getByText(/非文本或未知内容/)).toBeVisible();
    expect(screen.getByTestId("tool-call-card").querySelector("img")).toBeNull();
    viewRaw();
    expect(rawValue("result")).toEqual(result);
    fireEvent.click(screen.getByRole("button", { name: "复制原始数据" }));
    expect(writeText).toHaveBeenCalledWith(rawToolData(card({ isError: true, done: true, result })));
    await screen.findByText("已复制");
  });

  it("复杂参数安全结构化，未知结果完整原值可展开", () => {
    const args = { command: "  <script>alert(1)</script>\n下一行", options: { flags: [false, 0, null] } };
    render(<ToolCallCard call={card({ args, result: { nested: { payload: [0, false, "原文"] } }, done: true, isError: true })} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    expect(screen.getByText(args.command, { selector: ".tool-readable-value", normalizer: value => value }).textContent).toBe(args.command);
    expect(screen.getByTestId("tool-call-card").querySelector("script")).toBeNull();
    expect(screen.getByText("flags")).toBeVisible();
    expect(screen.getByText(/"payload"/, { selector: ".tool-readable-value" })).toBeVisible();
    viewRaw();
    expect(rawValue("result")).toEqual({ nested: { payload: [0, false, "原文"] } });
  });

  it("中止或缺失最终结果不伪造输出，不以部分结果冒充最终结果", () => {
    let state = applySseEvent(createChatState(), { type: "tool_start", toolCallId: "t1", toolName: "search", args: {} });
    state = applySseEvent(state, { type: "aborted" });
    const call = (state.timeline[0] as Extract<typeof state.timeline[number], { kind: "tool" }>).call;
    const { rerender } = render(<ToolCallCard call={call} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    expect(screen.queryByTestId("tool-result-text")).not.toBeInTheDocument();
    // The existing protocol does not mark a tool as ended on aborted.
    expect(call.done).toBe(false);
    rerender(<ToolCallCard call={card({ done: true, isError: true, partialResult: "旧输出" })} />);
    expect(screen.getByText("未提供结果")).toBeVisible();
    expect(screen.queryByText("旧输出")).not.toBeInTheDocument();
  });

  it("tool_update 状态：展示流式 partialResult", () => {
    render(<ToolCallCard call={card({ partialResult: "部" })} />);
    expand();
    expect(screen.getByRole("region", { name: "部分结果" })).toBeVisible();
    expect(screen.getByText("部", { selector: ".tool-readable-value" })).toBeInTheDocument();
    expect(screen.queryByText("结果")).not.toBeInTheDocument();
  });

  it("完成事件保留用户在运行期间手动选择的展开状态", () => {
    const { rerender } = render(<ToolCallCard call={card()} />);
    const header = screen.getByRole("button", { name: /工具调用 search.*进行中/ });
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    rerender(<ToolCallCard call={card({ partialResult: "更新也不能打开" })} />);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("tool-result-text")).not.toBeInTheDocument();

    rerender(<ToolCallCard call={card({ result: "完成结果", done: true })} />);
    const completedHeader = screen.getByRole("button", { name: /工具调用 search.*完成/ });
    expect(completedHeader).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("参数")).not.toBeInTheDocument();

    fireEvent.click(completedHeader);
    rerender(<ToolCallCard call={card({ result: "rate limit", isError: true, done: true })} />);
    expect(screen.getByRole("button", { name: /工具调用 search.*失败/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("rate limit", { selector: ".tool-readable-value" })).toBeVisible();
  });

  it("tool_end 状态：标记完成并展示 result，partialResult 让位于 result", () => {
    render(<ToolCallCard call={card({ partialResult: "部", result: "完整结果", done: true })} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    expect(screen.getByTestId("tool-call-card").dataset.done).toBe("true");
    expect(screen.getByRole("region", { name: "结果" })).toBeVisible();
    expect(screen.getByText("完整结果", { selector: ".tool-readable-value" })).toBeInTheDocument();
    expect(screen.queryByText("部分结果")).not.toBeInTheDocument();
  });

  it("用户手动展开后，成功与失败结束均保留正文和原始详情", () => {
    const { rerender } = render(<ToolCallCard call={card()} />);
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    fireEvent.click(screen.getByRole("button", { name: /工具调用/ }));
    rerender(<ToolCallCard call={card({ result: "完整结果", done: true })} />);
    expect(screen.getByRole("button", { name: /工具调用 search.*完成/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("tool-result-text")).toHaveTextContent("完整结果");

    rerender(<ToolCallCard call={card({ result: "rate limit", isError: true, done: true })} />);
    expect(screen.getByRole("img", { name: "失败" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /工具调用 search.*失败/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("rate limit", { selector: ".tool-readable-value" })).toBeVisible();
    expect(screen.getByTestId("tool-call-card").dataset.done).toBe("true");
  });
});
