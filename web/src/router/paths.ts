import { generatePath, matchPath } from "react-router";

export const ROUTES = {
  home: "/",
  project: "/p/:projectId",
  session: "/p/:projectId/s/:sessionId",
  design: "/design",
} as const;

export function projectPath(projectId: string): string {
  return generatePath(ROUTES.project, { projectId });
}

export function sessionPath(projectId: string, sessionId: string): string {
  return generatePath(ROUTES.session, { projectId, sessionId });
}

/** The workspace location for a selection; a project without a session is its start screen. */
export function workspacePath(projectId: string | null, sessionId: string | null): string {
  if (!projectId) return ROUTES.home;
  return sessionId ? sessionPath(projectId, sessionId) : projectPath(projectId);
}

export type WorkspaceLocation = { projectId: string | null; sessionId: string | null };

function decodeParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parses an encoded `location.pathname`; `matchPath` itself leaves params encoded. */
export function parseWorkspacePath(pathname: string): WorkspaceLocation {
  const session = matchPath(ROUTES.session, pathname);
  if (session) return { projectId: decodeParam(session.params.projectId), sessionId: decodeParam(session.params.sessionId) };
  const project = matchPath(ROUTES.project, pathname);
  if (project) return { projectId: decodeParam(project.params.projectId), sessionId: null };
  return { projectId: null, sessionId: null };
}
