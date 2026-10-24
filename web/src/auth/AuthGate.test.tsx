import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { zhCN } from "../i18n/zh-CN.js";
import { recentSelectionKey } from "../recent-selection.js";
import { AuthGate } from "./AuthGate.js";
import { useAuth } from "./auth-context.js";
import { accountScopedKey } from "./storage-scope.js";

const MZ = { id: "a1", name: "mz", role: "admin" };
const ADA = { id: "a2", name: "ada", role: "user" };

function json(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/** Fake server: one handler per "METHOD path"; every call is recorded. */
function serve(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${input}`;
    calls.push(key);
    const route = routes[key];
    if (!route) throw new TypeError(`unexpected ${key}`);
    return route(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, routes };
}

let mounts = 0;
/** Stands in for the app: local state shows whether it was kept or remounted. */
function Probe() {
  const auth = useAuth();
  const [draft, setDraft] = useState("");
  const [mountId] = useState(() => ++mounts);
  return <div data-testid="probe" data-mount={mountId} data-generation={auth.generation}>
    <span data-testid="probe-account">{auth.account?.name ?? "none"}</span>
    <input data-testid="probe-draft" value={draft} onChange={event => setDraft(event.target.value)} />
    <button type="button" data-testid="probe-expire" onClick={() => auth.onAuthExpired?.()}>expire</button>
    <button type="button" data-testid="probe-fetch" onClick={() => void auth.fetch("/v1/sessions")}>fetch</button>
    <button type="button" data-testid="probe-logout" onClick={() => void auth.logout?.()}>logout</button>
  </div>;
}

function renderGate() {
  return render(<AuthGate><Probe /></AuthGate>);
}

async function signIn(name: string, password = "correct horse battery") {
  fireEvent.change(await screen.findByTestId("login-name"), { target: { value: name } });
  fireEvent.change(screen.getByTestId("login-password"), { target: { value: password } });
  fireEvent.click(screen.getByTestId("login-submit"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("AuthGate", () => {
  it("ip mode renders the app without a login, and so does a server without /v1/auth/state", async () => {
    serve({ "GET /v1/auth/state": () => json(200, { mode: "ip" }) });
    const first = renderGate();
    expect((await screen.findByTestId("probe-account")).textContent).toBe("none");
    expect(screen.queryByTestId("login-page")).toBeNull();
    expect(accountScopedKey("k")).toBe("k");
    first.unmount();

    serve({ "GET /v1/auth/state": () => json(404, { message: "Route not found" }) });
    const second = renderGate();
    expect(await screen.findByTestId("probe")).toBeTruthy();
    second.unmount();

    // Anything but an explicit accounts answer is ip mode, e.g. a fixture that answers 204.
    serve({ "GET /v1/auth/state": () => new Response(null, { status: 204 }) });
    renderGate();
    expect(await screen.findByTestId("probe")).toBeTruthy();
  });

  it("asks to log in when not signed in, then shows the app for that account", async () => {
    const server = serve({
      "GET /v1/auth/state": () => json(200, { mode: "accounts", publicOrigin: window.location.origin }),
      "GET /v1/auth/me": () => json(401, { code: "auth_required" }),
      "POST /v1/auth/login": init => {
        expect(JSON.parse(String(init?.body))).toEqual({ name: "mz", password: "correct horse battery" });
        return json(200, { account: MZ });
      },
    });
    renderGate();
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expect(screen.queryByTestId("probe")).toBeNull();
    expect(screen.queryByTestId("login-origin-hint")).toBeNull();

    await signIn(" mz ");
    expect((await screen.findByTestId("probe-account")).textContent).toBe("mz");
    expect(screen.queryByTestId("login-page")).toBeNull();
    expect(server.calls).toContain("POST /v1/auth/login");
    expect(recentSelectionKey()).toMatch(/:account:a1$/);
  });

  it("shows why a login failed", async () => {
    let reply: Response = json(401, { code: "invalid_credentials" });
    serve({
      "GET /v1/auth/state": () => json(200, { mode: "accounts", publicOrigin: "http://pi.example:5180" }),
      "GET /v1/auth/me": () => json(401, {}),
      "POST /v1/auth/login": () => reply,
    });
    renderGate();
    expect(await screen.findByTestId("login-origin-hint")).toHaveTextContent("http://pi.example:5180");

    await signIn("mz", "wrong password!");
    expect(await screen.findByTestId("login-error")).toHaveTextContent(zhCN.auth.invalidCredentials);

    reply = json(429, { code: "login_backoff" }, { "retry-after": "4" });
    await signIn("mz", "wrong password!");
    await waitFor(() => expect(screen.getByTestId("login-error")).toHaveTextContent(zhCN.auth.backoff(4)));

    reply = json(429, { code: "login_busy" }, { "retry-after": "1" });
    await signIn("mz", "wrong password!");
    await waitFor(() => expect(screen.getByTestId("login-error")).toHaveTextContent(zhCN.auth.busy));

    // Opened on an address the server does not trust: the password was never checked.
    reply = json(403, { code: "csrf_rejected" });
    await signIn("mz", "correct horse battery");
    await waitFor(() => expect(screen.getByTestId("login-error")).toHaveTextContent(zhCN.auth.wrongOrigin("http://pi.example:5180")));
    expect(screen.getByTestId("login-error")).not.toHaveTextContent(zhCN.auth.invalidCredentials);
  });

  it("when the login expires, the same account signing back in keeps the app; another account gets a fresh one", async () => {
    let me: Response = json(200, { account: MZ, via: "cookie" });
    let account = MZ;
    serve({
      "GET /v1/auth/state": () => json(200, { mode: "accounts", publicOrigin: window.location.origin }),
      "GET /v1/auth/me": () => me,
      "POST /v1/auth/login": () => json(200, { account }),
      "GET /v1/sessions": () => json(401, { code: "auth_required" }),
    });
    renderGate();
    const probe = await screen.findByTestId("probe");
    const firstMount = probe.dataset.mount;
    fireEvent.change(screen.getByTestId("probe-draft"), { target: { value: "half a thought" } });
    window.history.replaceState(null, "", "/p/p1/s/s1");

    // A 401 from any API call ends the login; the app stays mounted, out of reach, under the login page.
    fireEvent.click(screen.getByTestId("probe-fetch"));
    expect(await screen.findByTestId("login-notice")).toHaveTextContent(zhCN.auth.expired);
    expect(screen.getByTestId("probe").closest(".auth-app")).toHaveAttribute("inert");

    await signIn("mz");
    await waitFor(() => expect(screen.queryByTestId("login-page")).toBeNull());
    expect(screen.getByTestId("probe").dataset.mount).toBe(firstMount);
    expect(screen.getByTestId("probe-draft")).toHaveValue("half a thought");
    expect(screen.getByTestId("probe").dataset.generation).toBe("1");
    expect(window.location.pathname).toBe("/p/p1/s/s1");
    expect(screen.getByTestId("probe").closest(".auth-app")).not.toHaveAttribute("inert");

    // SSE auth_expired goes the same way; this time someone else signs in.
    window.history.replaceState(null, "", "/p/p1/s/s1");
    fireEvent.click(screen.getByTestId("probe-expire"));
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    account = ADA;
    me = json(200, { account: ADA, via: "cookie" });
    await signIn("ada");
    await waitFor(() => expect(screen.getByTestId("probe-account")).toHaveTextContent("ada"));
    expect(screen.getByTestId("probe").dataset.mount).not.toBe(firstMount);
    expect(screen.getByTestId("probe-draft")).toHaveValue("");
    expect(screen.getByTestId("probe").dataset.generation).toBe("0");
    expect(accountScopedKey("k")).toBe("k:account:a2");
    expect(window.location.pathname).toBe("/");
  });

  it("logging out unmounts the app and shows the login page", async () => {
    const server = serve({
      "GET /v1/auth/state": () => json(200, { mode: "accounts", publicOrigin: window.location.origin }),
      "GET /v1/auth/me": () => json(200, { account: MZ, via: "cookie" }),
      "POST /v1/auth/logout": () => new Response(null, { status: 204 }),
    });
    window.history.replaceState(null, "", "/p/p1/s/s1");
    renderGate();
    fireEvent.click(await screen.findByTestId("probe-logout"));
    expect(await screen.findByTestId("login-notice")).toHaveTextContent(zhCN.auth.signedOut);
    expect(screen.queryByTestId("probe")).toBeNull();
    expect(server.calls).toContain("POST /v1/auth/logout");
    expect(accountScopedKey("k")).toBe("k");
    // The next account does not open on this one's session.
    expect(window.location.pathname).toBe("/");
  });

  it("offers a retry when the service cannot be reached", async () => {
    const server = serve({ "GET /v1/auth/state": () => { throw new TypeError("Failed to fetch"); } });
    renderGate();
    expect(await screen.findByTestId("auth-unreachable")).toHaveTextContent(zhCN.auth.unreachable);
    server.routes["GET /v1/auth/state"] = () => json(200, { mode: "ip" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: zhCN.auth.retry })); });
    expect(await screen.findByTestId("probe")).toBeTruthy();
  });
});
