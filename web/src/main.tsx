import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import App from "./App.js";
import { I18nProvider } from "./i18n/index.js";
import { createAppRouter } from "./router/router.js";
import "./ui/styles/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("未找到 #root 挂载点");

// `<App />` stays literal here: vite.performance.config.ts wraps it in a Profiler by source rewrite.
const router = createAppRouter(<App />);

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <RouterProvider router={router} />
    </I18nProvider>
  </StrictMode>,
);
