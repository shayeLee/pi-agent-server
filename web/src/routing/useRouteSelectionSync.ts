import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";

type SelectionController = {
  activeProjectId: string | null;
  activeSessionId: string | null;
  projects: ReadonlyArray<{ id: string }> | null;
  sessions: ReadonlyArray<{ id: string; projectId: string }> | null;
  selectProject: (projectId: string) => void;
  selectSession: (sessionId: string | null) => void;
};

/** Minimal bidirectional sync: deep links apply after lists load; user navigation updates the URL. */
export function useRouteSelectionSync(controller: SelectionController): void {
  const { projectId: routeProjectId, sessionId: routeSessionId } = useParams();
  const navigate = useNavigate();
  const appliedRouteRef = useRef<string | null>(null);
  const suppressUrlPushRef = useRef(false);

  useEffect(() => {
    if (!routeProjectId) return;
    const routeKey = `${routeProjectId}:${routeSessionId ?? ""}`;
    if (appliedRouteRef.current === routeKey) return;
    if (!controller.projects?.some((project) => project.id === routeProjectId)) return;

    suppressUrlPushRef.current = true;
    if (controller.activeProjectId !== routeProjectId) {
      controller.selectProject(routeProjectId);
    }
    if (routeSessionId) {
      if (!controller.sessions?.some((session) => session.id === routeSessionId)) return;
      if (controller.activeSessionId !== routeSessionId) {
        controller.selectSession(routeSessionId);
      }
    }
    appliedRouteRef.current = routeKey;
    suppressUrlPushRef.current = false;
  }, [
    routeProjectId,
    routeSessionId,
    controller.projects,
    controller.sessions,
    controller.activeProjectId,
    controller.activeSessionId,
    controller.selectProject,
    controller.selectSession,
  ]);

  useEffect(() => {
    if (suppressUrlPushRef.current || !controller.activeProjectId) return;
    const target = controller.activeSessionId
      ? `/p/${controller.activeProjectId}/s/${controller.activeSessionId}`
      : `/p/${controller.activeProjectId}`;
    const currentPath = window.location.pathname;
    if (currentPath === target || currentPath === `${target}/`) return;
    // Keep `/` until the user picks a project when landing without a deep link.
    if (!routeProjectId && currentPath === "/") return;
    navigate(target, { replace: true });
  }, [
    controller.activeProjectId,
    controller.activeSessionId,
    navigate,
    routeProjectId,
  ]);
}
