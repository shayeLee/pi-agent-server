import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const evidenceDir = "/tmp/rich-arrow-regression-fix";
async function recordArrowState(header: import("@playwright/test").Locator, name: string) {
  const state = await header.evaluate((element) => ({
    activeElement: document.activeElement?.className, focused: element === document.activeElement,
    focusVisible: element.matches(":focus-visible"), hovered: element.matches(":hover"),
    fineHover: matchMedia("(hover: hover) and (pointer: fine)").matches,
    coarse: matchMedia("(pointer: coarse)").matches, noHover: matchMedia("(hover: none)").matches,
    opacity: getComputedStyle(element.querySelector(".thinking-chevron")!).opacity,
    transition: getComputedStyle(element.querySelector(".thinking-chevron")!).transition,
  }));
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(`${evidenceDir}/${name}.json`, JSON.stringify(state, null, 2));
  console.log("thinking-arrow-state", name, JSON.stringify(state));
  return state;
}

// Run separately with MOCK_SCENARIO=rich; never points at an existing production service.
test.skip(process.env.MOCK_SCENARIO !== "rich", "Requires the isolated rich mock scenario");

async function expectFullyReadableInTranscript(page: import("@playwright/test").Page, locator: import("@playwright/test").Locator) {
  const fullyVisible = await locator.evaluate((element) => {
    const body = element.closest<HTMLElement>(".chat-body");
    const footer = document.querySelector<HTMLElement>(".chat-footer");
    if (!body || !footer) return false;
    const rect = element.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const visibleBottom = Math.min(bodyRect.bottom, footerRect.top, window.innerHeight);
    if (rect.width <= 0 || rect.height <= 0 || rect.top < Math.max(bodyRect.top, 0) ||
        rect.bottom > visibleBottom || rect.left < Math.max(bodyRect.left, 0) ||
        rect.right > Math.min(bodyRect.right, window.innerWidth)) return false;
    for (let parent = element.parentElement; parent && parent !== body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX) && (rect.left < bounds.left || rect.right > bounds.right)) return false;
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY) && (rect.top < bounds.top || rect.bottom > bounds.bottom)) return false;
    }
    return true;
  });
  expect(fullyVisible, "内容必须完整处于聊天可视区，不能只存在于 DOM").toBe(true);
}

async function expectToolHeaderContentVerticallyCentered(card: import("@playwright/test").Locator) {
  const centers = await card.locator(".tool-call-header, .tool-name, .tool-status-icon, .tool-toggle").evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top + rect.height / 2;
    }),
  );
  expect(centers).toHaveLength(4); // header, name, SVG status, chevron
  for (const centerY of centers.slice(1)) {
    expect(Math.abs(centerY - centers[0]), "工具名称、SVG 状态与展开控件应和 header 垂直居中").toBeLessThanOrEqual(0.75);
  }
}

