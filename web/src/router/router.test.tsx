import { useEffect, useRef } from "react";
import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router";
import { parseWorkspacePath, projectPath, sessionPath, workspacePath } from "./paths.js";
import { appRoutes, useWorkspaceLocation } from "./router.js";

describe("workspace paths", () => {
  it("builds and parses project/session URLs", () => {
    expect(projectPath("p1")).toBe("/p/p1");
    expect(sessionPath("p1", "s 1")).toBe("/p/p1/s/s%201");
    expect(workspacePath(null, "s1")).toBe("/");
    expect(workspacePath("p1", null)).toBe("/p/p1");
    expect(parseWorkspacePath("/p/p1/s/s%201")).toEqual({ projectId: "p1", sessionId: "s 1" });
    expect(parseWorkspacePath("/p/p1")).toEqual({ projectId: "p1", sessionId: null });
    expect(parseWorkspacePath("/elsewhere")).toEqual({ projectId: null, sessionId: null });
  });

  it("keeps the workspace mounted across workspace URLs", async () => {
    let mounts = 0;
    let go: (to: string) => void = () => {};
    function Workspace() {
      const location = useWorkspaceLocation();
      const navigate = useNavigate();
      const counted = useRef(false);
      useEffect(() => {
        go = navigate;
        if (!counted.current) { counted.current = true; mounts += 1; }
      }, [navigate]);
      return <span data-testid="where">{`${location.projectId}/${location.sessionId}`}</span>;
    }
    const router = createMemoryRouter(appRoutes(<Workspace />), { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    expect(screen.getByTestId("where")).toHaveTextContent("null/null");
    await act(async () => go("/p/a"));
    expect(screen.getByTestId("where")).toHaveTextContent("a/null");
    await act(async () => go("/p/a/s/b"));
    expect(screen.getByTestId("where")).toHaveTextContent("a/b");
    await act(async () => go("/unknown/path"));
    expect(screen.getByTestId("where")).toHaveTextContent("null/null");
    expect(mounts).toBe(1);
  });
});
