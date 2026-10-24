// Accounts-mode request authentication and the /v1/auth routes (docs/login-design.md §4–§6).
//
// Order for each request: IP admission (network-admission.ts) → CORS preflight or an exact public
// route passes with no account → Bearer token, else login cookie → CSRF for cookie writes →
// request.user / request.access → the unchanged RBAC matrix.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AccountsAuthConfig, AuthConfig } from "../auth/auth-config.js";
import type { AuthService, Authenticated } from "../auth/auth-service.js";
import { LoginBackoff, ScryptGate } from "../auth/login-limits.js";
import { passwordLengthOk, PASSWORD_MAX_LENGTH } from "../auth/secrets.js";
import { extractBearerToken } from "./network-admission.js";
import { evaluateRouteAuthorization, requirePermission } from "./route-rbac.js";

export const AUTH_REQUIRED_BODY = { statusCode: 401, error: "Unauthorized", code: "auth_required", message: "需要登录" } as const;
const CSRF_BODY = { statusCode: 403, error: "Forbidden", code: "csrf_rejected", message: "请求来源不受信任" } as const;
const NOT_ENABLED_BODY = { statusCode: 404, error: "Not Found", code: "auth_not_enabled", message: "未启用账号登录" } as const;
const INVALID_CREDENTIALS_BODY = { statusCode: 401, error: "Unauthorized", code: "invalid_credentials", message: "账号或密码错误" } as const;
const LOGIN_BODY_LIMIT = 4 * 1024;

/** Routes reachable without an account in accounts mode. Exact method + path, never a prefix. */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  "GET /health",
  "HEAD /health",
  "GET /readyz",
  "GET /v1/auth/state",
  "POST /v1/auth/login",
]);

export function isPublicRoute(method: string, rawUrl: string): boolean {
  return PUBLIC_ROUTES.has(`${method} ${rawUrl.split("?")[0]}`);
}

