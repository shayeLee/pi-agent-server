import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNonOverlapping, expectUsableControl } from './usable-control';

const SHORT_SCREEN_CASES = [
  { name: 'short-desktop', width: 768, height: 390, layout: 'desktop' },
  { name: 'short-mobile', width: 390, height: 390, layout: 'mobile' },
] as const;
const MOBILE_ATTACHMENT_CASES = [
  { name: 'short-mobile', width: 390, height: 390 },
  { name: 'tall-mobile', width: 390, height: 844 },
] as const;
const LONG_DRAFT_LINES = 24; // Exceeds the short-screen editor cap.
const ATTACHMENT_OVERFLOW_COUNT = 5; // Stay within the upload limit; long filenames wrap in the narrow desktop viewport.
const overflowAttachmentNames = Array.from({ length: ATTACHMENT_OVERFLOW_COUNT }, (_, index) =>
  `overflow-regression-review-attachment-${index + 1}.txt`);
const retryAttachmentNames = Array.from({ length: ATTACHMENT_OVERFLOW_COUNT }, (_, index) => `retry-${index}.txt`);

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
const scrollingTimeline = timeline.map(item => item.id === "p2-assistant" ? {
  ...item,
  text: [
    item.text,
    ...Array.from({ length: 8 }, (_, index) => [
      `第 ${index + 1} 轮检查结果：需求说明已与实现记录逐项核对，附件保留原始文件名，方便后续定位相关修改。`,
      "阅读检查：已有对话应保持独立滚动，长草稿和多份附件不应遮挡历史消息；用户可以返回前面的评审记录，再继续查看最新结果。",
      "上传检查：失败附件需要明确显示重试和移除入口；重试成功后只更新附件状态，不创建会话，也不自动发送尚未确认的草稿。",
    ].join("\n\n")),
  ].join("\n\n"),
} : item);
const evidenceDir = "/tmp/reading-first-actual/final";

