import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles.css";

// 主题跟随系统，后续可扩展手动切换
const mql = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme(dark: boolean): void {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}
applyTheme(mql.matches);
mql.addEventListener("change", (e) => applyTheme(e.matches));

const root = document.getElementById("root");
if (!root) throw new Error("未找到 #root 挂载点");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);