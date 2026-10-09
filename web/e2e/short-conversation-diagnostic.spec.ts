import { mkdir, writeFile } from "node:fs/promises";
import { test, expect, type Page, type Route } from "@playwright/test";

// Reading-first 短会话真实 UI 核验（DESIGN.md §2–§7）。
// 来源：page 路由 fixture，仅使用专用端口（5191），绝不连接 live 8080/5173 或真实模型。
// 验收点：用户自然宽轻底右对齐；助手无卡片左对齐；无固定来源槽/横带/反相；
// 760px 阅读列与 Composer 同轴；Composer 走文档流不被遮挡；提交业务链路保持原样。

const projectId = "short-fixture-project";
const sessionId = "short-fixture-session";
const userText = "Hi";
const assistantText = "Hi! What can I help you with?";
const session = {
  id: sessionId,
  ownerKey: "local-fixture",
  projectId,
  title: "关于跨平台服务部署与长时间运行会话的完整设计讨论及后续实施计划仍需持续跟进",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  systemPrompt: null,
};

async function installLocalFixtures(page: Page, submittedPrompts: string[]): Promise<void> {
  let acceptMessage!: () => void;
  const messageAccepted = new Promise<void>((resolve) => { acceptMessage = resolve; });
  let sseDelivered = false;

  await page.route("**/v1/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = (body: unknown) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (method === "GET" && url.pathname === "/v1/access") {
      return json({ canRead: true, canWrite: true });
    }
    if (method === "GET" && url.pathname === "/v1/projects") {
      return json([{ id: projectId, name: "Local fixture", cwd: "/tmp", isDefault: true }]);
    }
    if (method === "GET" && url.pathname === "/v1/models") {
      return json({ models: [], thinkingLevels: [], defaultModel: null, defaultThinkingLevel: "" });
    }
    if (method === "GET" && url.pathname === "/v1/sessions" && url.searchParams.has("projectId")) {
      return json([]);
    }
    if (method === "POST" && url.pathname === "/v1/sessions") {
      return json(session);
    }
    if (method === "POST" && url.pathname === `/v1/sessions/${sessionId}/messages`) {
      const payload = request.postDataJSON() as { prompt?: unknown };
      submittedPrompts.push(String(payload.prompt ?? ""));
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: true }) });
      acceptMessage();
      return;
    }
    if (method === "GET" && url.pathname === `/v1/sessions/${sessionId}/events`) {
      if (sseDelivered) return route.fulfill({ status: 204 });
      await messageAccepted;
      sseDelivered = true;
      const frames = [
        { id: 1, event: { type: "text_delta", text: assistantText } },
        { id: 2, event: { type: "completed" } },
      ];
      const body = frames.map(({ id, event }) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return route.fulfill({ status: 200, contentType: "text/event-stream", body });
    }

    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "unmocked local fixture route" }) });
  });
}

const viewports = [
  { width: 1280, height: 800 },
  { width: 1235, height: 390 },
  { width: 2470, height: 780 },
  { width: 390, height: 844 },
];

const themes = ["dark", "light"] as const;

