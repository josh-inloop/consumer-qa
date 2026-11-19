import { test, expect } from '@playwright/test';
import { setLocationCookie } from '../helpers/setLocationCookie';

test.describe('P1 sanity: Search', () => {
  test.beforeEach(async ({ context }) => {
    await setLocationCookie(context);
  });

  test('search returns results and navigates to a PDP', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const getSearchInput = () => page.getByTestId('searchBarInput');

    await expect(getSearchInput()).toBeVisible({ timeout: 20_000 });

    // Ensure location gate is not present
    await expect(page.getByText(/add an address|enter address|check availability/i)).toHaveCount(0);

    // On narrow/mobile viewports the search bar loads collapsed behind a
    // magnifying-glass icon button; tapping it expands the same input in place.
    const collapsedSearchButton = page.getByRole('button', { name: 'Search', exact: true });
    if (await collapsedSearchButton.isVisible().catch(() => false)) {
      await collapsedSearchButton.click();
    }

    const searchInput = getSearchInput();
    await searchInput.click(); // important for CI WebKit focus reliability
    await searchInput.fill('water');

    await Promise.all([
      // Wait for either results to render or navigation to happen; avoids "Enter did nothing" flake.
      Promise.race([
        page.getByTestId('ProductTile').locator(':visible').first().waitFor({ state: 'visible' }),
        page.waitForURL(/\/search/i).catch(() => {}),
      ]),
      searchInput.press('Enter'),
    ]);

    const firstTile = page.getByTestId('ProductTile').locator(':visible').first();
    await expect(firstTile).toBeVisible({ timeout: 30_000 });

    const firstLink = firstTile.locator('a[href*="/p/"]:visible').first();
    await expect(firstLink).toBeVisible({ timeout: 20_000 });

    const href = await firstLink.getAttribute('href');
    expect(href, 'Expected first search result to include a PDP href').toMatch(/\/p\//);

    await page.goto(href!, { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveURL(/\/p\/|\/p\d+/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
  });
});