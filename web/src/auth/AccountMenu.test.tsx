import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "pi-agent-server/client";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/ui/dropdown-menu.js";
import { zhCN } from "../i18n/zh-CN.js";
import { AuthContext, IP_AUTH_SESSION, type AuthSession } from "./auth-context.js";
import { useAccountMenu } from "./AccountMenu.js";

/** Stands in for the sidebar's settings menu. */
function Menu() {
  const menu = useAccountMenu();
  return <>
    <span data-testid="menu-available">{String(menu.available)}</span>
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="settings-toggle">settings</DropdownMenuTrigger>
      <DropdownMenuContent>{menu.items}</DropdownMenuContent>
    </DropdownMenu>
    {menu.dialog}
  </>;
}

function setup(overrides: Partial<AuthSession> = {}) {
  const session: AuthSession = {
    ...IP_AUTH_SESSION, mode: "accounts", account: { id: "a1", name: "mz", role: "admin" },
    logout: vi.fn(async () => {}), changePassword: vi.fn(async () => {}), ...overrides,
  };
  render(<AuthContext.Provider value={session}><Menu /></AuthContext.Provider>);
  return session;
}

function openMenu() {
  const toggle = screen.getByTestId("settings-toggle");
  fireEvent.pointerDown(toggle, { button: 0, ctrlKey: false });
}

async function openPasswordDialog() {
  openMenu();
  fireEvent.click(await screen.findByTestId("password-open"));
  await screen.findByTestId("password-current");
}

function fill(current: string, next: string, confirm = next) {
  fireEvent.change(screen.getByTestId("password-current"), { target: { value: current } });
  fireEvent.change(screen.getByTestId("password-next"), { target: { value: next } });
  fireEvent.change(screen.getByTestId("password-confirm"), { target: { value: confirm } });
  fireEvent.click(screen.getByTestId("password-save"));
}

const NEW_PASSWORD = "another horse battery";

describe("account menu", () => {
  it("is absent in ip mode", () => {
    render(<Menu />);
    expect(screen.getByTestId("menu-available")).toHaveTextContent("false");
  });

  it("names the account and logs out", async () => {
    const session = setup();
    openMenu();
    expect(await screen.findByTestId("account-name")).toHaveTextContent(zhCN.auth.account("mz"));
    fireEvent.click(screen.getByTestId("logout"));
    expect(session.logout).toHaveBeenCalledOnce();
  });

  it("says so when logging out fails", async () => {
    setup({ logout: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) });
    openMenu();
    fireEvent.click(await screen.findByTestId("logout"));
    expect(await screen.findByTestId("logout-failed")).toHaveTextContent(zhCN.auth.logoutFailed);
  });

  it("checks the new password before sending it", async () => {
    const session = setup();
    await openPasswordDialog();
    fill("old password!!", NEW_PASSWORD, `${NEW_PASSWORD}x`);
    expect(await screen.findByTestId("password-error")).toHaveTextContent(zhCN.auth.passwordMismatch);
    const short = "x".repeat(PASSWORD_MIN_LENGTH - 1);
    fill("old password!!", short);
    expect(screen.getByTestId("password-error")).toHaveTextContent(zhCN.auth.passwordLength(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH));
    // Counted in code points, as the server counts.
    fill("old password!!", "😀".repeat(PASSWORD_MIN_LENGTH - 1));
    expect(screen.getByTestId("password-error")).toHaveTextContent(zhCN.auth.passwordLength(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH));
    expect(session.changePassword).not.toHaveBeenCalled();
  });

  it("shows the server's reason, then the success", async () => {
    let failure: unknown = new ApiError(400, "HTTP 400", "invalid_current_password");
    const changePassword = vi.fn(async () => { if (failure) throw failure; });
    setup({ changePassword });
    await openPasswordDialog();
    fill("wrong password!", NEW_PASSWORD);
    expect(await screen.findByTestId("password-error")).toHaveTextContent(zhCN.auth.invalidCurrent);

    failure = new ApiError(429, "HTTP 429", "login_backoff", 3);
    fill("wrong password!", NEW_PASSWORD);
    await waitFor(() => expect(screen.getByTestId("password-error")).toHaveTextContent(zhCN.auth.backoff(3)));

    failure = null;
    fill("right password!", NEW_PASSWORD);
    expect(await screen.findByTestId("password-changed")).toHaveTextContent(zhCN.auth.passwordChanged);
    expect(changePassword).toHaveBeenLastCalledWith("right password!", NEW_PASSWORD);
    fireEvent.click(screen.getByTestId("password-done"));
    await waitFor(() => expect(screen.queryByTestId("password-changed")).toBeNull());
  });
});
