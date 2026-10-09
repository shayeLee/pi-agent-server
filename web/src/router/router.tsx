import { lazy, Suspense, type ReactElement } from "react";
import { createBrowserRouter, useLocation, type RouteObject } from "react-router";
import { ROUTES, parseWorkspacePath, type WorkspaceLocation } from "./paths.js";

const DesignSystemPage = lazy(() => import("../design/DesignSystemPage.js"));

/**
 * Workspace routes share one layout route so the app stays mounted (and keeps its
 * controller state) while moving between `/`, `/p/:projectId` and `/p/:projectId/s/:sessionId`.
 */
export function appRoutes(workspace: ReactElement): RouteObject[] {
  return [
    {
      element: workspace,
      children: [
        { path: ROUTES.home },
        { path: ROUTES.project },
        { path: ROUTES.session },
        { path: "*" },
      ],
    },
    {
      path: ROUTES.design,
      element: <Suspense fallback={null}><DesignSystemPage /></Suspense>,
    },
  ];
}

export function createAppRouter(workspace: ReactElement) {
  return createBrowserRouter(appRoutes(workspace));
}

export function useWorkspaceLocation(): WorkspaceLocation {
  return parseWorkspacePath(useLocation().pathname);
}
