export type Route = { projectId: string; sessionId: string | null };
export type RouteInput = Route | "root" | "invalid";

export function readRoute(): RouteInput {
  if (window.location.pathname === "/") return "root";
  const match = /^\/p\/([^/]+)(?:\/s\/([^/]+))?\/?$/.exec(window.location.pathname);
  if (!match) return "invalid";
  try {
    const projectId = decodeURIComponent(match[1]);
    const sessionId = match[2] === undefined ? null : decodeURIComponent(match[2]);
    if (!projectId || sessionId === "" || /[\u0000-\u001f\u007f]/.test(projectId + (sessionId ?? ""))) return "invalid";
    return { projectId, sessionId };
  } catch { return "invalid"; }
}

export function writeRoute(route: Route | null, mode: "push" | "replace"): void {
  const path = route ? `/p/${encodeURIComponent(route.projectId)}${route.sessionId === null ? "" : `/s/${encodeURIComponent(route.sessionId)}`}` : "/";
  if (window.location.pathname + window.location.search + window.location.hash === path) return;
  window.history[mode === "push" ? "pushState" : "replaceState"](null, "", path);
}

export function listenRoute(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
