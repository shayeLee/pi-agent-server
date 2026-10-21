import type { Page, Route } from "@playwright/test";

/**
 * A route fixture got a request it does not mock. Record it and close the page at once: whatever the
 * test is waiting for fails right away with this request in its error, instead of waiting out the
 * test timeout. The tests' own `expect(unexpected).toEqual([])` still reports requests made after
 * their last page action.
 */
export async function failOnUnexpectedRequest(page: Page, route: Route, unexpected: string[],
  request = `${route.request().method()} ${new URL(route.request().url()).pathname}`): Promise<void> {
  unexpected.push(request);
  await route.abort().catch(() => {});
  await page.close({ reason: `Unexpected fixture request: ${request} (mock it, or list it in e2e/optional-features.ts)` }).catch(() => {});
}
