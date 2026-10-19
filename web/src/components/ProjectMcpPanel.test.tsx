import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError, SHARED_MCP_MASK, type McpConnection, type ProjectMcpServer, type ProjectMcpSettings, type SharedMcpList } from "pi-agent-server/client";
import { zhCN } from "../i18n/zh-CN.js";
import { useProjectMcp } from "./ProjectMcpPanel.js";
import { captureMcpOAuthReturn, clearMcpOAuthReturn } from "../mcp-oauth-return.js";

const docs: ProjectMcpServer = { name: "docs", status: "available", description: "Docs search", transport: "http", enabled: false,
  exposure: "codemode", defaultExposure: "codemode", maxExposure: "codemode", hiddenTools: [], adminOnly: false, canEnable: true, updatedAt: null };
const admin: ProjectMcpServer = { ...docs, name: "admin", description: "Admin tools", transport: "stdio", maxExposure: "direct", adminOnly: true, canEnable: false };

const linear: ProjectMcpServer = { ...docs, name: "linear", description: "Linear issues", oauthLabel: "Linear" };

const notAdmin: SharedMcpList = { canEdit: false, servers: [] };

function setup(settings: ProjectMcpSettings, save = vi.fn(), connections: () => Promise<{ servers: McpConnection[] }> = async () => ({ servers: [] }),
  shared: { list?: SharedMcpList; save?: (name: string, input: unknown) => Promise<SharedMcpList>; remove?: (name: string, hash: string) => Promise<SharedMcpList> } = {}) {
  const api = {
    getSharedMcp: vi.fn(async () => shared.list ?? notAdmin),
    saveSharedMcpServer: vi.fn(shared.save ?? (async () => notAdmin)),
    removeSharedMcpServer: vi.fn(shared.remove ?? (async () => notAdmin)),
    getProjectMcp: vi.fn(async () => settings), saveProjectMcpServer: save,
    listMcpConnections: vi.fn(connections),
    startMcpOAuth: vi.fn(async () => ({ authorizationUrl: "https://auth.example.test/authorize?state=s" })),
    disconnectMcp: vi.fn(async () => {}),
  };
  render(<Entry api={api} />);
  return { api, save };
}

/** 代替侧栏“设置”菜单里的那一项。 */
function Entry({ api }: { api: Parameters<typeof useProjectMcp>[0]["api"] }) {
  const mcp = useProjectMcp({ api, projectId: "p1", projectName: "Demo" });
  return <>{mcp.available && <button type="button" data-testid="project-mcp-open" onClick={mcp.openPanel}>MCP</button>}{mcp.dialog}</>;
}

afterEach(() => {
  clearMcpOAuthReturn();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});
const row = (name: string) => screen.getAllByTestId("project-mcp-server").find(element => element.dataset.server === name)!;

