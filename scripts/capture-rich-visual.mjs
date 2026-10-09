import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import { chromium } from "../web/node_modules/@playwright/test/index.mjs";
import { mkdirSync } from "fs";
import { resolve } from "path";

async function main() {
  const port = 5198;
  const outDir = resolve(process.cwd(), "docs/screenshots/rich-content");
  mkdirSync(outDir, { recursive: true });

  const server = await createServer({
    root: resolve(process.cwd(), "web"),
    server: { port, strictPort: true },
  });
  await server.listen();
  console.log(`Vite running on http://127.0.0.1:${port}`);

  const browser = await chromium.launch({
    channel: "chrome", // 系统 Chrome
    headless: true,
  });

  const viewports = [
    { name: "desktop", width: 1280, height: 1024 },
    { name: "mobile", width: 390, height: 844 },
  ];

  const themes = ["light", "dark"];

  for (const vp of viewports) {
    for (const theme of themes) {
      const page = await browser.newPage({
        viewport: { width: vp.width, height: vp.height },
      });

      const url = `http://127.0.0.1:${port}/visual-fixtures/rich.html?theme=${theme}`;
      await page.goto(url, { waitUntil: "networkidle" });

      // 展开 thinking
      const thinkingBtn = page.getByTestId("thinking-thinking-fixture").getByRole("button");
      await thinkingBtn.click();

      // 展开所有 tool-call-card
      const toolCards = await page.getByTestId("tool-call-card").all();
      for (const card of toolCards) {
        await card.getByRole("button").click();
      }

      // 展开 event-3 (tool_end with long stack/error)
      const event3 = page.getByTestId("event-3").locator("summary");
      await event3.click();

      // 展开 event-2
      const event2 = page.getByTestId("event-2").locator("summary");
      await event2.click();

      await page.waitForTimeout(300);

      const shotPath = resolve(outDir, `rich-${theme}-${vp.name}.png`);
      await page.screenshot({ path: shotPath, fullPage: true });
      console.log(`Captured: ${shotPath}`);

      await page.close();
    }
  }

  await browser.close();
  await server.close();
  console.log("Visual verification complete!");
}

main().catch((err) => {
  console.error("Visual capture failed:", err);
  process.exit(1);
});
