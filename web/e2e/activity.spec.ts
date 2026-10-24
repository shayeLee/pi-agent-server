import { expect, test } from "@playwright/test";

// docs/companion-butler.md §4, §6: runs in other sessions show in the sidebar; the companion at
// the composer says when one ended, and that word opens it. The mock holds a "[slow]" prompt's run for a moment.
const API = process.env.PI_E2E_MOCK_API!;

test("another session's run shows as running, then the companion at the composer says it ended and opens it", async ({ page, request }) => {
  const tag = Date.now();
  const create = async (title: string) => {
    const response = await request.post(`${API}/v1/sessions`, { data: { title } });
    expect(response.ok()).toBeTruthy();
    return await response.json() as { id: string; projectId: string };
  };
  const front = await create(`前台会话 ${tag}`);
  const back = await create(`后台会话 ${tag}`);

  // The companion sits on the composer once the open session has a conversation.
  await page.goto(`/p/${front.projectId}/s/${front.id}`);
  await page.getByTestId("composer-input").fill("你好");
  await page.getByTestId("send-button").click();
  await expect(page.locator(".message-assistant")).toHaveCount(1);
  await expect(page.getByTestId("companion-dock")).toBeVisible();
  // The sidebar's foot (settings, run activity) shares one line with the stats bar.
  const center = async (testId: string) => { const box = (await page.getByTestId(testId).boundingBox())!; return box.y + box.height / 2; };
  const stats = await center("stats-bar");
  for (const id of ["settings-toggle", "sidebar-activity-toggle"]) expect(Math.abs(await center(id) - stats), id).toBeLessThanOrEqual(1);
  await expect(page.getByTestId(`session-${back.id}`)).toBeVisible();

  const sent = await request.post(`${API}/v1/sessions/${back.id}/messages`, { data: { requestId: `activity-${tag}`, prompt: "[slow] 后台跑一会儿" } });
  expect(sent.status()).toBe(202);

  // While it runs: marked in the list though another session is open, and counted by the companion.
  await expect(page.getByTestId(`session-${back.id}`).locator("xpath=ancestor::li")).toHaveClass(/running/);
  await expect(page.getByTestId("sidebar-activity-toggle").locator(".sidebar-activity-label")).toHaveText("1 个在跑");

  const bubble = page.getByTestId("companion-elsewhere");
  await expect(bubble).toContainText(`后台会话 ${tag}`);
  await expect(page.getByTestId("sidebar-activity-toggle").locator(".sidebar-activity-label")).toHaveText("运行动态");
  await expect(page.getByTestId(`session-${back.id}`).locator("xpath=ancestor::li")).not.toHaveClass(/running/);

  await bubble.click();
  await expect(page).toHaveURL(new RegExp(`/s/${back.id}$`));
  await expect(bubble).toHaveCount(0);

  await page.getByTestId("sidebar-activity-toggle").click();
  await expect(page.locator('[data-testid^="activity-recent-"]').first()).toContainText(`后台会话 ${tag}完成`);
});
