import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PROJECT_TRUST_FILES, type ProjectTrustView } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { useProjectTrust } from "./ProjectTrustPanel.js";

const text = zhCN.projectTrust;

function trust(patch: Partial<ProjectTrustView> = {}): ProjectTrustView {
  return {
    trusted: false, source: "default", defaultTrust: "ask", canEdit: true,
    files: PROJECT_TRUST_FILES.map(name => ({ name, exists: name === ".pi/mcp.json" })), ...patch,
  };
}

type Api = Parameters<typeof useProjectTrust>[0]["api"];

function setup(initial: ProjectTrustView | Error, save = vi.fn(async (_id: string, trusted: boolean) => trust({ trusted, source: "project" }))) {
  const onChanged = vi.fn();
  const api = { getProjectTrust: vi.fn(async () => { if (initial instanceof Error) throw initial; return initial; }), saveProjectTrust: save };
  render(<Entry api={api as Api} onChanged={onChanged} />);
  return { api, save, onChanged };
}

/** 代替侧栏“设置”菜单里的那一项。 */
function Entry({ api, onChanged }: { api: Api; onChanged: () => void }) {
  const entry = useProjectTrust({ api, projectId: "p1", projectName: "Demo", onChanged });
  return <>{entry.available && <button type="button" data-testid="project-trust-open" onClick={entry.openPanel}>open</button>}{entry.dialog}</>;
}

async function openPanel() {
  fireEvent.click(await screen.findByTestId("project-trust-open"));
  return within(await screen.findByTestId("project-trust-panel"));
}

describe("ProjectTrustPanel", () => {
  it("is hidden when the service has no project trust", async () => {
    const { api } = setup(new Error("HTTP 404"));
    await waitFor(() => expect(api.getProjectTrust).toHaveBeenCalledWith("p1"));
    expect(screen.queryByTestId("project-trust-open")).toBeNull();
  });

  it("explains where the decision comes from and which files it loads", async () => {
    setup(trust());
    const panel = await openPanel();
    expect(panel.getByTestId("project-trust-source").textContent).toBe(text.source.default("ask"));
    const file = (name: string) => panel.getAllByTestId("project-trust-file").find(row => row.dataset.file === name)!;
    expect(file(".pi/mcp.json").textContent).toContain(text.exists);
    expect(file(".pi/SYSTEM.md").textContent).toContain(text.missing);
  });

  it("lets admins trust the project and tells the app", async () => {
    const { save, onChanged } = setup(trust());
    const panel = await openPanel();
    fireEvent.click(panel.getByRole("checkbox", { name: text.trusted }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("p1", true));
    await waitFor(() => expect(panel.getByTestId("project-trust-source").textContent).toBe(text.source.project(true)));
    expect(panel.getByRole("checkbox", { name: text.trusted })).toBeChecked();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("notes that a change below a trusted parent only adds the project's own entry", async () => {
    setup(trust({ trusted: true, source: "parent", entryPath: "/work" }));
    const panel = await openPanel();
    expect(panel.getByTestId("project-trust-source").textContent).toBe(text.source.parent(true, "/work"));
    expect(panel.getByText(text.parentHint)).toBeTruthy();
  });

  it("is read-only for callers who cannot edit", async () => {
    setup(trust({ canEdit: false }));
    const panel = await openPanel();
    expect(panel.getByRole("checkbox", { name: text.trusted })).toBeDisabled();
    expect(panel.getByText(text.readOnly)).toBeTruthy();
  });

  it("shows why a save failed", async () => {
    setup(trust(), vi.fn(async () => { throw new Error('HTTP 409: {"message":"trust.json is invalid"}'); }));
    const panel = await openPanel();
    fireEvent.click(panel.getByRole("checkbox", { name: text.trusted }));
    expect(await panel.findByText(text.saveFailed("trust.json is invalid"))).toBeTruthy();
    expect(panel.getByRole("checkbox", { name: text.trusted })).not.toBeChecked();
  });
});