for (const viewport of viewports) {
  for (const theme of themes) {
    test(`reading-first short conversation @ ${viewport.width}x${viewport.height} / ${theme}`, async ({ page }) => {
      const submittedPrompts: string[] = [];
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await installLocalFixtures(page, submittedPrompts);
      await page.goto("/");

      // App theme starts from the emulated system preference.
      await expect(page.getByTestId("app")).toHaveAttribute("data-theme", theme);

      await expect(page.getByTestId("composer")).toBeVisible();
      await page.getByTestId("composer-input").fill(userText);
      await page.getByTestId("send-button").click();

      await expect(page.locator(".row-user .user-bubble")).toHaveText(userText);
      await expect(page.locator(".row-assistant .assistant-content")).toContainText(assistantText);
      await expect(page.getByTestId("message-list").locator(":scope > *")).toHaveCount(2);
      await expect(page.locator(".thinking-row, .tool-call")).toHaveCount(0);
      await expect(page.getByTestId("inspector")).toHaveCount(0);

      // 业务链路：显式首发创建会话并提交快照原文。
      expect(submittedPrompts).toEqual([userText]);

      const state = await page.evaluate(() => {
        const app = document.querySelector<HTMLElement>(".app-shell")!;
        const style = getComputedStyle(app);
        const row = document.querySelector<HTMLElement>(".timeline > .row-user")!;
        const bubble = row.querySelector<HTMLElement>(".user-bubble")!;
        const modelRow = document.querySelector<HTMLElement>(".timeline > .row-assistant")!;
        const modelBody = modelRow.querySelector<HTMLElement>(".assistant-content")!;
        const modelRowRect = modelRow.getBoundingClientRect();
        const chatBody = document.querySelector<HTMLElement>("[data-testid=chat-body]")!;
        const inner = document.querySelector<HTMLElement>(".chat-inner")!;
        const composer = document.querySelector<HTMLElement>("[data-testid=composer]")!;
        const footer = document.querySelector<HTMLElement>(".chat-footer")!;
        const rowRect = row.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();
        const innerRect = inner.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        const token = (name: string) => style.getPropertyValue(name).trim();
        // 将 CSS 变量解析为计算后的 rgb 色值（避免 hex/rgb 字面量不一致）。
        const tokenRgb = (name: string) => {
          const probe = document.createElement("div");
          probe.style.color = `var(${name})`;
          app.appendChild(probe);
          const rgb = getComputedStyle(probe).color;
          probe.remove();
          return rgb;
        };
        return {
          // 来源槽与 Crossband 几何已废除
          bandSourceCount: document.querySelectorAll(".timeline .band-source").length,
          legacyLaneToken: token("--lane-width"),
          legacyInverseToken: token("--color-inverse-bg"),
          // Reading-first tokens
          readingMax: token("--reading-max"),
          // 用户：自然宽 + 右对齐 + 轻底（非反相）
          bubbleWidth: bubbleRect.width,
          rowWidth: rowRect.width,
          bubbleRightDistance: Math.abs(rowRect.right - bubbleRect.right),
          bubbleBackground: getComputedStyle(bubble).backgroundColor,
          bubbleColor: getComputedStyle(bubble).color,
          rowBackground: getComputedStyle(row).backgroundColor,
          raisedBackground: tokenRgb("--bg-raised"),
          textPrimary: tokenRgb("--text-primary"),
          // 助手：无卡片（透明底，直接落在页面底色），左对齐于阅读列
          assistantBackground: getComputedStyle(modelBody).backgroundColor,
          assistantLeftDistance: Math.abs(modelBody.getBoundingClientRect().left - modelRowRect.left),
          // 阅读列与 Composer 同轴同宽
          // 阅读列与 Composer 同轴
          innerBox: { left: innerRect.left, right: innerRect.right, width: innerRect.width },
          innerContent: {
            left: innerRect.left + parseFloat(getComputedStyle(inner).paddingLeft),
            right: innerRect.right - parseFloat(getComputedStyle(inner).paddingRight),
          },
          composerRect: { left: composerRect.left, right: composerRect.right, width: composerRect.width },
          // Composer 文档流占位、可达且不被覆盖
          footerPosition: getComputedStyle(footer).position,
          footerVisible: footerRect.width > 0 && footerRect.height > 0 &&
            footerRect.top >= 0 && footerRect.bottom <= window.innerHeight + 1,
          bodyAboveFooter: chatBody.getBoundingClientRect().bottom <= footerRect.top + 1,
          composerHeight: composerRect.height,
          viewportHeight: window.innerHeight,
          // 顶锚留白（首条内容距 chat-body 顶部）
          transcriptTopGap: rowRect.top - chatBody.getBoundingClientRect().top + chatBody.scrollTop,
          debug: {
            rowDisplay: getComputedStyle(row).display,
            rowJustify: getComputedStyle(row).justifyContent,
            rowPaddingRight: getComputedStyle(row).paddingRight,
            userRect: (() => { const r = row.querySelector<HTMLElement>(".message-user")!.getBoundingClientRect(); return { left: r.left, right: r.right }; })(),
            timelineRect: (() => { const r = document.querySelector<HTMLElement>(".timeline")!.getBoundingClientRect(); return { left: r.left, right: r.right }; })(),
            innerRectFull: { left: innerRect.left, right: innerRect.right },
            innerPaddingRight: getComputedStyle(inner).paddingRight,
            chatBodyClientWidth: chatBody.clientWidth,
            chatBodyRectWidth: chatBody.getBoundingClientRect().width,
          },
          // 横向溢出
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          // 全视口外壳与阅读列上限
          shellWidth: app.getBoundingClientRect().width,
        };
      });

      console.log(`READING_DEBUG ${JSON.stringify({ viewport, theme, bubbleRightDistance: state.bubbleRightDistance, debug: state.debug })}`);

      expect(state.bandSourceCount).toBe(0);
      expect(state.legacyLaneToken).toBe("");
      expect(state.legacyInverseToken).toBe("");
      expect(state.readingMax).toBe("760px");

      // 用户气泡：自然宽度（远小于整行），右对齐于正文列，轻底色且文字为正文色——不是反相块。
      expect(state.bubbleWidth).toBeLessThan(state.rowWidth * 0.6);
      expect(state.bubbleRightDistance).toBeLessThanOrEqual(1);
      expect(state.bubbleBackground).toBe(state.raisedBackground);
      expect(state.bubbleColor).toBe(state.textPrimary);
      expect(state.rowBackground).toBe("rgba(0, 0, 0, 0)");

      // 助手：无卡片（正文背景透明），左对齐于阅读列。
      expect(state.assistantBackground).toBe("rgba(0, 0, 0, 0)");
      expect(state.assistantLeftDistance).toBeLessThanOrEqual(1);

      // 760px 阅读列与 Composer 同轴：阅读列触顶时盒子边缘对齐；未触顶（手机）时与内容边缘对齐。
      expect(state.composerRect.width).toBeLessThanOrEqual(760 + 1);
      if (state.innerBox.width >= 759.5) {
        expect(state.composerRect.left).toBeCloseTo(state.innerBox.left, 0.5);
        expect(state.composerRect.right).toBeCloseTo(state.innerBox.right, 0.5);
      } else {
        expect(state.composerRect.left).toBeCloseTo(state.innerContent.left, 0.5);
        expect(state.composerRect.right).toBeCloseTo(state.innerContent.right, 0.5);
      }
      // 中心轴始终一致
      const innerCenter = (state.innerBox.left + state.innerBox.right) / 2;
      const composerCenter = (state.composerRect.left + state.composerRect.right) / 2;
      expect(Math.abs(innerCenter - composerCenter)).toBeLessThanOrEqual(1);

      // Composer：正常文档流（static），完整可见，消息滚动区在 footer 之上结束。
      expect(state.footerPosition).toBe("static");
      expect(state.footerVisible).toBe(true);
      expect(state.bodyAboveFooter).toBe(true);

      // 短宽视口（≤480px 高）：Composer 不超过视口高度 40%。
      if (viewport.height <= 480) {
        expect(state.composerHeight).toBeLessThanOrEqual(viewport.height * 0.4 + 1);
      }

      // 顶锚留白：宽屏 24px；窄屏（≤640）与矮视口紧凑模式 16px。
      const expectedTopGap = viewport.height <= 480 || viewport.width <= 640 ? 16 : 24;
      expect(state.transcriptTopGap).toBeGreaterThanOrEqual(expectedTopGap);
      expect(state.transcriptTopGap).toBeLessThanOrEqual(expectedTopGap + 8);

      // 无横向滚动。
      expect(state.horizontalOverflow).toBe(false);

      // 外壳填满视口；阅读宽度与同轴断言独立保留。
      expect(state.shellWidth).toBeCloseTo(viewport.width, 0);

      await expect(page.getByTestId("composer")).toBeAttached();

      if (viewport.width === 390) {
        const headerTargets = await page.evaluate(() => {
          const title = document.querySelector<HTMLElement>("[data-testid=chat-session-title]")!.getBoundingClientRect();
          const selectors = ["[data-testid=chat-tab]", "[data-testid=trace-tab]", "[data-testid=toggle-events]"];
          const boxes = selectors.map((selector) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect());
          const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
          return {
            titleOverlapsControls: boxes.map((box) => overlaps(title, box)),
            controlsHit: selectors.map((selector) => {
              const button = document.querySelector<HTMLElement>(selector)!;
              const box = button.getBoundingClientRect();
              return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
            }),
            controlsInsideViewport: boxes.map((box) => box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight),
            horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        });
        expect(headerTargets.titleOverlapsControls).toEqual([false, false, false]);
        expect(headerTargets.controlsHit).toEqual([true, true, true]);
        expect(headerTargets.controlsInsideViewport).toEqual([true, true, true]);
        expect(headerTargets.horizontalOverflow).toBe(false);
      }

      // Refinement regression: title keeps useful space, actions never cover selection.
      const sessionSelect = page.getByTestId(`session-${sessionId}`);
      if (viewport.width >= 1180 && viewport.height > 480) {
        await sessionSelect.hover();
        const selectBox = await sessionSelect.boundingBox();
        const renameBox = await page.getByTestId(`rename-${sessionId}`).boundingBox();
        expect(selectBox!.width).toBeGreaterThan(140);
        expect(renameBox!.x).toBeGreaterThanOrEqual(selectBox!.x + selectBox!.width);
        await page.mouse.move(viewport.width - 1, 0);
      }
      await mkdir("/tmp/astra-ui-refine", { recursive: true });
      const screenshot = `/tmp/astra-ui-refine/short-${viewport.width}x${viewport.height}-${theme}.png`;
      await page.screenshot({ path: screenshot, animations: "disabled" });
      await writeFile(
        `/tmp/astra-ui-refine/short-${viewport.width}x${viewport.height}-${theme}.json`,
        `${JSON.stringify({ screenshot, ...state }, null, 2)}\n`,
      );
      console.log(`READING_SHORT_DIAGNOSTIC ${JSON.stringify({ viewport, theme, ...state })}`);
    });
  }
}
