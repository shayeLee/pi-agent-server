import { zhCN } from "./i18n/zh-CN.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles/fonts.css";
import "./styles.css";
import "./styles/ui.css";

const root = document.getElementById("root");
if (!root) throw new Error(zhCN.toolParameters.missingRoot);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);