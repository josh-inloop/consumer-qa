import { expect } from '@playwright/test';
import type { Locator } from '@playwright/test';

/**
 * Scroll into view, hit-test (trial), then prefer tap with click fallback.
 * Handles "covered by overlay" issues common on iOS/WebKit.
 */
export async function robustTap(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible({ timeout: 20_000 });

  // Hit-test without clicking — surfaces overlay/intercept issues early.
  await locator.click({ trial: true, timeout: 20_000 }).catch(() => {});

  // Prefer tap on mobile; fall back to click.
  await locator.tap({ timeout: 20_000 }).catch(async () => {
    await locator.click({ timeout: 20_000 });
  });
}
