import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const evidenceDir = "/tmp/rich-arrow-regression-fix";
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
  const centers = await card.locator(".tool-call-header, .tool-name, .tool-status-icon").evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top + rect.height / 2;
    }),
  );
  expect(centers).toHaveLength(3); // header, name, status glyph (step rows carry no chevron)
  for (const centerY of centers.slice(1)) {
    expect(Math.abs(centerY - centers[0]), `工具名称与状态标记应和步骤行垂直居中 ${JSON.stringify(centers)}`).toBeLessThanOrEqual(0.75);
  }
}

async function expectThinkingContentVerticallyCentered(thinking: import("@playwright/test").Locator, includePreview: boolean) {
  // A thinking step reads as one line: glyph, label and (when folded) preview share a vertical center.
  const centers = await thinking.locator(".thinking-header").evaluate((header) =>
    [".thinking-glyph", ".thinking-label", ".thinking-preview"].flatMap((selector) => {
      const element = header.querySelector<HTMLElement>(selector);
      if (!element) return [];
      const rect = element.getBoundingClientRect();
      return [rect.top + rect.height / 2];
    }));
  expect(centers).toHaveLength(includePreview ? 3 : 2);
  for (const centerY of centers.slice(1)) {
    expect(Math.abs(centerY - centers[0]), "思考步骤的标记、标签与预览应同一行居中").toBeLessThanOrEqual(0.75);
  }
}

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`完整应用富内容：${theme} / ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
      // The real app UI renders model metadata; this local visual fixture supplies a
      // deliberately long identifier without selecting a paid provider.
      await page.route(/\/v1\/models(\?|$)/, async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
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
      // Every item keeps a navigation anchor in original order, whatever the ledger grouping.
      const orderedKinds = await timeline.locator("[data-timeline-id]").evaluateAll((elements) => elements.map((element) => {
        const kind = (element as HTMLElement).dataset.timelineKind;
        if (kind === "tool_call") return (element as HTMLElement).dataset.anchorToolCallId;
        return kind === "assistant_text" ? "assistant" : kind;
      }));
      expect(orderedKinds).toEqual(["user", "thinking", "visual-read", "visual-test", "assistant"]);

      const userMessage = timeline.locator(".row-user");
      const answer = timeline.locator(".row-assistant").last();
      const thinking = page.locator('[data-testid^="thinking-"]').first();
      const successfulTool = page.getByTestId("tool-call-card").first();
      const failedTool = page.getByTestId("tool-call-card").nth(1);
      // The legacy rich mock returns { stderr }, not standard content.text.
      // Structured envelopes remain readable in the expanded body.
      const failedResult = failedTool.getByRole("region", { name: "结果", exact: true }).locator("pre").first();
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
      // The finished turn folds its work block; open it to read the steps.
      for (const block of await page.locator('.work-header[aria-expanded="false"]').all()) await block.click();
      await expect(thinking.getByRole("button")).toHaveAttribute("aria-expanded", "false");
      await expect(thinking.locator(".thinking-label")).toHaveCSS("white-space", "nowrap");
      await expectThinkingContentVerticallyCentered(thinking, true); // Folded: the preview sits on the label line.
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
      if (await failedTool.locator('.tool-call-header').getAttribute('aria-expanded') === 'false') await failedTool.locator('.tool-call-header').click();
      // Center explicitly: nearest-edge scrolling rounds fractional CSS pixels and can
      // leave 0.4px outside the transcript after typography/layout changes.
      await failedResult.evaluate(el => el.scrollIntoView({ block: "center" }));
      await expect(failedTool.locator('.tool-call-body')).toBeVisible();
      await expect(failedResult).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`app-rich-failure-${theme}-${width}.png`), animations: "disabled" });

      // Expanded-state proof is separate from the default answer view: thinking and
      // successful tool raw input/output are available without any summary substitution.
      await thinking.getByRole("button").click();
      await expectThinkingContentVerticallyCentered(thinking, false); // Expanded header retains the label, the preview gives way to the body.
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
      await expect(successfulTool.locator('.tool-call-body > :not(section)')).toHaveCount(0);
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
        // DESIGN §9.2: keyboard focus is visible; the reading surface shows a left rule, never a frame.
        const focusStyle = await transcript.evaluate((element) => {
          const style = getComputedStyle(element);
          return { visible: element.matches(":focus-visible"), outlineStyle: style.outlineStyle, boxShadow: style.boxShadow };
        });
        if (focusStyle.visible) {
          expect(focusStyle.outlineStyle).toBe("none");
          expect(focusStyle.boxShadow).toMatch(/inset 2px 0px 0px/);
        }

        // DESIGN §9.2 Tab order: the ledger's expandable controls in reading order, each with visible focus.
        const focusIndicator = () => page.evaluate(() => {
          const element = document.activeElement as HTMLElement;
          const style = getComputedStyle(element);
          return { focusVisible: element.matches(":focus-visible"), shown: style.outlineStyle !== "none" || style.boxShadow !== "none" };
        });
        await page.keyboard.press("Tab");
        await expect(page.locator(".work-header").first()).toBeFocused();
        expect(await focusIndicator()).toEqual({ focusVisible: true, shown: true });
        await page.keyboard.press("Tab");
        await expect(thinking.locator(".thinking-header")).toBeFocused();
        expect(await focusIndicator()).toEqual({ focusVisible: true, shown: true });

        await transcript.evaluate((element) => { element.scrollTop = 0; });
        await transcript.focus();
        await page.keyboard.press("End");
        await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      }

      await page.getByTestId("model-thinking-trigger").click();
      await expect(page.getByTestId("model-thinking-model-option").first()).toContainText("crossband/very-long-model-id-for-visual-qa");
      await page.getByTestId("model-thinking-trigger").click();
      await page.getByTestId("trace-tab").click();
      await expect(page.getByTestId("inspector")).toBeVisible();
      await page.getByTestId("inspector-tab-events").click();
      await expect(page.getByTestId("event-log")).toContainText("tool_end");
      await page.screenshot({ path: testInfo.outputPath(`app-rich-inspector-${theme}-${width}.png`), animations: "disabled" });
    });
  }
}