/** A complete CORS preflight: OPTIONS + Origin + Access-Control-Request-Method. */
export function isCorsPreflight(request: FastifyRequest): boolean {
  return request.method === "OPTIONS"
    && typeof request.headers.origin === "string" && request.headers.origin.length > 0
    && typeof request.headers["access-control-request-method"] === "string"
    && request.headers["access-control-request-method"].length > 0;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF for cookie-authenticated writes and for login:
 * - an Origin header must equal a trusted origin exactly; `null` is always rejected;
 * - only without Origin may `Sec-Fetch-Site: same-origin` decide; with neither, reject.
 */
export function csrfAllowed(headers: FastifyRequest["headers"], trustedOrigins: ReadonlySet<string>): boolean {
  const origin = headers.origin;
  if (origin !== undefined) return typeof origin === "string" && origin !== "null" && trustedOrigins.has(origin);
  return headers["sec-fetch-site"] === "same-origin";
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function sessionCookie(config: AccountsAuthConfig, value: string, maxAgeSeconds: number): string {
  return [
    `${config.cookieName}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ...(config.cookieSecure ? ["Secure"] : []),
  ].join("; ");
}

export type AccountAuthOutcome =
  | { kind: "public" }
  | { kind: "authenticated"; authenticated: Authenticated; recheck: () => Promise<boolean> }
  | { kind: "denied"; statusCode: 401 | 403 | 503; body: object };

/**
 * Authenticates one request in accounts mode. A failed lookup (database unavailable) answers 503
 * rather than 401, so a short outage does not look like being signed out.
 */
export async function authenticateAccountRequest(
  request: FastifyRequest,
  config: AccountsAuthConfig,
  auth: AuthService,
): Promise<AccountAuthOutcome> {
  if (isCorsPreflight(request) || isPublicRoute(request.method, request.url)) return { kind: "public" };
  const bearer = extractBearerToken(request.headers.authorization);
  const cookie = bearer === undefined ? readCookie(request.headers.cookie, config.cookieName) : undefined;
  if (bearer === undefined && !cookie) return { kind: "denied", statusCode: 401, body: AUTH_REQUIRED_BODY };
  const check = bearer !== undefined ? () => auth.authenticateToken(bearer) : () => auth.authenticateSession(cookie!);
  let authenticated: Authenticated | null;
  try {
    authenticated = await check();
  } catch {
    return { kind: "denied", statusCode: 503, body: { statusCode: 503, error: "Service Unavailable", message: "认证暂时不可用" } };
  }
  if (!authenticated) return { kind: "denied", statusCode: 401, body: AUTH_REQUIRED_BODY };
  if (authenticated.via === "cookie" && UNSAFE_METHODS.has(request.method) && !csrfAllowed(request.headers, config.trustedOrigins)) {
    return { kind: "denied", statusCode: 403, body: CSRF_BODY };
  }
  const accountId = authenticated.account.id;
  return {
    kind: "authenticated",
    authenticated,
    // Same checks as a new request (credential, account, latest role), for long-lived streams.
    recheck: async () => {
      const again = await check();
      return again !== null && again.account.id === accountId &&
        evaluateRouteAuthorization("sessions:events", again.account.role).verdict === "allowed";
    },
  };
}

type AuthRouteDeps = {
  readonly config: AuthConfig;
  readonly auth?: AuthService;
  readonly now?: () => number;
};

/** Max-Age of a freshly issued cookie: the session's absolute lifetime. */
function cookieMaxAge(session: { createdAt: number; expiresAt: number }): number {
  return (session.expiresAt - session.createdAt) / 1000;
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store");
}

function accountView(account: Authenticated["account"]) {
  return { id: account.id, name: account.name, role: account.role };
}

/** /v1/auth/*: every response is no-store; in ip mode all but /state answer 404 auth_not_enabled. */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const now = deps.now ?? Date.now;
  const gate = new ScryptGate();
  const backoff = new LoginBackoff();
  const accounts = deps.config.mode === "accounts" && deps.auth ? { config: deps.config, auth: deps.auth } : undefined;

  app.addHook("onSend", async (request, reply) => {
    if (request.url.split("?")[0]!.startsWith("/v1/auth/")) reply.header("cache-control", "no-store");
  });

  app.get("/v1/auth/state", { exposeHeadRoute: false, ...requirePermission("auth:state") }, async (_request, reply) =>
    noStore(reply).send(accounts ? { mode: "accounts", publicOrigin: accounts.config.publicOrigin } : { mode: "ip" }));

  app.post<{ Body: unknown }>("/v1/auth/login", { bodyLimit: LOGIN_BODY_LIMIT, ...requirePermission("auth:login") }, async (request, reply) => {
    noStore(reply);
    if (!accounts) return reply.code(404).send(NOT_ENABLED_BODY);
    if (!csrfAllowed(request.headers, accounts.config.trustedOrigins)) return reply.code(403).send(CSRF_BODY);
    const body = request.body as { name?: unknown; password?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!name || !password || password.length > PASSWORD_MAX_LENGTH * 2) {
      return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "需要 name 与 password" });
    }
    const keys = [`ip:${request.clientIp}`, `name:${name}`];
    const at = now();
    const wait = Math.max(...keys.map(key => backoff.retryAfterSeconds(key, at)));
    if (wait > 0) {
      return reply.code(429).header("retry-after", String(wait)).send({ statusCode: 429, error: "Too Many Requests", code: "login_backoff", message: "尝试太频繁，请稍后再试" });
    }
    // A password outside the allowed length can never match; it fails without scrypt but counts the same.
    let result: Awaited<ReturnType<AuthService["login"]>> = null;
    if (passwordLengthOk(password)) {
      const release = gate.tryAcquire();
      if (!release) {
        return reply.code(429).header("retry-after", "1").send({ statusCode: 429, error: "Too Many Requests", code: "login_busy", message: "登录请求太多，请稍后重试" });
      }
      try {
        result = await accounts.auth.login(name, password, request.headers["user-agent"]);
      } finally {
        release();
      }
    }
    if (!result) {
      for (const key of keys) backoff.recordFailure(key, now());
      request.log.info({ auth: "login-failed" }, "login failed");
      return reply.code(401).send(INVALID_CREDENTIALS_BODY);
    }
    for (const key of keys) backoff.clear(key);
    request.log.info({ auth: "login" }, "login succeeded");
    return reply
      .header("set-cookie", sessionCookie(accounts.config, result.sessionToken, cookieMaxAge(result.session)))
      .send({ account: accountView(result.account) });
  });

  app.post("/v1/auth/logout", requirePermission("auth:self"), async (request, reply) => {
    noStore(reply);
    if (!accounts) return reply.code(404).send(NOT_ENABLED_BODY);
    const sessionId = request.authContext?.sessionId;
    if (sessionId) await accounts.auth.logout(sessionId);
    return reply.code(204).header("set-cookie", sessionCookie(accounts.config, "", 0)).send();
  });

  app.get("/v1/auth/me", { exposeHeadRoute: false, ...requirePermission("auth:self") }, async (request, reply) => {
    noStore(reply);
    if (!accounts || !request.authContext) return reply.code(404).send(NOT_ENABLED_BODY);
    return reply.send({ account: accountView(request.authContext.account), via: request.authContext.via });
  });

  app.put<{ Body: unknown }>("/v1/auth/password", { bodyLimit: LOGIN_BODY_LIMIT, ...requirePermission("auth:self") }, async (request, reply) => {
    noStore(reply);
    if (!accounts || !request.authContext) return reply.code(404).send(NOT_ENABLED_BODY);
    if (request.authContext.via !== "cookie") {
      return reply.code(403).send({ statusCode: 403, error: "Forbidden", code: "cookie_required", message: "改密码需要在浏览器里登录后操作" });
    }
    const body = request.body as { current?: unknown; next?: unknown } | null;
    const current = typeof body?.current === "string" ? body.current : "";
    const next = typeof body?.next === "string" ? body.next : "";
    if (!current || !next || current.length > PASSWORD_MAX_LENGTH * 2 || next.length > PASSWORD_MAX_LENGTH * 2) {
      return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: "需要 current 与 next" });
    }
    const key = `name:${request.authContext.account.name}`;
    const wait = backoff.retryAfterSeconds(key, now());
    if (wait > 0) {
      return reply.code(429).header("retry-after", String(wait)).send({ statusCode: 429, error: "Too Many Requests", code: "login_backoff", message: "尝试太频繁，请稍后再试" });
    }
    const release = gate.tryAcquire();
    if (!release) {
      return reply.code(429).header("retry-after", "1").send({ statusCode: 429, error: "Too Many Requests", code: "login_busy", message: "请求太多，请稍后重试" });
    }
    let result: Awaited<ReturnType<AuthService["changePassword"]>>;
    try {
      result = await accounts.auth.changePassword(request.authContext.account.id, current, next, request.headers["user-agent"]);
    } finally {
      release();
    }
    if (!result.ok) {
      if (result.reason === "invalid_current") {
        backoff.recordFailure(key, now());
        return reply.code(400).send({ statusCode: 400, error: "Bad Request", code: "invalid_current_password", message: "当前密码不对" });
      }
      return reply.code(400).send({ statusCode: 400, error: "Bad Request", code: "password_too_weak", message: "新密码长度必须在 12–256 个字符之间" });
    }
    backoff.clear(key);
    request.log.info({ auth: "password-changed" }, "password changed");
    return reply.code(204)
      .header("set-cookie", sessionCookie(accounts.config, result.sessionToken, cookieMaxAge(result.session)))
      .send();
  });
}

declare module "fastify" {
  interface FastifyRequest {
    /** Client IP from IP admission; used for login rate limits only, never logged. */
    clientIp: string;
    /** Set in accounts mode for an authenticated request. */
    authContext?: {
      readonly account: Authenticated["account"];
      readonly via: Authenticated["via"];
      readonly sessionId?: string;
      /** Re-runs the request's authentication; false when it no longer holds. */
      readonly recheck: () => Promise<boolean>;
    };
  }
}
