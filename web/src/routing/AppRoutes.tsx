import { Route, Routes } from "react-router-dom";
import App from "../App.js";

/** Session URLs: /p/:projectId/s/:sessionId (project-only: /p/:projectId). Root keeps legacy entry. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<App />} />
      <Route path="/p/:projectId" element={<App />} />
      <Route path="/p/:projectId/s/:sessionId" element={<App />} />
    </Routes>
  );
}
