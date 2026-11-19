import type { Page, Locator } from '@playwright/test';
import { dismissGuestOverlays } from './dismissGuestOverlays';

/**
 * Single-pass: returns the first locator from the list that is currently visible.
 * Falls back to locators[0].first() so the caller receives a meaningful locator
 * for the subsequent expect() failure message.
 */
export async function pickVisible(page: Page, locators: Locator[]): Promise<Locator> {
  for (const loc of locators) {
    try {
      const candidate = loc.first();
      const count = await candidate.count().catch(() => 0);
      if (count === 0) continue;
      if (await candidate.isVisible({ timeout: 600 }).catch(() => false)) return candidate;
    } catch {
      // ignore and try next
    }
  }

  // No locator was visible; return the first so the failure message is meaningful.
  return locators[0].first();
}

/**
 * Polling: repeatedly checks candidates until one becomes visible, dismissing
 * guest overlays on each poll iteration to reduce flake.
 *
 * Throws with a descriptive error if nothing becomes visible within totalTimeoutMs.
 */
export async function pickVisibleOrThrow(
  page: Page,
  label: string,
  locators: Locator[],
  perTryTimeoutMs = 300,
  totalTimeoutMs = 12000
): Promise<Locator> {
  const start = Date.now();

  while (Date.now() - start < totalTimeoutMs) {
    await dismissGuestOverlays(page);

    for (const loc of locators) {
      try {
        const candidate = loc.first();
        const count = await candidate.count().catch(() => 0);
        if (count === 0) continue;
        if (await candidate.isVisible({ timeout: perTryTimeoutMs }).catch(() => false))
          return candidate;
      } catch {
        // ignore and try next
      }
    }

    await page.waitForTimeout(200);
  }

  throw new Error(`Could not find a visible locator for: ${label}. Tried ${locators.length} candidates.`);
}
