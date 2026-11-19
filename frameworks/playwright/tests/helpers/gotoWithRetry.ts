import type { Page } from '@playwright/test';

/**
 * page.goto occasionally hits ERR_ABORTED from the SPA's client-side routing
 * race — retry once before failing.
 */
export async function gotoWithRetry(page: Page, url: string, timeout = 20_000) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  }
}
