import type { Page } from '@playwright/test';

/**
 * Best-effort: dismiss common guest-facing consent overlays (cookie banners,
 * "No thanks" prompts, generic close buttons) that can block interaction before
 * a user is authenticated.
 *
 * This is intentionally lightweight — it clicks buttons and catches all errors.
 * It is DISTINCT from suppressBlockingModals, which handles authenticated
 * in-flow modals (Join FAM, Checkout Aisle) using JavaScript pointer-events tricks.
 *
 * Safe to call repeatedly.
 */
export async function dismissGuestOverlays(page: Page): Promise<void> {
  const candidates = [
    page.getByRole('button', { name: /accept all/i }),
    page.getByRole('button', { name: /accept cookies/i }),
    page.getByRole('button', { name: /^accept$/i }),
    page.getByRole('button', { name: /no thanks/i }),
    page.getByRole('button', { name: /not now/i }),
    page.getByRole('button', { name: /close/i }),
    page.getByRole('button', { name: /dismiss/i }),
    page.locator('[aria-label="Close"]').first(),
    page.locator('[data-testid*="close" i]').first(),
  ];

  for (const c of candidates) {
    try {
      const candidate = c.first();
      const count = await candidate.count().catch(() => 0);
      if (count === 0) continue;

      if (await candidate.isVisible({ timeout: 600 }).catch(() => false)) {
        await candidate.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(200);
      }
    } catch {
      // ignore
    }
  }
}
