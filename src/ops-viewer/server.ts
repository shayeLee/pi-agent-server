import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { createViewerData } from "./data.js";

type Data = ReturnType<typeof createViewerData>;
function send(reply: ServerResponse, status: number, value: unknown): void {
  reply.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  reply.end(JSON.stringify(value));
}

/** Separate, read-only ops listener. Never mounts on the public/owner-scoped agent API. */
export function createViewerServer(data: Data, assetsDir = path.resolve(process.cwd(), "web/dist-ops-viewer")): Server {
  return createServer(async (request, reply) => {
    reply.setHeader("X-Frame-Options", "DENY");
    reply.setHeader("Referrer-Policy", "no-referrer");
    reply.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    try {
      if (request.method !== "GET") { send(reply, 405, { error: "只允许读取" }); return; }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/" || /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(url.pathname)) {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const contentType = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
        const body = readFileSync(path.join(assetsDir, file));
        reply.writeHead(200, { "Content-Type": `${contentType}; charset=utf-8`, "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'", "X-Content-Type-Options": "nosniff" });
        reply.end(body);
      } else if (url.pathname === "/api/ips") {
        send(reply, 200, { ips: data.listIps() });
      } else if (url.pathname === "/api/sessions") {
        const ip = url.searchParams.get("ip");
        const rawOffset = url.searchParams.get("offset") ?? "0";
        if (!ip || ip.length > 100 || !/^(0|[1-9]\d{0,6})$/.test(rawOffset)) { send(reply, 400, { error: "无效参数" }); return; }
        send(reply, 200, data.listSessions(ip, Number(rawOffset)));
      } else if (/^\/api\/sessions\/[0-9a-fA-F-]{36}$/.test(url.pathname)) {
        const result = await data.getSession(url.pathname.slice("/api/sessions/".length));
        send(reply, result ? 200 : 404, result ?? { error: "会话不存在" });
      } else { send(reply, 404, { error: "未找到" }); }
    } catch {
      // The UI is deliberately cross-IP: never leak raw disk paths, prompts or DB exceptions.
      send(reply, 503, { error: "会话内容暂时不可读取" });
    }
  });
}
