import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError, type ProjectMcpServer, type ProjectMcpSettings } from "pi-agent-server/client";
import { ProjectMcpButton } from "./ProjectMcpPanel.js";

const docs: ProjectMcpServer = { name: "docs", status: "available", description: "Docs search", transport: "http", enabled: false,
  exposure: "codemode", defaultExposure: "codemode", maxExposure: "codemode", hiddenTools: [], adminOnly: false, canEnable: true, updatedAt: null };
const admin: ProjectMcpServer = { ...docs, name: "admin", description: "Admin tools", transport: "stdio", maxExposure: "direct", adminOnly: true, canEnable: false };

function setup(settings: ProjectMcpSettings, save = vi.fn()) {
  const api = { getProjectMcp: vi.fn(async () => settings), saveProjectMcpServer: save };
  render(<ProjectMcpButton api={api} projectId="p1" projectName="Demo" />);
  return { api, save };
}
const row = (name: string) => screen.getAllByTestId("project-mcp-server").find(element => element.dataset.server === name)!;

describe("ProjectMcpButton", () => {
  it("stays hidden when the server has no MCP catalog", async () => {
    const { api } = setup({ configured: false, canEdit: false, servers: [] });
    await waitFor(() => expect(api.getProjectMcp).toHaveBeenCalledWith("p1"));
    expect(screen.queryByTestId("project-mcp-open")).toBeNull();
  });

  it("saves a server's switch, exposure and hidden tools", async () => {
    const save = vi.fn(async () => ({ server: { ...docs, enabled: true, exposure: "hidden" as const, hiddenTools: ["write", "delete"], updatedAt: 1 } }));
    setup({ configured: true, canEdit: true, servers: [docs, admin] }, save);
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    const form = within(row("docs"));
    expect(form.getByRole("button", { name: "保存" })).toBeDisabled();
    // maxExposure caps the choices.
    expect(form.getAllByRole("option").map(option => option.getAttribute("value"))).toEqual(["", "codemode", "deferred", "hidden"]);
    fireEvent.click(form.getByRole("checkbox"));
    fireEvent.change(form.getByRole("combobox"), { target: { value: "hidden" } });
    fireEvent.change(form.getByRole("textbox"), { target: { value: "write, delete write" } });
    fireEvent.click(form.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(form.getByRole("status").textContent).toContain("已保存"));
    expect(save).toHaveBeenCalledWith("p1", "docs", { enabled: true, exposure: "hidden", hiddenTools: ["write", "delete"] });
    expect(form.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("keeps adminOnly servers off for callers who cannot enable them", async () => {
    setup({ configured: true, canEdit: true, servers: [docs, admin] });
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    expect(within(row("admin")).getByRole("checkbox")).toBeDisabled();
    expect(row("admin").textContent).toContain("仅管理员可启用");
  });

  it("shows the server's reason when a save is refused", async () => {
    const save = vi.fn(async () => { throw new ApiError(403, 'HTTP 403: {"code":"mcp_admin_only","message":"这个 MCP server 只有管理员能启用"}'); });
    setup({ configured: true, canEdit: true, servers: [docs] }, save);
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    const form = within(row("docs"));
    fireEvent.click(form.getByRole("checkbox"));
    fireEvent.click(form.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(form.getByRole("status").textContent).toBe("保存失败：这个 MCP server 只有管理员能启用"));
  });

  it("is read-only for viewers and lists servers removed from the catalog", async () => {
    setup({ configured: true, canEdit: false, servers: [{ ...docs, enabled: true }, { name: "gone", status: "missing", enabled: false, hiddenTools: [], updatedAt: 1 }] });
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    const panel = screen.getByTestId("project-mcp-panel");
    expect(within(panel).getByRole("note").textContent).toContain("只读");
    expect(within(panel).queryByRole("button", { name: "保存" })).toBeNull();
    for (const control of within(panel).getAllByRole("checkbox")) expect(control).toBeDisabled();
    expect(within(row("docs")).getByRole("combobox")).toBeDisabled();
    expect(row("gone").textContent).toContain("已从目录移除");
  });
});
