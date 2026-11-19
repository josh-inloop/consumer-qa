import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Asserts the core page chrome — search bar and bag button — is visible.
 * Replaces the inline `chromeChecks()` pattern used across browse and PDP tests.
 */
export async function assertCoreChrome(page: Page): Promise<void> {
  await expect(page.getByTestId('searchBarInput')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('MyBagButton')).toBeVisible({ timeout: 20_000 });
}

/**
 * Asserts that at least one product tile or PDP link is visible on the current page.
 * Replaces `assertNonEmptyBrowse` in browse.surfaces and `waitForListing` in browse.controls.
 */
export async function assertNonEmptyBrowse(page: Page): Promise<void> {
  const visibleTiles = () => page.getByTestId('ProductTile').locator(':visible');
  const visiblePdpLinks = () => page.locator('a[href*="/p/"]:visible');

  await expect
    .poll(
      async () => {
        const tiles = await visibleTiles().count();
        const links = await visiblePdpLinks().count();
        return tiles > 0 || links > 0;
      },
      { timeout: 20_000 }
    )
    .toBe(true);
}