async function expectThinkingContentVerticallyCentered(thinking: import("@playwright/test").Locator, includePreview: boolean) {
  const geometry = await thinking.locator(".thinking-header").evaluate((header) => {
    const arrow = header.querySelector<SVGElement>(".thinking-chevron")!.getBoundingClientRect();
    const label = header.querySelector<HTMLElement>(".thinking-label")!.getBoundingClientRect();
    const preview = header.querySelector<HTMLElement>(".thinking-summary");
    const previewRect = preview?.getBoundingClientRect();
    const original = preview?.textContent;
    if (preview) preview.textContent = "短";
    const shortArrow = header.querySelector<SVGElement>(".thinking-chevron")!.getBoundingClientRect();
    const shortPreviewRight = header.querySelector<HTMLElement>(".thinking-summary")?.getBoundingClientRect().right ?? label.right;
    if (preview && original !== undefined) preview.textContent = original;
    return {
      centers: [arrow, label, ...(previewRect ? [previewRect] : [])].map((rect) => rect.top + rect.height / 2),
      arrowLeft: arrow.left,
      contentRight: previewRect?.right ?? label.right,
      shortArrowLeft: shortArrow.left,
      shortContentRight: shortPreviewRight,
      headerRight: header.getBoundingClientRect().right,
    };
  });
  expect(geometry.centers).toHaveLength(includePreview ? 3 : 2);
  for (const centerY of geometry.centers.slice(1)) {
    expect(Math.abs(centerY - geometry.centers[0]), "实际 SVG box、思考标签与预览应垂直同轴").toBeLessThanOrEqual(0.75);
  }
  expect(geometry.arrowLeft, "箭头应紧跟预览或思考标签").toBeGreaterThanOrEqual(geometry.contentRight - 0.5);
  if (includePreview) {
    expect(geometry.shortArrowLeft, "短预览时箭头应紧跟文本而非贴聊天区右缘").toBeGreaterThanOrEqual(geometry.shortContentRight - 0.5);
    expect(geometry.headerRight - geometry.shortArrowLeft, "短预览时箭头不应被推到整行最右侧").toBeGreaterThan(24);
  }
}

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`完整应用富内容：${theme} / ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
      // The real app UI renders model metadata; this local visual fixture supplies a
      // deliberately long identifier without selecting a paid provider.
      await page.route("**/v1/models", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        models: [{ provider: "fixture", id: "crossband/very-long-model-id-for-visual-qa", name: "Local visual model" }],
        defaultModel: { provider: "fixture", id: "crossband/very-long-model-id-for-visual-qa", name: "Local visual model" },
        thinkingLevels: ["off", "medium"], defaultThinkingLevel: "medium",
      }) }));
      await page.goto("/");
      await expect(page.getByTestId("new-session")).toBeAttached();
      if (width === 390) await page.getByRole("button", { name: "打开工作区导航" }).click();
      await expect(page.getByTestId("app")).toHaveAttribute("data-theme", theme);
      await page.getByTestId("new-session").click();
      await page.getByTestId("composer-input").fill("请分析错误路径并运行测试");
      await page.getByTestId("send-button").click();

      const timeline = page.getByTestId("message-list");
      await expect(page.getByTestId("tool-call-card")).toHaveCount(2);
      await expect(timeline).toContainText("已定位问题");
      const orderedKinds = await timeline.locator(":scope > *").evaluateAll((elements) => elements.map((element) => {
        if (element.classList.contains("row-user")) return "user";
        if (element.classList.contains("thinking-row")) return "thinking";
        if (element.classList.contains("tool-call")) return element.getAttribute("data-tool-call-id");
        if (element.classList.contains("row-assistant")) return "assistant";
        return "unknown";
      }));
      expect(orderedKinds).toEqual(["user", "thinking", "visual-read", "visual-test", "assistant"]);

      const userMessage = timeline.locator(":scope > .row-user");
      const answer = timeline.locator(":scope > .row-assistant").last();
      const thinking = page.locator('[data-testid^="thinking-"]').first();
      const successfulTool = page.getByTestId("tool-call-card").first();
      const failedTool = page.getByTestId("tool-call-card").nth(1);
      // The legacy rich mock returns { stderr }, not standard content.text.
      // Structured envelopes are readable verbatim and also available as raw data.
      const failedResult = failedTool.getByRole("dialog").locator("pre");
      await expect(userMessage).toContainText("请分析错误路径并运行测试");
      // Reading-first：固定来源槽及其标签已废除，消息行不携带槽位文本。
      await expect(timeline.locator(".band-source")).toHaveCount(0);
      await expect(answer).toContainText("已定位问题");
      const answerCode = answer.locator("pre code").first();
      await expect(answerCode).toContainText("if (!created) return { accepted: false, draft };");
      const answerCodeBlock = answer.locator("pre").first();
      expect(await answerCodeBlock.evaluate((element) => element.clientWidth > 0 && (
        element.scrollWidth <= element.clientWidth + 1 ||
        /(auto|scroll)/.test(getComputedStyle(element).overflowX))),
        "窄屏代码正文必须可读：要么完整容纳，要么在代码块内部横向滚动，不得裁切丢失").toBe(true);
      await expect(thinking.getByRole("button")).toHaveAttribute("aria-expanded", "false");
      await expect(thinking.locator(".thinking-label")).toHaveCSS("white-space", "nowrap");
      await expectThinkingContentVerticallyCentered(thinking, false);
      await thinking.scrollIntoViewIfNeeded();
      await thinking.screenshot({ path: `${evidenceDir}/collapsed-${theme}-${width}.png`, animations: "disabled" });
      await expect(thinking.locator(".thinking-summary")).toHaveCount(0);
      for (const card of [successfulTool, failedTool]) {
        await expect(card.locator(".tool-call-header")).toHaveAttribute("aria-expanded", "false");
        await card.locator(".tool-call-header").click();
      }
      await expect(successfulTool.locator(".tool-call-header")).toHaveAttribute("aria-expanded", "true");
      await expect(failedTool.locator(".tool-call-header")).toHaveAttribute("aria-expanded", "true");
      await expect(failedTool.getByRole("img", { name: "失败" })).toBeVisible();
      await expect(failedTool).toContainText("Error: expected retry to preserve draft");
      await expect(successfulTool.getByTestId("tool-result-text")).toContainText("缺少错误分支的断言");
      await expectToolHeaderContentVerticallyCentered(successfulTool);
      await expectToolHeaderContentVerticallyCentered(failedTool);
      await expect(page.getByTestId("inspector")).toHaveCount(0);

      // Expanded tools need separate real scroll positions for prompt and answer.
      const chatBody = page.getByTestId("chat-body");
      {
        await chatBody.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await expectFullyReadableInTranscript(page, answer);
        await page.screenshot({ path: testInfo.outputPath(`app-rich-default-answer-${theme}-${width}.png`), animations: "disabled" });
        await userMessage.evaluate(element => element.scrollIntoView({ block: "center" }));
        await expectFullyReadableInTranscript(page, userMessage);
        await page.screenshot({ path: testInfo.outputPath(`app-rich-default-prompt-${theme}-${width}.png`), animations: "disabled" });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);

      // Failure details are auto-open and independently captured at a readable scroll position.
      await failedTool.getByRole("button", { name: "工具更多操作" }).click();
      await failedTool.getByRole("menuitem", { name: "查看原始数据" }).click();
      // Center explicitly: nearest-edge scrolling rounds fractional CSS pixels and can
      // leave 0.4px outside the transcript after typography/layout changes.
      await failedResult.evaluate(el => el.scrollIntoView({ block: "center" }));
      await expect(failedTool.getByRole("dialog")).toBeVisible();
      await expect(failedResult).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`app-rich-failure-${theme}-${width}.png`), animations: "disabled" });

      await page.keyboard.press("Escape");
      // Expanded-state proof is separate from the default answer view: thinking and
      // successful tool raw input/output are available without any summary substitution.
      await thinking.getByRole("button").click();
      await expectThinkingContentVerticallyCentered(thinking, false); // Expanded header retains the label, without the retired preview.
      await thinking.scrollIntoViewIfNeeded();
      await thinking.screenshot({ path: `${evidenceDir}/expanded-${theme}-${width}.png`, animations: "disabled" });
      const thinkingBody = thinking.getByTestId(/thinking-body-/);
      await expect(thinkingBody).toContainText("需要核对错误边界");
      await thinkingBody.scrollIntoViewIfNeeded();
      await expectFullyReadableInTranscript(page, thinkingBody);
      const thinkingLabel = thinking.locator(".thinking-label");
      expect(await thinkingLabel.evaluate((element) => element.getBoundingClientRect().width > 12 &&
        getComputedStyle(element).whiteSpace === "nowrap")).toBe(true);
      await expect(successfulTool).toContainText("/workspace/src/application/very-long-directory/agent-runtime.ts");
      await expect(successfulTool).toContainText("缺少错误分支的断言");
      await successfulTool.getByRole("button", { name: "工具更多操作" }).click();
      await successfulTool.getByRole("menuitem", { name: "查看原始数据" }).click();
      await expect(successfulTool.getByRole("dialog")).toBeVisible();
      await expect(successfulTool.getByRole("dialog").locator("pre")).toContainText('"args"');
      await expect(successfulTool.getByRole("dialog").locator("pre")).toContainText('"result"');
      await page.keyboard.press("Escape");
      const successfulArgs = successfulTool.locator(".tool-parameters");
      await successfulArgs.scrollIntoViewIfNeeded();
      await expectFullyReadableInTranscript(page, successfulArgs);
      const successfulResult = successfulTool.getByTestId("tool-result-text");
      await successfulResult.evaluate(el => el.scrollIntoView({ block: "center" }));
      await expectFullyReadableInTranscript(page, successfulResult);
      await page.screenshot({ path: testInfo.outputPath(`app-rich-expanded-${theme}-${width}.png`), animations: "disabled" });
      // The transcript, not a hidden nested pre, is the keyboard scroll surface.
      const transcript = page.getByTestId("chat-body");
      const scrollable = await transcript.evaluate((element) => {
        element.scrollTop = 0;
        return element.scrollHeight > element.clientHeight;
      });
      if (scrollable) {
        await transcript.focus();
        const focusStyle = await transcript.evaluate((element) => {
          const style = getComputedStyle(element);
          return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
        });
        expect(focusStyle).toEqual({ outlineStyle: "none", outlineWidth: "0px", boxShadow: "none" });

        await page.keyboard.press("Tab");
        const thinkingHeader = thinking.locator(".thinking-header");
        await expect(thinkingHeader).toBeFocused();
        await expect.poll(() => thinkingHeader.evaluate(element => element.matches(":focus-visible"))).toBe(true);
        await recordArrowState(thinkingHeader, `tab-start-${theme}-${width}`);
        // Real keyboard focus starts an opacity transition. Wait for the CSS state,
        // not a fixed delay, before retaining the full computed-style assertion.
        await expect(thinkingHeader.locator(".thinking-chevron")).toHaveCSS("opacity", "1");
        await recordArrowState(thinkingHeader, `tab-settled-${theme}-${width}`);
        const thinkingFocusStyle = await page.evaluate(() => {
          const element = document.activeElement;
          if (!(element instanceof HTMLButtonElement) || !element.classList.contains("thinking-header")) return null;
          const style = getComputedStyle(element);
          return { outlineStyle: style.outlineStyle, boxShadow: style.boxShadow, color: style.color,
            arrowOpacity: getComputedStyle(element.querySelector(".thinking-chevron")!).opacity };
        });
        expect(thinkingFocusStyle).toEqual({
          outlineStyle: "none", boxShadow: "none",
          color: await page.locator(".thinking-header").first().evaluate((element) => getComputedStyle(element).getPropertyValue("--thinking").trim())
            .then((thinkingColor) => page.evaluate((value) => {
              const probe = document.createElement("span");
              probe.style.color = value;
              document.body.append(probe);
              const color = getComputedStyle(probe).color;
              probe.remove();
              return color;
            }, thinkingColor)),
          arrowOpacity: "1",
        });
        await page.keyboard.press("Tab");
        const toolHeaderFocusStyle = await page.evaluate(() => {
          const element = document.activeElement;
          if (!(element instanceof HTMLButtonElement) || !element.classList.contains("tool-call-header")) return null;
          const style = getComputedStyle(element);
          return { outlineStyle: style.outlineStyle, boxShadow: style.boxShadow };
        });
        expect(toolHeaderFocusStyle).toEqual({ outlineStyle: "none", boxShadow: "none" });

        await transcript.evaluate((element) => { element.scrollTop = 0; });
        await transcript.focus();
        await page.keyboard.press("End");
        await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      }

      await page.getByTestId("model-thinking-trigger").click();
      await expect(page.getByTestId("model-thinking-model-option").first()).toContainText("crossband/very-long-model-id-for-visual-qa");
      await page.getByTestId("model-thinking-trigger").click();
      await page.getByTestId("toggle-events").click();
      await expect(page.getByTestId("inspector")).toBeVisible();
      await expect(page.getByTestId("event-log")).toContainText("tool_end");
      await page.screenshot({ path: testInfo.outputPath(`app-rich-inspector-${theme}-${width}.png`), animations: "disabled" });
    });
  }
}

test("思考箭头：桌面 hover/focus 显示，触屏始终可见且不改变布局", async ({ browser }) => {
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    for (const page of [desktop, mobile]) {
      await page.route("**/v1/models", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        models: [{ provider: "fixture", id: "fixture/model", name: "Local visual model" }],
        defaultModel: { provider: "fixture", id: "fixture/model", name: "Local visual model" },
        thinkingLevels: ["off", "medium"], defaultThinkingLevel: "medium",
      }) }));
      await page.goto("/");
      if (page === mobile) await page.getByRole("button", { name: "打开工作区导航" }).click();
      await page.getByTestId("new-session").click();
      await page.getByTestId("composer-input").fill("检查箭头显示状态");
      await page.getByTestId("send-button").click();
      await expect(page.locator(".thinking-header")).toBeVisible();
    }

    const header = desktop.locator(".thinking-header").first();
    const arrow = header.locator(".thinking-chevron");
    await header.scrollIntoViewIfNeeded();
    await expect.poll(() => desktop.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches)).toBe(true);
    const before = await header.evaluate((element) => {
      const headerRect = element.getBoundingClientRect();
      const svgRect = element.querySelector(".thinking-chevron")!.getBoundingClientRect();
      const labelRect = element.querySelector(".thinking-label")!.getBoundingClientRect();
      const summaryRect = element.querySelector(".thinking-summary")?.getBoundingClientRect();
      return { header: [headerRect.x, headerRect.y, headerRect.width, headerRect.height],
        svg: [svgRect.x, svgRect.y, svgRect.width, svgRect.height],
        contentRight: summaryRect?.right ?? labelRect.right };
    });
    expect(before.svg.slice(2)).toEqual([12, 12]);
    expect(before.svg[0]).toBeGreaterThanOrEqual(before.contentRight - 0.5);
    await expect(arrow).toHaveCSS("opacity", "0");
    await recordArrowState(header, "desktop-default");
    await desktop.screenshot({ path: `${evidenceDir}/desktop-default.png` });
    await header.hover();
    await expect(arrow).toHaveCSS("opacity", "1");
    const hovered = await header.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const a = element.querySelector(".thinking-chevron")!.getBoundingClientRect();
      return { header: [r.x, r.y, r.width, r.height], svg: [a.x, a.y, a.width, a.height] };
    });
    expect(hovered.header).toEqual(before.header);
    expect(hovered.svg).toEqual(before.svg);
    await desktop.screenshot({ path: `${evidenceDir}/desktop-hover.png` });
    await recordArrowState(header, "desktop-hover");
    await header.click();
    await desktop.mouse.move(0, 0);
    await expect(header).toBeFocused();
    await expect.poll(() => header.evaluate(element => element.matches(":focus-visible"))).toBe(false);
    await expect(arrow).toHaveCSS("opacity", "0");
    await recordArrowState(header, "desktop-click-away");
    // Anchor the tab sequence at the transcript; only a real Tab focuses the button.
    await desktop.getByTestId("chat-body").focus();
    await desktop.keyboard.press("Tab");
    await expect(header).toBeFocused();
    await expect.poll(() => header.evaluate(element => element.matches(":focus-visible"))).toBe(true);
    await expect(arrow).toHaveCSS("opacity", "1");
    await expect(header).toHaveCSS("outline-style", "none");
    await expect(header).toHaveCSS("box-shadow", "none");
    await recordArrowState(header, "desktop-real-tab");
    await desktop.screenshot({ path: `${evidenceDir}/desktop-focus.png` });

    const mobileHeader = mobile.locator(".thinking-header").first();
    const mobileArrow = mobileHeader.locator(".thinking-chevron");
    await expect.poll(() => mobile.evaluate(() => matchMedia("(pointer: coarse)").matches && !matchMedia("(hover: hover)").matches)).toBe(true);
    await expect(mobileArrow).toHaveCSS("opacity", "1");
    await recordArrowState(mobileHeader, "mobile-touch-default");
    await mobile.screenshot({ path: `${evidenceDir}/mobile-touch.png` });
    await mobileHeader.click();
    await expect(mobileHeader).toHaveAttribute("aria-expanded", "true");
    await mobileHeader.click();
    await expect(mobileHeader).toHaveAttribute("aria-expanded", "false");
    await mobile.mouse.move(0, 0);
    await expect(mobileArrow).toHaveCSS("opacity", "1");
    await expect(mobileHeader).toHaveCSS("outline-style", "none");
    await recordArrowState(mobileHeader, "mobile-touch-click-away");
  } finally {
    await desktop.close();
    await mobile.close();
  }
});