async function installFixture(page: Page, submissions?: { creates: unknown[]; messages: unknown[] }, history = timeline): Promise<void> {
  let uploadId = 0;
  let createdSession = session;
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
    if (method === "GET" && url.pathname === "/v1/sessions") return json([createdSession]);
    if (method === "POST" && url.pathname === "/v1/sessions" && submissions) {
      const body = request.postDataJSON();
      submissions.creates.push(body);
      createdSession = { ...session, projectId: body.projectId };
      return json(createdSession, 201);
    }
    if (method === "POST" && url.pathname === `/v1/sessions/${sessionId}/messages` && submissions) {
      submissions.messages.push(request.postDataJSON());
      return json({ status: "accepted" }, 202);
    }
    if (method === "GET" && url.pathname.endsWith("/control-queue")) return json({ requestId: null, revision: 0, items: [] });
    if (method === "GET" && url.pathname === `/v1/sessions/${sessionId}/export`) {
      return json({ timeline: history, messages: [], lastEventId: 0 });
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
  await sessionButton.click();
  if (usedMobileMenu) await expect(page.getByTestId("sidebar")).toBeHidden();
  await expect(page.getByTestId("chat-header")).toBeVisible();
  await expect(page.getByTestId("message-list")).toContainText("已有消息仍须保持阅读宽度");
}

async function saveEvidence(page: Page, name: string, state: unknown): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}/${name}.png`, animations: "disabled" });
  await writeFile(`${evidenceDir}/${name}.json`, `${JSON.stringify(state, null, 2)}\n`);
}

for (const viewport of SHORT_SCREEN_CASES) test(`短屏长草稿与附件 ${viewport.name}：附件内部滚动且操作可达`, async ({ page }) => {
  const { width } = viewport;
  await page.setViewportSize({ width, height: viewport.height });
  const submissions = { creates: [] as unknown[], messages: [] as unknown[] };
  await installFixture(page, submissions);
  await page.goto("/");
  const navigation = page.getByRole("button", { name: "打开工作区导航" });
  const usedDrawer = await navigation.isVisible();
  if (usedDrawer) await navigation.click();
  await expect(page.getByTestId("new-session")).toBeVisible();
  await page.getByTestId("new-session").click();
  if (usedDrawer) await expect(page.getByTestId("sidebar")).toBeHidden();
  await page.getByTestId("composer-input").fill(Array.from({ length: LONG_DRAFT_LINES }, (_, index) => `短屏草稿第 ${index + 1} 行`).join("\n"));
  await page.getByTestId("composer-file-input").setInputFiles(overflowAttachmentNames.map((name, index) => ({
    name, mimeType: "text/plain", buffer: Buffer.from(`fixture ${index + 1}`),
  })));
  await expect(page.getByTestId("composer-attachment")).toHaveCount(overflowAttachmentNames.length);
  await expect(page.locator('.composer-attachment[data-state="ready"]')).toHaveCount(overflowAttachmentNames.length);

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
        scrollHeight: attachments.scrollHeight, clientHeight: attachments.clientHeight,
        scrollWidth: attachments.scrollWidth, clientWidth: attachments.clientWidth,
        rows: Array.from(attachments.children, el => ({ width: el.getBoundingClientRect().width, top: el.getBoundingClientRect().top })),
        overflowY: getComputedStyle(attachments).overflowY },
      viewportHeight: innerHeight,
      composerMaxHeight: getComputedStyle(document.querySelector<HTMLElement>("[data-testid=composer]")!).maxHeight,
    };
  });
  await saveEvidence(page, `short-composer-draft-attachments-${width}`, layout);
  expect(layout.composer.top).toBeGreaterThanOrEqual(0);
  expect(layout.composer.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.input.top).toBeGreaterThanOrEqual(layout.composer.top);
  expect(layout.input.bottom).toBeLessThanOrEqual(layout.composer.bottom);
  expect(layout.send.top).toBeGreaterThanOrEqual(layout.composer.top);
  expect(layout.send.bottom).toBeLessThanOrEqual(layout.composer.bottom);
  expect(layout.attachments.scrollHeight).toBeGreaterThan(layout.attachments.clientHeight);
  expect(layout.input.scrollHeight).toBeGreaterThan(layout.input.height);
  {
    const firstRow = await page.getByTestId("composer-attachment").first().boundingBox();
    expect(firstRow!.y).toBeGreaterThanOrEqual(layout.attachments.top);
    expect(firstRow!.y + firstRow!.height).toBeLessThanOrEqual(layout.attachments.bottom);
    for (let index = overflowAttachmentNames.length; index >= 1; index--) {
      const remove = page.getByRole("button", { name: `移除附件 ${overflowAttachmentNames[index - 1]}`, exact: true });
      await remove.scrollIntoViewIfNeeded();
      await expectUsableControl(remove);
      await remove.click();
      await expect(page.getByTestId("composer-attachment")).toHaveCount(index - 1);
    }
    for (const target of [page.getByTestId("composer-input"), page.getByTestId("send-button")]) await expectUsableControl(target);
    expect(submissions).toEqual({ creates: [], messages: [] });
  }
});

for (const viewport of MOBILE_ATTACHMENT_CASES) test(`手机多附件失败重试与消息滚动 ${viewport.name}`, async ({ page }) => {
  const { height } = viewport;
  await page.setViewportSize({ width: viewport.width, height });
  const submissions = { creates: [] as unknown[], messages: [] as unknown[] };
  await installFixture(page, submissions, scrollingTimeline);
  let attempts = 0;
  await page.route("**/v1/files", async route => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 500, contentType: "application/json",
      body: JSON.stringify({ message: "上传失败" }) });
    return route.fallback();
  });
  await page.goto("/");
  await openFixtureSession(page);
  await page.getByTestId("composer-input").fill("长草稿\n".repeat(LONG_DRAFT_LINES));
  await page.getByTestId("composer-file-input").setInputFiles(retryAttachmentNames.map(name => ({
    name, mimeType: "text/plain", buffer: Buffer.from("fixture"),
  })));
  const failed = page.locator('.composer-attachment[data-state="error"]');
  await expect(failed).toHaveCount(1);
  await failed.scrollIntoViewIfNeeded();
  const retry = failed.getByRole("button", { name: /重试上传/ });
  const remove = failed.getByRole("button", { name: /移除附件/ });
  await expectUsableControl(retry);
  await expectUsableControl(remove);
  await expectNonOverlapping(retry, remove);
  const row = await failed.boundingBox();
  const area = await page.getByTestId("composer-attachments").boundingBox();
  expect(row!.y).toBeGreaterThanOrEqual(area!.y);
  expect(row!.y + row!.height).toBeLessThanOrEqual(area!.y + area!.height);
  await saveEvidence(page, `mobile-attachments-error-${height}`, { row, area });
  await retry.click();
  await expect(page.locator('.composer-attachment[data-state="ready"]')).toHaveCount(retryAttachmentNames.length);
  expect(attempts).toBe(retryAttachmentNames.length + 1); // One failed upload is retried.
  await page.getByTestId("composer-input").click({ trial: true });
  await expectUsableControl(page.getByTestId("send-button"));
  await expect(failed).toHaveCount(0);
  const body = page.getByTestId("chat-body");
  await expectNonOverlapping(body, page.getByTestId('composer'));
  await expect(body).toBeVisible();
  expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await body.hover();
  await page.mouse.wheel(0, -2000);
  await expect.poll(() => body.evaluate(el => el.scrollTop)).toBe(0);
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => body.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(submissions).toEqual({ creates: [], messages: [] });
  await saveEvidence(page, `mobile-attachments-session-${height}`, await body.boundingBox());
});

test("起始态长项目列表：sidebar 菜单边界可达、可滚动选择末项并在首发使用正确项目", async ({ page }) => {
  await page.setViewportSize({ width: 1235, height: 390 });
  const submissions = { creates: [] as unknown[], messages: [] as unknown[] };
  await installFixture(page, submissions);
  await page.goto("/");
  const trigger = page.getByTestId("sidebar").getByTestId("project-select");
  await expect(page.getByTestId("project-select")).toHaveCount(1);
  const navigation = page.getByRole("button", { name: "打开工作区导航" });
  const drawer = await navigation.isVisible();
  if (drawer) await navigation.click();
  const expandSidebar = page.getByRole("button", { name: "展开侧边栏", exact: true });
  if (await expandSidebar.isVisible()) await expandSidebar.click();
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByRole("menu", { name: "选择项目" });
  await expect(menu.getByRole("menuitemradio")).toHaveCount(projects.length);
  const placement = await page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>("[data-testid=sidebar] .select-menu-listbox")!;
    const trigger = document.querySelector<HTMLElement>("[data-testid=project-select]")!;
    const menuRect = menu.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    return { menu: { left: menuRect.left, right: menuRect.right, top: menuRect.top, bottom: menuRect.bottom, height: menuRect.height,
      scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight, overflowY: getComputedStyle(menu).overflowY },
      trigger: { top: triggerRect.top, bottom: triggerRect.bottom }, viewportHeight: innerHeight, viewportWidth: innerWidth };
  });
  expect(placement.menu.top).toBeGreaterThanOrEqual(0);
  expect(placement.menu.left).toBeGreaterThanOrEqual(0);
  expect(placement.menu.right).toBeLessThanOrEqual(placement.viewportWidth);
  expect(placement.menu.bottom).toBeLessThanOrEqual(placement.viewportHeight);
  const options = menu.locator('.select-menu-options');
  expect(await options.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  const footer = page.getByTestId('new-project');
  await expectUsableControl(footer);
  const footerBefore = await footer.boundingBox();
  const lastProject = projects.at(-1)!;
  const lastOption = menu.getByRole("menuitemradio", { name: lastProject.name, exact: true });
  await lastOption.scrollIntoViewIfNeeded();
  await expect(lastOption).toBeVisible();
  expect(await options.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expectUsableControl(lastOption);
  await expectUsableControl(footer);
  expect(await footer.boundingBox()).toEqual(footerBefore);
  await expectNonOverlapping(lastOption, footer);
  await lastOption.click();
  await expect(trigger).toHaveAttribute("data-value", lastProject.id);
  await expect(trigger).toHaveText(lastProject.name);
  await expect(trigger).toHaveAttribute("title", lastProject.cwd);
  expect(submissions).toEqual({ creates: [], messages: [] });
  if (drawer) {
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sidebar")).toBeHidden();
  }
  await page.getByTestId("composer-input").fill("在末项项目首发");
  await page.getByTestId("send-button").click();
  await expect.poll(() => submissions.messages.length).toBe(1);
  expect(submissions.creates).toEqual([expect.objectContaining({ projectId: lastProject.id })]);
  expect(submissions.messages).toEqual([expect.objectContaining({ prompt: "在末项项目首发" })]);
  await saveEvidence(page, "start-project-menu-scroll", { placement, submissions });
});

test("1280px Inspector 并排挤出消息；1100px 左侧栏独立覆盖并保留关闭行为", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installFixture(page);
  await page.goto("/");
  await openFixtureSession(page);
  const chatBefore = await page.getByTestId("chat").boundingBox();
  await page.getByTestId("trace-tab").click();
  await expect(page.getByTestId("inspector")).toBeVisible();
  const inspectorState = await page.evaluate(() => ({
    inspectorPosition: getComputedStyle(document.querySelector<HTMLElement>("[data-testid=inspector]")!).position,
    chatWidth: document.querySelector<HTMLElement>("[data-testid=chat]")!.getBoundingClientRect().width,
    chatLeft: document.querySelector<HTMLElement>("[data-testid=chat]")!.getBoundingClientRect().left,
    viewportWidth: innerWidth,
  }));

  const panelBox = (await page.getByTestId('inspector').boundingBox())!;
  expect(inspectorState.chatWidth).toBeLessThan(chatBefore!.width);
  await expectNonOverlapping(page.getByTestId('chat'), page.getByTestId('inspector'));
  expect(inspectorState.chatLeft + inspectorState.chatWidth).toBe(panelBox.x);
  await expect(page.locator('.workbench-inspector-backdrop')).toHaveCount(0);
  await page.getByTestId('composer-input').fill('侧栏打开仍可编辑');
  await expect(page.getByTestId("message-list")).toContainText("已有消息仍须保持阅读宽度");
  await saveEvidence(page, "inspector-sidebar-1280", inspectorState);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector")).toHaveCount(0);
  await expect(page.getByTestId("trace-tab")).toBeFocused();

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
  expect(sidebarState.chatWidth).toBe(sidebarState.viewportWidth);
  await saveEvidence(page, "sidebar-overlay-1100", sidebarState);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sidebar")).toBeHidden();
  await expect(menu).toBeFocused();
});

test("手机导航、详情、思考与工具按钮均可操作，长标题不冲突", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installFixture(page);
  await page.goto("/");
  await openFixtureSession(page);

  const selectors = [
    '[aria-label="打开工作区导航"]',
    '[data-testid="model-thinking-trigger"]',
    ".tool-call-header",
  ];
  const targets = await page.evaluate((items) => items.map((selector) => {
    const button = document.querySelector<HTMLElement>(selector)!;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { selector, width: rect.width, height: rect.height, hit: hit ? button.contains(hit) : false };
  }), selectors);
  for (const selector of selectors) await expectUsableControl(page.locator(selector));
  const headerLayout = await page.evaluate(() => {
    const title = document.querySelector<HTMLElement>("[data-testid=chat-session-title]")!.getBoundingClientRect();
    const selectors = ["[data-testid=trace-tab]"];
    const boxes = selectors.map((selector) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect());
    const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    return { titleOverlapsControls: boxes.map((box) => overlaps(title, box)), controls: boxes.map((box) => ({
      width: box.width, height: box.height, insideViewport: box.left >= 0 && box.right <= innerWidth,
    })) };
  });
  expect(headerLayout.titleOverlapsControls).toEqual([false]);
  expect(headerLayout.controls.every((box) => box.insideViewport)).toBe(true);

  const nav = page.getByRole("button", { name: "打开工作区导航" });
  await nav.click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  const sidebarToggle = page.getByTestId("toggle-sidebar");
  const sidebarToggleBox = await sidebarToggle.boundingBox();
  await expectUsableControl(sidebarToggle);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sidebar")).toBeHidden();

  await page.getByTestId("trace-tab").click();
  const inspectorClose = page.getByTestId("inspector-close");
  await expect(inspectorClose).toBeVisible();
  const closeBox = await inspectorClose.boundingBox();
  await expectUsableControl(inspectorClose);
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
