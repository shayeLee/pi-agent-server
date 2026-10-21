import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError, type AgentSettings, type AgentSettingsInput, type ModelInfo } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { useAgentSettings } from "./AgentSettingsPanel.js";

const text = zhCN.agentSettings;

const models: ModelInfo[] = [
  { provider: "openai", id: "gpt-6", name: "GPT-6" },
  { provider: "anthropic", id: "claude", name: "Claude" },
];

function settings(patch: Partial<AgentSettings["values"]> = {}, canEdit = true): AgentSettings {
  return {
    canEdit,
    values: { autoCompaction: true, autoRetry: true, maxRetries: 3, modelThinkingLevels: { "openai/gpt-6": "high", "gone/model": "low" }, ...patch },
    defaults: { autoCompaction: true, autoRetry: true, maxRetries: 3 },
    ...(canEdit ? { file: { path: "/agent/settings.json", hash: "h1" } } : {}),
  };
}

type Api = Parameters<typeof useAgentSettings>[0]["api"];

function setup(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const onSaved = vi.fn();
  const api = {
    getAgentSettings: vi.fn(async () => settings()),
    saveAgentSettings: vi.fn(async (input: AgentSettingsInput) => settings(input.values)),
    ...overrides,
  };
  render(<Entry api={api as Api} onSaved={onSaved} />);
  return { api, onSaved };
}

/** 代替侧栏“设置”菜单里的那一项。 */
function Entry({ api, onSaved }: { api: Api; onSaved: () => void }) {
  const entry = useAgentSettings({ api, models, onSaved });
  return <>{entry.available && <button type="button" data-testid="agent-settings-open" onClick={entry.openPanel}>open</button>}{entry.dialog}</>;
}

async function openPanel() {
  fireEvent.click(await screen.findByTestId("agent-settings-open"));
  return screen.findByTestId("agent-settings-panel");
}

describe("AgentSettingsPanel", () => {
  it("is hidden when the service has no Agent settings", async () => {
    const { api } = setup({ getAgentSettings: vi.fn(async () => { throw new Error("HTTP 404"); }) });
    await waitFor(() => expect(api.getAgentSettings).toHaveBeenCalled());
    expect(screen.queryByTestId("agent-settings-open")).toBeNull();
  });

  it("saves a toggle with the file hash and tells the app", async () => {
    const { api, onSaved } = setup();
    await openPanel();
    fireEvent.click(within(screen.getByTestId("agent-settings-compaction")).getByRole("checkbox"));
    await waitFor(() => expect(api.saveAgentSettings).toHaveBeenCalledWith({ hash: "h1", values: { autoCompaction: false } }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(within(screen.getByTestId("agent-settings-compaction")).getByRole("checkbox")).not.toBeChecked();
  });

  it("saves the retry count on blur and ignores a value out of range", async () => {
    const { api } = setup();
    await openPanel();
    const input = screen.getByTestId("agent-settings-max-retries");
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.blur(input);
    expect(input).toHaveValue(3);
    expect(api.saveAgentSettings).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.saveAgentSettings).toHaveBeenCalledWith({ hash: "h1", values: { maxRetries: 5 } }));
  });

  it("edits per-model thinking levels as a whole map", async () => {
    const { api } = setup();
    await openPanel();
    const rows = screen.getAllByTestId("agent-settings-model-row");
    expect(rows.map(row => row.dataset.model)).toEqual(["gone/model", "openai/gpt-6"]);
    expect(within(rows[0]!).getByText(text.modelUnavailable)).toBeTruthy();
    fireEvent.click(within(rows[0]!).getByRole("button", { name: text.remove }));
    await waitFor(() => expect(api.saveAgentSettings).toHaveBeenLastCalledWith({ hash: "h1", values: { modelThinkingLevels: { "openai/gpt-6": "high" } } }));
    // 已设置的模型不再出现在“添加”里。
    fireEvent.click(screen.getByTestId("agent-settings-new-model"));
    expect(screen.queryByRole("option", { name: "openai/gpt-6" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "anthropic/claude" }));
    fireEvent.click(screen.getByTestId("agent-settings-add-model"));
    await waitFor(() => expect(api.saveAgentSettings).toHaveBeenLastCalledWith({
      hash: "h1", values: { modelThinkingLevels: { "openai/gpt-6": "high", "anthropic/claude": "medium" } },
    }));
  });

  it("offers a reload when the file changed elsewhere", async () => {
    const { api } = setup({ saveAgentSettings: vi.fn(async () => { throw new ApiError(409, "settings.json 已在别处修改"); }) });
    await openPanel();
    fireEvent.click(within(screen.getByTestId("agent-settings-retry")).getByRole("checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: text.reload }));
    await waitFor(() => expect(api.getAgentSettings).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is read-only for callers who cannot edit", async () => {
    setup({ getAgentSettings: vi.fn(async () => settings({}, false)) });
    await openPanel();
    expect(screen.getByText(text.readOnly)).toBeTruthy();
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeDisabled();
    expect(screen.queryByTestId("agent-settings-new-model")).toBeNull();
    expect(screen.queryByText(/settings\.json/)).toBeNull();
  });
});
