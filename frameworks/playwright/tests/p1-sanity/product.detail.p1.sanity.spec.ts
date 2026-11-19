import { test, expect } from '@playwright/test';
import { assertCoreChrome } from '../helpers/pageChrome';

test.describe('P1 sanity: Product detail page', () => {
  test('load PDP and verify core elements render + compliance + purchase-state CTA', async ({
    context,
    page,
  }, testInfo) => {
    const market = (process.env.MARKET ?? 'us').toLowerCase();
    const BASE = (process.env.BASE_URL ?? 'https://www.talos.app').replace(/\/$/, '');
    const pdpUrl = `${BASE}${process.env.URL_PDP_DETAIL ?? '/p/woodford-reserve-double-oaked-kentucky-straight-bourbon-whiskey-750-ml-90-4-proof/p12082'}`;

    // US only: override location to San Francisco (serviceable area for alcohol compliance test)
    // UK: Edinburgh location already injected via storageState in playwright.config.ts
    if (market !== 'uk') {
      const cookieDomain = `.${new URL(BASE).hostname.replace(/^www\./, '')}`;
      await context.addCookies([
        {
          name: 'talos_hp_address',
          value: encodeURIComponent(
            JSON.stringify({
              geocode_partial_match: false,
              geocode_results_count: 1,
              geocoder_postal_prefix_fallback: false,
              address: '800 North Point St',
              city: 'San Francisco',
              country: 'US',
              district: '',
              google_place_id: '',
              latitude: 37.8067,
              longitude: -122.4128,
              plus_code: '',
              route: 'North Point St',
              state: 'California',
              street_number: '800',
              zip: '94109',
              apt: '',
            })
          ),
          domain: cookieDomain,
          path: '/',
          secure: true,
          sameSite: 'Lax',
        },
      ]);
    }

    // ---------- PDP (core render + compliance + generic CTA state) ----------
    await page.goto(pdpUrl, { waitUntil: 'domcontentloaded' });

    // Global chrome sanity
    await assertCoreChrome(page);

    // Hamburger should be present/enabled, but we don't open it here (covered elsewhere)
    const hamburger = page.getByTestId('Hamburger');
    await expect(hamburger).toBeVisible({ timeout: 20_000 });
    await expect(hamburger).not.toHaveAttribute('aria-disabled', 'true');

    // PDP hero
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });

    // ✅ Required compliance messaging (US alcohol PDPs only)
    if (market !== 'uk') {
      await expect(page.getByText('Government Issued ID Required for Purchase')).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(/CA Warning: Prop 65/i).first()).toBeVisible({ timeout: 20_000 });
    }

    // ✅ Generic purchase-state check:
    // Product must either be purchasable OR show an unavailable CTA state.
    const addToBag = page
      .getByRole('button', { name: /add( to cart)?|add to bag/i })
      .first();

    const unavailableButton = page.getByTestId('UnavailableButton').first();

    await expect(
      addToBag.or(unavailableButton),
      'Expected either Add to Bag (in stock) or an Unavailable CTA, but neither was visible'
    ).toBeVisible({ timeout: 20_000 });

    // Optional: if Unavailable CTA is present, confirm it's visible/enabled/disabled depending on expected behavior.
    if ((await unavailableButton.isVisible().catch(() => false))) {
      await expect(unavailableButton).toBeVisible({ timeout: 20_000 });
    }

    // ✅ Similar Products carousel must render
    const similarProductsHeading = page.getByRole('heading', { name: /similar products/i });
    await expect(similarProductsHeading).toBeVisible({ timeout: 20_000 });

    const similarProductsSection = page
      .locator('[data-testid="HorizontalProductCollection"]')
      .filter({ has: similarProductsHeading });
    await expect(similarProductsSection).toBeVisible({ timeout: 20_000 });
  });
});