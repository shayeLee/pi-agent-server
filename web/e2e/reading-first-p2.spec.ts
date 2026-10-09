import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";

const projectId = "p2-project-default";
const sessionId = "p2-session";
const sessionTitle = "用于核验移动端导航、详情面板与长标题互不遮挡的长期工作会话标题";
const session = {
  id: sessionId, ownerKey: "local-fixture", projectId, title: sessionTitle,
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  modelProvider: null, modelId: null, thinkingLevel: null, systemPrompt: null,
};
const projects = [
  { id: projectId, name: "默认项目", cwd: "/tmp/default", isDefault: true },
  ...Array.from({ length: 18 }, (_, index) => ({
    id: `p2-project-${index + 1}`,
    name: `项目 ${String(index + 1).padStart(2, "0")} · 长列表滚动选项`,
    cwd: `/tmp/project-${index + 1}`,
    isDefault: false,
  })),
];
const timeline = [
  { type: "message", id: "p2-user", role: "user", text: "已有消息仍须保持阅读宽度，详情面板不得挤压对话。" },
  { type: "tool_call", id: "p2-tool-start", toolCallId: "p2-tool", toolName: "read", args: { path: "/tmp/fixture.txt" } },
  { type: "tool_result", id: "p2-tool-end", toolCallId: "p2-tool", toolName: "read", result: "fixture raw result" },
  { type: "message", id: "p2-assistant", role: "assistant", text: "响应式布局保持正常阅读。" },
];
const evidenceDir = "/tmp/reading-first-actual/final";

async function installFixture(page: Page): Promise<void> {
  let uploadId = 0;
  await page.route("**/v1/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(body),
    });

    if (method === "GET" && url.pathname === "/v1/access") return json({ canRead: true, canWrite: true });
    if (method === "GET" && url.pathname === "/v1/projects") return json(projects);
    if (method === "GET" && url.pathname === "/v1/models") return json({
      models: [{ provider: "fixture", id: "fixture/model-long-id", name: "Local fixture model" }],
      defaultModel: { provider: "fixture", id: "fixture/model-long-id", name: "Local fixture model" },
      thinkingLevels: ["off", "medium"], defaultThinkingLevel: "medium",
    });
    if (method === "GET" && url.pathname === "/v1/sessions") return json([session]);
    if (method === "GET" && url.pathname === `/v1/sessions/${sessionId}/export`) {
      return json({ timeline, messages: [], lastEventId: 0 });
    }
    if (method === "GET" && url.pathname === `/v1/sessions/${sessionId}/events`) {
      return route.fulfill({ status: 204, body: "" });
    }
    if (method === "POST" && url.pathname === "/v1/files") {
      uploadId++;
      const name = request.headers()["x-file-name"] ?? `fixture-${uploadId}.txt`;
      return json({ fileId: `p2-file-${uploadId}`, name, mediaType: "text/plain", size: 24,
        status: "ready", agentPath: `/private/fixture/${uploadId}` }, 201);
    }
    return json({ statusCode: 404, error: "Not Found", message: `unmocked fixture: ${method} ${url.pathname}` }, 404);
  });
}

async function openFixtureSession(page: Page): Promise<void> {
  const sidebarMenu = page.getByRole("button", { name: "打开工作区导航" });
  const usedMobileMenu = await sidebarMenu.isVisible();
  if (usedMobileMenu) await sidebarMenu.click();
  const sessionButton = page.getByTestId(`session-${sessionId}`);
  await expect(sessionButton).toBeVisible();
  await sessionButton.click({ position: { x: 12, y: 16 } });
  if (usedMobileMenu) await expect(page.getByTestId("sidebar")).toBeHidden();
  await expect(page.getByTestId("chat-header")).toBeVisible();
  await expect(page.getByTestId("message-list")).toContainText("已有消息仍须保持阅读宽度");
}