describe("useProjectMcp", () => {
  it("stays hidden when the server has no MCP catalog", async () => {
    const { api } = setup({ configured: false, canEdit: false, servers: [] });
    await waitFor(() => expect(api.getProjectMcp).toHaveBeenCalledWith("p1"));
    expect(screen.queryByTestId("project-mcp-open")).toBeNull();
  });

  it("saves each change at once: the switch, the exposure and the hidden tools", async () => {
    const save = vi.fn(async (_project: string, _name: string, input: { enabled: boolean; exposure?: string | null; hiddenTools?: readonly string[] }) =>
      ({ server: { ...docs, enabled: input.enabled, exposure: (input.exposure ?? "codemode") as "codemode", hiddenTools: [...input.hiddenTools ?? []], updatedAt: 1 } }));
    setup({ configured: true, canEdit: true, servers: [docs, admin] }, save);
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    const form = within(row("docs"));
    // A server that is off shows no settings.
    expect(form.queryByRole("combobox")).toBeNull();
    fireEvent.click(form.getByRole("checkbox", { name: "docs" }));
    await waitFor(() => expect(form.getByRole("status").textContent).toBe(zhCN.projectMcp.saved));
    expect(save).toHaveBeenLastCalledWith("p1", "docs", { enabled: true, exposure: null, hiddenTools: [] });
    // maxExposure caps the choices.
    expect(form.getAllByRole("option").map(option => option.getAttribute("value"))).toEqual(["", "codemode", "deferred", "hidden"]);
    fireEvent.change(form.getByRole("combobox", { name: zhCN.projectMcp.exposure }), { target: { value: "hidden" } });
    await waitFor(() => expect(save).toHaveBeenLastCalledWith("p1", "docs", { enabled: true, exposure: "hidden", hiddenTools: [] }));
    fireEvent.click(form.getByRole("button", { name: zhCN.projectMcp.edit }));
    fireEvent.change(form.getByRole("textbox", { name: zhCN.projectMcp.hiddenTools }), { target: { value: "write, delete write" } });
    fireEvent.keyDown(form.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(form.getByText("write, delete")).toBeTruthy());
    expect(save).toHaveBeenLastCalledWith("p1", "docs", { enabled: true, exposure: "hidden", hiddenTools: ["write", "delete"] });
  });

  it("cancels editing the hidden tools with Esc without closing the panel", async () => {
    const save = vi.fn();
    setup({ configured: true, canEdit: true, servers: [{ ...docs, enabled: true, updatedAt: 1 }] }, save);
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    const form = within(row("docs"));
    fireEvent.click(form.getByRole("button", { name: zhCN.projectMcp.edit }));
    fireEvent.change(form.getByRole("textbox"), { target: { value: "write" } });
    fireEvent.keyDown(form.getByRole("textbox"), { key: "Escape" });
    expect(form.queryByRole("textbox")).toBeNull();
    expect(form.getByText(zhCN.projectMcp.noHiddenTools)).toBeTruthy();
    expect(screen.getByTestId("project-mcp-panel")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
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
    await waitFor(() => expect(form.getByRole("status").textContent).toBe("保存失败：这个 MCP server 只有管理员能启用"));
    // Back to what the server has.
    expect(form.getByRole("checkbox")).not.toBeChecked();
  });

  it("is read-only for viewers and lists servers removed from the catalog", async () => {
    setup({ configured: true, canEdit: false, servers: [{ ...docs, enabled: true }, { name: "gone", status: "missing", enabled: false, hiddenTools: [], updatedAt: 1 }] });
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    const panel = screen.getByTestId("project-mcp-panel");
    expect(within(panel).getByRole("note").textContent).toContain("只读");
    expect(within(panel).queryByRole("button", { name: zhCN.projectMcp.edit })).toBeNull();
    for (const control of within(panel).getAllByRole("checkbox")) expect(control).toBeDisabled();
    expect(within(row("docs")).queryByRole("combobox")).toBeNull();
    expect(row("docs").textContent).toContain(zhCN.projectMcp.defaultExposure(zhCN.projectMcp.exposures.codemode!));
    expect(row("gone").textContent).toContain(zhCN.projectMcp.missing);
  });

  it("connects a personal server through the authorization page and remembers where the user was", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, pathname: "/p/p1/s/s1" });
    const { api } = setup({ configured: true, canEdit: true, servers: [docs, linear] });
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    const row = within(screen.getByTestId("project-mcp-connection"));
    expect(screen.getByTestId("project-mcp-panel").textContent).toContain(zhCN.projectMcp.personal);
    await waitFor(() => expect(row.getByText(zhCN.projectMcp.connection.notConnected("Linear"))).toBeTruthy());
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
    await waitFor(() => expect(row.getByText(zhCN.projectMcp.connection.notConnected("Linear"))).toBeTruthy());
    expect(api.disconnectMcp).toHaveBeenCalledWith("linear");
  });

  it("explains that viewers cannot connect", async () => {
    setup({ configured: true, canEdit: false, servers: [linear] }, vi.fn(), async () => { throw new ApiError(403, "HTTP 403"); });
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    const row = within(screen.getByTestId("project-mcp-connection"));
    await waitFor(() => expect(row.getByText(zhCN.projectMcp.connection.unavailable)).toBeTruthy());
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

  it("asks to confirm a project setting again once the server behind the name changed", async () => {
    setup({ configured: true, canEdit: true, servers: [{ ...docs, changed: true, updatedAt: 1 }] });
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    expect(within(row("docs")).getByRole("note").textContent).toBe(zhCN.projectMcp.changed);
    expect(within(row("docs")).getByRole("checkbox", { name: "docs" })).not.toBeChecked();
  });

  it("shows the shared MCP tab to admins only", async () => {
    setup({ configured: true, canEdit: true, servers: [docs] });
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("shared MCP panel", () => {
  const sharedDocs = {
    name: "docs", status: "available", transport: "http", exposure: "codemode", adminOnly: false, description: "Docs search",
    config: { transport: "http", url: "https://docs.example.com/mcp", headers: { Authorization: SHARED_MCP_MASK }, description: "Docs search" },
    otherFields: ["toolExposure"],
  } as const;
  const listed: SharedMcpList = {
    canEdit: true, file: { path: "/home/me/.pi/agent/mcp.json", hash: "h1" },
    servers: [sharedDocs, { name: "tui", status: "unavailable", reason: "auth.provider 仅 TUI 可用", transport: "http", config: { transport: "http", url: "https://t.example.com" }, otherFields: ["auth"] }],
  };
  const sharedRow = (name: string) => screen.getAllByTestId("shared-mcp-server").find(element => element.dataset.server === name)!;
  async function openShared(shared: Parameters<typeof setup>[3]) {
    const result = setup({ configured: true, canEdit: true, servers: [docs] }, vi.fn(), undefined, { list: listed, ...shared });
    fireEvent.click(await screen.findByTestId("project-mcp-open"));
    fireEvent.click(await screen.findByTestId("project-mcp-tab-shared"));
    await screen.findByTestId("shared-mcp-panel");
    await screen.findAllByTestId("shared-mcp-server");
    return result;
  }

  it("lists the file's servers with why one is unusable", async () => {
    await openShared({});
    expect(screen.getByText(listed.file!.path)).toBeTruthy();
    expect(within(sharedRow("tui")).getByText("auth.provider 仅 TUI 可用")).toBeTruthy();
  });

  it("adds a server and refreshes the project list", async () => {
    const save = vi.fn(async () => ({ ...listed, file: { ...listed.file!, hash: "h2" } }));
    const { api } = await openShared({ save });
    fireEvent.click(screen.getByTestId("shared-mcp-add"));
    const form = within(screen.getByTestId("shared-mcp-form"));
    fireEvent.change(form.getByLabelText(zhCN.sharedMcp.fields.name), { target: { value: "notes" } });
    fireEvent.change(form.getByLabelText(zhCN.sharedMcp.fields.transport), { target: { value: "stdio" } });
    fireEvent.change(form.getByLabelText(zhCN.sharedMcp.fields.command), { target: { value: "npx" } });
    fireEvent.change(form.getByLabelText(zhCN.sharedMcp.fields.args), { target: { value: "-y\nnotes-mcp\n" } });
    fireEvent.click(form.getByRole("button", { name: zhCN.sharedMcp.save }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("notes", { hash: "h1", server: {
      transport: "stdio", command: "npx", args: ["-y", "notes-mcp"], env: {}, cwd: "", description: "", exposure: "codemode",
      adminOnly: false, defaultEnabled: false, enabled: true,
    } }));
    await waitFor(() => expect(api.getProjectMcp).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("shared-mcp-form")).toBeNull();
  });

  it("sends masked values back unchanged and offers a reload when the file changed elsewhere", async () => {
    const save = vi.fn(async () => { throw new ApiError(409, 'HTTP 409: {"message":"配置文件已在别处修改，请刷新后再改"}'); });
    const { api } = await openShared({ save });
    fireEvent.click(within(sharedRow("docs")).getByRole("button", { name: zhCN.sharedMcp.edit }));
    const form = within(screen.getByTestId("shared-mcp-form"));
    expect(form.getByText(zhCN.sharedMcp.otherFields("toolExposure"))).toBeTruthy();
    fireEvent.change(form.getByLabelText(zhCN.sharedMcp.fields.description), { target: { value: "Docs v2" } });
    fireEvent.click(form.getByRole("button", { name: zhCN.sharedMcp.save }));
    await waitFor(() => expect(form.getByRole("alert").textContent).toContain("配置文件已在别处修改"));
    expect(save).toHaveBeenCalledWith("docs", { hash: "h1", server: expect.objectContaining({ url: "https://docs.example.com/mcp", headers: { Authorization: SHARED_MCP_MASK }, description: "Docs v2", oauth: null }) });
    fireEvent.click(form.getByRole("button", { name: zhCN.sharedMcp.reload }));
    await waitFor(() => expect(api.getSharedMcp).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId("shared-mcp-form")).toBeNull();
  });

  it("removes a server after confirmation", async () => {
    const remove = vi.fn(async () => ({ ...listed, servers: [listed.servers[1]!] }));
    await openShared({ remove });
    fireEvent.click(within(sharedRow("docs")).getByRole("button", { name: zhCN.sharedMcp.remove }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(sharedRow("docs")).getByRole("button", { name: zhCN.sharedMcp.confirmRemove }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("docs", "h1"));
    await waitFor(() => expect(screen.getAllByTestId("shared-mcp-server").map(element => element.dataset.server)).toEqual(["tui"]));
  });
});

