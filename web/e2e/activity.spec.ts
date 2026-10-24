import { expect, test } from "@playwright/test";

// docs/companion-butler.md §4, §6: runs in other sessions show in the sidebar and at the resident
// companion; a word on one that ended opens it. The mock holds a "[slow]" prompt's run for a moment.
const API = process.env.PI_E2E_MOCK_API!;

test("another session's run shows as running, then the companion says it ended and opens it", async ({ page, request }) => {
  const tag = Date.now();
  const create = async (title: string) => {
    const response = await request.post(`${API}/v1/sessions`, { data: { title } });
    expect(response.ok()).toBeTruthy();
    return await response.json() as { id: string; projectId: string };
  };
  const front = await create(`前台会话 ${tag}`);
  const back = await create(`后台会话 ${tag}`);

  await page.goto(`/p/${front.projectId}/s/${front.id}`);
  await expect(page.getByTestId("new-session")).toBeVisible();
  await expect(page.getByTestId(`session-${back.id}`)).toBeVisible();

  const sent = await request.post(`${API}/v1/sessions/${back.id}/messages`, { data: { requestId: `activity-${tag}`, prompt: "[slow] 后台跑一会儿" } });
  expect(sent.status()).toBe(202);

  // While it runs: marked in the list though another session is open, and counted by the companion.
  await expect(page.getByTestId(`session-${back.id}`).locator("xpath=ancestor::li")).toHaveClass(/running/);
  await expect(page.getByTestId("sidebar-companion-count")).toHaveText("1");

  const bubble = page.getByTestId("sidebar-companion-bubble");
  await expect(bubble).toContainText(`后台会话 ${tag}`);
  await expect(page.getByTestId("sidebar-companion-count")).toHaveCount(0);
  await expect(page.getByTestId(`session-${back.id}`).locator("xpath=ancestor::li")).not.toHaveClass(/running/);

  await bubble.click();
  await expect(page).toHaveURL(new RegExp(`/s/${back.id}$`));
  await expect(bubble).toHaveCount(0);

  await page.getByTestId("sidebar-companion-toggle").click();
  await expect(page.locator('[data-testid^="activity-recent-"]').first()).toContainText(`后台会话 ${tag}完成`);
});
