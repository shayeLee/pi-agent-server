import { zhCN } from "./i18n/zh-CN.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { captureMcpOAuthReturn } from "./mcp-oauth-return.js";
import "./styles/fonts.css";
import "./styles.css";
import "./styles/ui.css";

// 在路由读取地址之前处理 MCP 授权返回的参数。
captureMcpOAuthReturn();

const root = document.getElementById("root");
if (!root) throw new Error(zhCN.toolParameters.missingRoot);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);