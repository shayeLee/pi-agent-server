import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/dm-sans";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { AppRoutes } from "./routing/AppRoutes.js";
import { I18nProvider } from "./i18n/I18nProvider.js";
import "./styles/globals.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("未找到 #root 挂载点");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <AppRoutes />
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
);