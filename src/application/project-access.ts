import { DEFAULT_PROJECT_ID, type ProjectStorePort, type SessionStorePort } from "./ports/index.js";
import type { NativeSessionPort } from "./ports/native-session-port.js";

/** Creation/upload access only; never authorizes project mutation or another actor's files. */
export async function getProjectAccess(
  projects: ProjectStorePort, sessions: SessionStorePort | undefined,
  native: NativeSessionPort | undefined, ownerKey: string, projectId: string,
) {
  const project = await projects.get(projectId);
  if (!project) return null;
  if (projectId === DEFAULT_PROJECT_ID || project.ownerKey === ownerKey) return project;
  for (const session of await sessions?.listByProject(ownerKey, projectId) ?? []) {
    if (session.visibility === "shared" || session.origin === "native") {
      if (await native?.allows(session)) return project;
    } else if (session.ownerKey === ownerKey) return project;
  }
  return null;
}
