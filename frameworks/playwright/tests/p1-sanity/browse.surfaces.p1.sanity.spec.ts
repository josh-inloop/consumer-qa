import { test, expect, type Page } from '@playwright/test';
import { setLocationCookie } from '../helpers/setLocationCookie';
import { assertCoreChrome, assertNonEmptyBrowse } from '../helpers/pageChrome';
import { robustTap } from '../helpers/robustTap';

/**
 * Left rail is desktop/tablet. On mobile, assert an alternative “nav exists” signal.
 * Keep this deliberately permissive to avoid flaky, layout-specific failures.
 */
async function assertBrowseNavAffordance(page: Page) {
    const leftRail = page.getByTestId('LeftRailMenu');

    // If left rail exists and is visible, great (desktop/tablet)
    if (await leftRail.isVisible().catch(() => false)) {
        await expect(leftRail).toBeVisible({ timeout: 20_000 });
        return;
    }

    // Mobile fallbacks: accept any one of these as “navigation exists”
    const mobileNav = page
        .getByRole('button', { name: /menu|browse|categories/i })
        .or(page.getByRole('button', { name: /filters?/i }))
        .or(page.getByTestId(/(hamburger|menu|nav)/i))
        .or(page.getByRole('navigation'))
        .first();

    await expect(mobileNav).toBeVisible({ timeout: 20_000 });
}

test.describe('P1 sanity: Browse surfaces', () => {
    test.beforeEach(async ({ context }) => {
        await setLocationCookie(context);
    });

    test('browse surfaces load (category + storefront + deals) and navigate to a PDP', async ({ page }, testInfo) => {
        const BASE = (process.env.BASE_URL ?? 'https://www.talos.app').replace(/\/$/, '');
        const categoryPath = `${BASE}${process.env.URL_CATEGORY_HEALTH ?? '/c/health/txBAW6Hq'}`;
        const storefrontPath = `${BASE}${process.env.URL_STOREFRONT ?? '/sf/latest-greatest-latest-greatest-storefront/fDb0Uy'}`;
        const dealsPath = `${BASE}${process.env.URL_DEALS ?? '/deals/shop-all-deals/C6yLbt'}`;

        // ---------- Category ----------
        await page.goto(categoryPath, { waitUntil: 'domcontentloaded' });
        await assertCoreChrome(page);

        // Optional: confirm location cookie worked (prevents false "browse" when gated)
        await expect(page.getByText(/add an address|enter address|check availability/i)).toHaveCount(0);

        // ✅ Responsive nav assertion (LeftRail only on larger viewports)
        await assertBrowseNavAffordance(page);

        // ✅ Real content exists
        await assertNonEmptyBrowse(page);

        // ---------- Storefront ----------
        await page.goto(storefrontPath, { waitUntil: 'domcontentloaded' });
        await assertCoreChrome(page);
        await assertNonEmptyBrowse(page);

        // ---------- Deals ----------
        await page.goto(dealsPath, { waitUntil: 'domcontentloaded' });
        await assertCoreChrome(page);
        await assertNonEmptyBrowse(page);

        // ---------- PDP navigation (use category for determinism) ----------
        await page.goto(categoryPath, { waitUntil: 'domcontentloaded' });
        await assertCoreChrome(page);
        await assertNonEmptyBrowse(page);

        const firstPdpLink = page.locator('a[href*="/p/"]:visible').first();
        if (await firstPdpLink.isVisible().catch(() => false)) {
            await robustTap(firstPdpLink);
        } else {
            await robustTap(page.getByTestId('ProductTile').locator(':visible').first());
        }

        await expect(page).toHaveURL(/\/p\/|\/p\d+/, { timeout: 20_000 });
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
    });
});