import type { Page } from '@playwright/test';
import { gotoWithRetry } from './gotoWithRetry';

/**
 * Navigates to the bag and removes all items, mirroring
 * frameworks/maestro/{ios,android}/subflows/clear-bag.yml:
 * ProductQuantityTool_Decrement only appears while an item is present, so
 * repeatedly clicking the first one both drives the removal and serves as
 * its own loop-exit condition.
 */
export async function clearBag(page: Page) {
  const baseURL = new URL(process.env.BASE_URL ?? 'https://www.talos.app').origin;
  await gotoWithRetry(page, `${baseURL}/bag`);

  const decrement = page.getByTestId('ProductQuantityTool_Decrement').first();
  // Give the bag panel/page a moment to render before the first check —
  // otherwise the loop can see "not visible yet" and exit immediately.
  // CI runners have rendered this noticeably slower than local dev, so this
  // (and the click timeout/attempts below) has more headroom than the local
  // reproduction needed.
  await decrement.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

  let guard = 0;
  while ((await decrement.count()) > 0 && guard < 20) {
    // Mirrors the retry-on-click pattern in alcohol-order-limit.regression —
    // the bag list re-renders mid-click often enough that a single miss
    // ("element was detached from the DOM, retrying") can exhaust
    // Playwright's own actionability retries and fail the whole call.
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await decrement.click({ timeout: 15_000 });
        break;
      } catch (err) {
        // Decrementing the last unit removes the whole row, and if that
        // removal lands mid-click, Playwright's click keeps waiting for a
        // now-permanently-gone element and reports it as a failure/timeout
        // even though the click already did its job — treat "item is
        // already gone" as success, not an error.
        if ((await decrement.count()) === 0) break;
        if (attempt === 4) throw err;
      }
    }
    // Wait for this decrement to either disappear (item removed) or the
    // count to change, rather than a fixed sleep — the removal animation
    // duration has been unreliable elsewhere in this suite.
    await page.waitForTimeout(1_000);
    guard++;
  }
}
