// /v1/auth/* response shapes (docs/login-design.md §6), shared by the server routes and the Web client.

export type AuthRole = "viewer" | "user" | "operator" | "admin";

/** `ip`: identity is the client IP and there is no login. `accounts`: every request needs a login. */
export type AuthState = { mode: "ip" } | { mode: "accounts"; publicOrigin: string };

export type AuthAccount = { id: string; name: string; role: AuthRole };

export type AuthMe = { account: AuthAccount; via: "cookie" | "token" };

/** Password length the server accepts, in code points. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
