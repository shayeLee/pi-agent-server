// Authentication mode and the settings that follow from PI_PUBLIC_URL (docs/login-design.md §2, §5).
//
// - `ip` (default, frozen): identity is the client IP, as before.
// - `accounts`: identity is an account; PI_PUBLIC_URL is required and decides the cookie name,
//   the Secure flag and the default trusted origin for CSRF checks.

export type AuthMode = "ip" | "accounts";

export type AccountsAuthConfig = {
  readonly mode: "accounts";
  /** scheme://host[:port] of PI_PUBLIC_URL, default port omitted. */
  readonly publicOrigin: string;
  /** `pi_session_<effective port>`: cookies are not isolated by port. */
  readonly cookieName: string;
  readonly cookieSecure: boolean;
  /** Exact origins accepted by the CSRF check; always includes publicOrigin. */
  readonly trustedOrigins: ReadonlySet<string>;
};

export type AuthConfig = { readonly mode: "ip" } | AccountsAuthConfig;

export function parseAuthMode(value: string | undefined): AuthMode {
  if (value === undefined || value === "" || value === "ip") return "ip";
  if (value === "accounts") return "accounts";
  throw new Error("PI_AUTH_MODE 只支持 ip 或 accounts");
}

function parseHttpUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} 不是合法的 URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} 必须是 http 或 https 地址`);
  if (url.username || url.password) throw new Error(`${name} 不能包含用户名或密码`);
  return url;
}

/** The port a browser actually uses for this URL; the default port parses as "" and is filled in. */
export function effectivePort(url: URL): string {
  if (url.port !== "") return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

/** One trusted origin: a full origin with no path, query or fragment. `*` is never accepted. */
function parseTrustedOrigin(value: string): string {
  if (value === "*" || value === "null") throw new Error("PI_TRUSTED_ORIGINS 不接受 * 或 null");
  const url = parseHttpUrl(value, "PI_TRUSTED_ORIGINS 的条目");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PI_TRUSTED_ORIGINS 的条目只能是 origin（scheme://host[:port]），不能带路径");
  }
  if (url.origin !== value) throw new Error("PI_TRUSTED_ORIGINS 的条目必须是规范 origin（小写主机名，省略默认端口）");
  return url.origin;
}

export function resolveAuthConfig(input: {
  readonly mode: AuthMode;
  readonly publicUrl?: string;
  readonly trustedOrigins?: string;
}): AuthConfig {
  if (input.mode === "ip") return { mode: "ip" };
  if (!input.publicUrl) throw new Error("PI_AUTH_MODE=accounts 需要设置 PI_PUBLIC_URL");
  const url = parseHttpUrl(input.publicUrl, "PI_PUBLIC_URL");
  const publicOrigin = url.origin;
  const listed = (input.trustedOrigins ?? "").split(",").map(item => item.trim()).filter(Boolean);
  let trustedOrigins: Set<string>;
  if (listed.length === 0) {
    trustedOrigins = new Set([publicOrigin]);
  } else {
    trustedOrigins = new Set(listed.map(parseTrustedOrigin));
    if (!trustedOrigins.has(publicOrigin)) throw new Error("PI_TRUSTED_ORIGINS 必须包含 PI_PUBLIC_URL 的 origin");
  }
  return {
    mode: "accounts",
    publicOrigin,
    cookieName: `pi_session_${effectivePort(url)}`,
    cookieSecure: url.protocol === "https:",
    trustedOrigins,
  };
}
