import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError, type McpConnection, type ProjectMcpServer, type ProjectMcpSettings } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { ProjectMcpButton } from "./ProjectMcpPanel.js";
import { captureMcpOAuthReturn, clearMcpOAuthReturn } from "../mcp-oauth-return.js";

const docs: ProjectMcpServer = { name: "docs", status: "available", description: "Docs search", transport: "http", enabled: false,
  exposure: "codemode", defaultExposure: "codemode", maxExposure: "codemode", hiddenTools: [], adminOnly: false, canEnable: true, updatedAt: null };
const admin: ProjectMcpServer = { ...docs, name: "admin", description: "Admin tools", transport: "stdio", maxExposure: "direct", adminOnly: true, canEnable: false };

const linear: ProjectMcpServer = { ...docs, name: "linear", description: "Linear issues", oauthLabel: "Linear" };

function setup(settings: ProjectMcpSettings, save = vi.fn(), connections: () => Promise<{ servers: McpConnection[] }> = async () => ({ servers: [] })) {
  const api = {
    getProjectMcp: vi.fn(async () => settings), saveProjectMcpServer: save,
    listMcpConnections: vi.fn(connections),
    startMcpOAuth: vi.fn(async () => ({ authorizationUrl: "https://auth.example.test/authorize?state=s" })),
    disconnectMcp: vi.fn(async () => {}),
  };
  render(<ProjectMcpButton api={api} projectId="p1" projectName="Demo" />);
  return { api, save };
}

afterEach(() => {
  clearMcpOAuthReturn();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});
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
    expect(row("gone").textContent).toContain(zhCN.projectMcp.missing);
  });

  it("connects a personal server through the authorization page and remembers where the user was", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, pathname: "/p/p1/s/s1" });
    const { api } = setup({ configured: true, canEdit: true, servers: [docs, linear] });
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    const row = within(screen.getByTestId("project-mcp-connection"));
    expect(screen.getByTestId("project-mcp-panel").textContent).toContain("个人授权");
    await waitFor(() => expect(row.getByText("你还没有连接 Linear。")).toBeTruthy());
    fireEvent.click(row.getByRole("button", { name: "连接 Linear" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://auth.example.test/authorize?state=s"));
    expect(api.startMcpOAuth).toHaveBeenCalledWith("linear");
    expect(window.sessionStorage.getItem("pi.mcpOAuthReturnPath")).toBe("/p/p1/s/s1");
  });

  it("shows the connected account and disconnects", async () => {
    let connected = true;
    const { api } = setup({ configured: true, canEdit: true, servers: [linear] }, vi.fn(),
      async () => ({ servers: [{ name: "linear", label: "Linear", connected, ...(connected ? { account: "me@example.com", connectedAt: 1 } : {}) }] }));
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    const row = within(screen.getByTestId("project-mcp-connection"));
    await waitFor(() => expect(row.getByText("已连接：me@example.com")).toBeTruthy());
    connected = false;
    fireEvent.click(row.getByRole("button", { name: "断开" }));
    await waitFor(() => expect(row.getByText("你还没有连接 Linear。")).toBeTruthy());
    expect(api.disconnectMcp).toHaveBeenCalledWith("linear");
  });

  it("explains that viewers cannot connect", async () => {
    setup({ configured: true, canEdit: false, servers: [linear] }, vi.fn(), async () => { throw new ApiError(403, "HTTP 403"); });
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    const row = within(screen.getByTestId("project-mcp-connection"));
    await waitFor(() => expect(row.getByText("只有能运行会话的用户可以连接。")).toBeTruthy());
    expect(row.queryByRole("button")).toBeNull();
  });

  it("opens with the result after returning from the authorization page, back on the original page", async () => {
    window.sessionStorage.setItem("pi.mcpOAuthReturnPath", "/p/p1/s/s1");
    window.history.replaceState(null, "", "/?mcp_oauth=connected&mcp_server=linear");
    captureMcpOAuthReturn();
    expect(window.location.pathname + window.location.search).toBe("/p/p1/s/s1");
    setup({ configured: true, canEdit: true, servers: [linear] }, vi.fn(), async () => ({ servers: [{ name: "linear", label: "Linear", connected: true, connectedAt: 1 }] }));
    const notice = await screen.findByTestId("project-mcp-returned");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("已连接 Linear");
    fireEvent.click(within(notice).getByRole("button", { name: "知道了" }));
    expect(screen.queryByTestId("project-mcp-returned")).toBeNull();
  });

  it("reports a failed authorization and ignores a return path from elsewhere", async () => {
    window.sessionStorage.setItem("pi.mcpOAuthReturnPath", "//evil.example.test/x");
    window.history.replaceState(null, "", "/?mcp_oauth=denied&mcp_server=linear");
    captureMcpOAuthReturn();
    expect(window.location.pathname + window.location.search).toBe("/");
    setup({ configured: true, canEdit: true, servers: [linear] });
    const notice = await screen.findByTestId("project-mcp-returned");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("你在授权页取消了授权");
  });
});