async function saveEvidence(page: Page, name: string, state: unknown): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/${name}.png`, animations: "disabled" });
  await writeFile(`${evidenceDir}/${name}.json`, `${JSON.stringify(state, null, 2)}\n`);
}

test("短屏长草稿与附件：整体 Composer 受 40vh 限制，附件内部滚动且输入和发送可见", async ({ page }) => {
  await page.setViewportSize({ width: 1235, height: 390 });
  await installFixture(page);
  await page.goto("/");
  await expect(page.getByTestId("new-session")).toBeVisible();
  await page.getByTestId("new-session").click();
  await page.getByTestId("composer-input").fill(Array.from({ length: 24 }, (_, index) => `短屏草稿第 ${index + 1} 行`).join("\n"));
  await page.getByTestId("composer-file-input").setInputFiles(Array.from({ length: 5 }, (_, index) => ({
    name: `attachment-${index + 1}.txt`, mimeType: "text/plain", buffer: Buffer.from(`fixture ${index + 1}`),
  })));
  await expect(page.getByTestId("composer-attachment")).toHaveCount(5);
  await expect(page.locator('.composer-attachment[data-state="ready"]')).toHaveCount(5);

  const layout = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const composer = rect("[data-testid=composer]");
    const input = rect("[data-testid=composer-input]");
    const send = rect('[data-testid="send-button"]');
    const attachments = document.querySelector<HTMLElement>("[data-testid=composer-attachments]")!;
    const attachmentRect = attachments.getBoundingClientRect();
    return {
      composer: { top: composer.top, bottom: composer.bottom, height: composer.height },
      input: { top: input.top, bottom: input.bottom, height: input.height, scrollHeight: document.querySelector<HTMLTextAreaElement>("[data-testid=composer-input]")!.scrollHeight },
      send: { top: send.top, bottom: send.bottom, height: send.height },
      attachments: { top: attachmentRect.top, bottom: attachmentRect.bottom, height: attachmentRect.height,
        scrollHeight: attachments.scrollHeight, clientHeight: attachments.clientHeight, overflowY: getComputedStyle(attachments).overflowY },
      viewportHeight: innerHeight,
      composerMaxHeight: getComputedStyle(document.querySelector<HTMLElement>("[data-testid=composer]")!).maxHeight,
    };
  });
  expect(layout.composer.height).toBeLessThanOrEqual(390 * 0.4 + 1);
  expect(layout.input.top).toBeGreaterThanOrEqual(layout.composer.top);
  expect(layout.input.bottom).toBeLessThanOrEqual(layout.composer.bottom + 1);
  expect(layout.send.top).toBeGreaterThanOrEqual(layout.composer.top);
  expect(layout.send.bottom).toBeLessThanOrEqual(layout.composer.bottom + 1);
  expect(layout.attachments.overflowY).toBe("auto");
  expect(layout.attachments.scrollHeight).toBeGreaterThan(layout.attachments.clientHeight);
  expect(layout.input.scrollHeight).toBeGreaterThan(layout.input.height);
  await saveEvidence(page, "short-composer-draft-attachments", layout);
});

test("起始态长项目列表：菜单向上浮层、随视口限高并可滚动选择末项", async ({ page }) => {
  await page.setViewportSize({ width: 1235, height: 390 });
  await installFixture(page);
  await page.goto("/");
  await expect(page.getByTestId("composer-project-select")).toBeVisible();
  await page.getByTestId("composer-project-select").click();
  const menu = page.getByRole("listbox", { name: "选择项目" });
  await expect(menu.getByRole("option")).toHaveCount(projects.length);
  const placement = await page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>(".composer-start-settings .select-menu-listbox")!;
    const trigger = document.querySelector<HTMLElement>("[data-testid=composer-project-select]")!;
    const menuRect = menu.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    return { menu: { top: menuRect.top, bottom: menuRect.bottom, height: menuRect.height,
      scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight, overflowY: getComputedStyle(menu).overflowY },
      trigger: { top: triggerRect.top, bottom: triggerRect.bottom }, viewportHeight: innerHeight };
  });
  expect(placement.menu.top).toBeLessThan(placement.trigger.top);
  expect(placement.menu.bottom).toBeLessThanOrEqual(placement.viewportHeight);
  expect(placement.menu.overflowY).toBe("auto");
  expect(placement.menu.scrollHeight).toBeGreaterThan(placement.menu.clientHeight);
  await menu.getByRole("option", { name: /项目 18/ }).scrollIntoViewIfNeeded();
  await menu.getByRole("option", { name: /项目 18/ }).click();
  await expect(page.getByTestId("composer-project-select")).toHaveAttribute("data-value", "p2-project-18");
  await saveEvidence(page, "start-project-menu-scroll", placement);
});

test("1280px Inspector 覆盖不挤压消息；1100px 侧栏独立覆盖并保留关闭行为", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installFixture(page);
  await page.goto("/");
  await openFixtureSession(page);
  const chatBefore = await page.getByTestId("chat").boundingBox();
  await page.getByTestId("toggle-events").click();
  await expect(page.getByTestId("inspector")).toBeVisible();
  const inspectorState = await page.evaluate(() => ({
    inspectorPosition: getComputedStyle(document.querySelector<HTMLElement>("[data-testid=inspector]")!).position,
    chatWidth: document.querySelector<HTMLElement>("[data-testid=chat]")!.getBoundingClientRect().width,
    chatLeft: document.querySelector<HTMLElement>("[data-testid=chat]")!.getBoundingClientRect().left,
    viewportWidth: innerWidth,
  }));
  expect(inspectorState.inspectorPosition).toBe("fixed");
  expect(chatBefore && inspectorState.chatWidth).toBeCloseTo(chatBefore!.width, 0);
  await expect(page.getByTestId("message-list")).toContainText("已有消息仍须保持阅读宽度");
  await saveEvidence(page, "inspector-overlay-1280", inspectorState);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector")).toHaveCount(0);
  await expect(page.getByTestId("toggle-events")).toBeFocused();

  await page.setViewportSize({ width: 1100, height: 800 });
  const menu = page.getByRole("button", { name: "打开工作区导航" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  const sidebarState = await page.evaluate(() => ({
    sidebarPosition: getComputedStyle(document.querySelector<HTMLElement>("[data-testid=sidebar]")!).position,
    sidebarVisible: getComputedStyle(document.querySelector<HTMLElement>("[data-testid=sidebar]")!).visibility,
    chatWidth: document.querySelector<HTMLElement>("[data-testid=chat]")!.getBoundingClientRect().width,
    viewportWidth: innerWidth,
  }));
  expect(sidebarState.sidebarPosition).toBe("fixed");
  expect(sidebarState.sidebarVisible).toBe("visible");
  expect(sidebarState.chatWidth).toBeCloseTo(1100, 0);
  await saveEvidence(page, "sidebar-overlay-1100", sidebarState);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sidebar")).toBeHidden();
  await expect(menu).toBeFocused();
});

test("手机导航、详情、思考与工具按钮均可命中且目标至少 44px，长标题不冲突", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installFixture(page);
  await page.goto("/");
  await openFixtureSession(page);

  const selectors = [
    '[aria-label="打开工作区导航"]',
    '[data-testid="toggle-events"]',
    '[data-testid="model-thinking-trigger"]',
    ".tool-call-header",
  ];
  const targets = await page.evaluate((items) => items.map((selector) => {
    const button = document.querySelector<HTMLElement>(selector)!;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { selector, width: rect.width, height: rect.height, hit: hit ? button.contains(hit) : false };
  }), selectors);
  for (const target of targets) {
    expect(target.width, `${target.selector} 宽度`).toBeGreaterThanOrEqual(44);
    expect(target.height, `${target.selector} 高度`).toBeGreaterThanOrEqual(44);
    expect(target.hit, `${target.selector} 中心点应命中按钮`).toBe(true);
  }
  const headerLayout = await page.evaluate(() => {
    const title = document.querySelector<HTMLElement>("[data-testid=chat-session-title]")!.getBoundingClientRect();
    const selectors = ["[data-testid=chat-tab]", "[data-testid=trace-tab]", "[data-testid=toggle-events]"];
    const boxes = selectors.map((selector) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect());
    const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    return { titleOverlapsControls: boxes.map((box) => overlaps(title, box)), controls: boxes.map((box) => ({
      width: box.width, height: box.height, insideViewport: box.left >= 0 && box.right <= innerWidth,
    })) };
  });
  expect(headerLayout.titleOverlapsControls).toEqual([false, false, false]);
  expect(headerLayout.controls.every((box) => box.insideViewport)).toBe(true);

  const nav = page.getByRole("button", { name: "打开工作区导航" });
  await nav.click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  const sidebarToggle = page.getByTestId("toggle-sidebar");
  const sidebarToggleBox = await sidebarToggle.boundingBox();
  expect(sidebarToggleBox && sidebarToggleBox.width).toBeGreaterThanOrEqual(44);
  expect(sidebarToggleBox && sidebarToggleBox.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sidebar")).toBeHidden();

  await page.getByTestId("toggle-events").click();
  const inspectorClose = page.getByTestId("inspector-close");
  await expect(inspectorClose).toBeVisible();
  const closeBox = await inspectorClose.boundingBox();
  expect(closeBox && closeBox.width).toBeGreaterThanOrEqual(44);
  expect(closeBox && closeBox.height).toBeGreaterThanOrEqual(44);
  await inspectorClose.click();
  await expect(page.getByTestId("inspector")).toHaveCount(0);

  await page.getByTestId("model-thinking-trigger").click();
  await expect(page.getByRole("dialog", { name: "模型与思考深度" })).toBeVisible();
  await page.keyboard.press("Escape");
  const toolHeader = page.locator(".tool-call-header");
  const initialExpanded = await toolHeader.getAttribute("aria-expanded");
  await toolHeader.click();
  await expect(toolHeader).toHaveAttribute("aria-expanded", initialExpanded === "true" ? "false" : "true");
  await saveEvidence(page, "mobile-targets-long-title", { targets, headerLayout, sidebarToggle: sidebarToggleBox, inspectorClose: closeBox });
});
