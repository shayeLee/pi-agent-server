import { createContext, useContext } from "react";
import type { AuthAccount, FetchLike } from "pi-agent-server/client";

/** What the app needs to know about login (docs/login-design.md §9: `web/`). */
export type AuthSession = {
  mode: "ip" | "accounts";
  /** PI_PUBLIC_URL's origin (accounts mode): the one address MCP authorization returns to. */
  publicOrigin?: string;
  /** The signed-in account; `null` in ip mode. */
  account: AuthAccount | null;
  /** Fetch for API calls; in accounts mode a 401 response ends the login. */
  fetch: FetchLike;
  /** Report that the login ended (an SSE `auth_expired`, or a 401). */
  onAuthExpired?: () => void;
  /** Bumped when the same account signs back in, so live streams reconnect. */
  generation: number;
  logout?: () => Promise<void>;
  changePassword?: (current: string, next: string) => Promise<void>;
};

const plainFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** ip mode: no login, plain fetch. Also what the app gets when rendered without the gate (tests). */
export const IP_AUTH_SESSION: AuthSession = { mode: "ip", account: null, fetch: plainFetch, generation: 0 };

export const AuthContext = createContext<AuthSession>(IP_AUTH_SESSION);

export function useAuth(): AuthSession {
  return useContext(AuthContext);
}
