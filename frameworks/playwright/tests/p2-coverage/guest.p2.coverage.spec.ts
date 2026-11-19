import { test, expect, type Page } from '@playwright/test';
import { dismissGuestOverlays } from '../helpers/dismissGuestOverlays';
import { pickVisible, pickVisibleOrThrow } from '../helpers/pickVisible';

const BASE = (process.env.BASE_URL ?? 'https://www.talos.app').replace(/\/$/, '');
const CATEGORY_URL = `${BASE}${process.env.URL_CATEGORY ?? '/c/fresh-grocery/txafledZ'}`;
const FRESH_CATEGORY_URL = `${BASE}${process.env.URL_CATEGORY ?? '/c/fresh-grocery/txafledZ'}`;

test.describe('P2 coverage: Guest flow', () => {
  test('Guest category → PDP → Check Availability modal → promo validation', async ({ page }) => {
    await test.step('Go to category page', async () => {
      await page.goto(CATEGORY_URL, { waitUntil: 'domcontentloaded' });
      await dismissGuestOverlays(page);
      await page.waitForTimeout(300);

      await expect(page.getByTestId('ProductTileImage').first()).toBeVisible({ timeout: 30000 });
    });

    await test.step('Verify Sign In, My Bag, and generic location header', async () => {
      const signInCandidates = [
        page.getByTestId('CharlotteSecondaryButton'),
        page.getByRole('button', { name: /sign in|log in|login/i }),
        page.getByRole('link', { name: /sign in|log in|login/i }),
        page.getByText(/sign in|log in|login/i).first(),
      ];

      let signIn = await pickVisible(page, signInCandidates);
      const signInVisible = await signIn.isVisible({ timeout: 2000 }).catch(() => false);

      if (!signInVisible) {
        // On mobile viewports the Sign In CTA lives inside the collapsed nav drawer.
        // Open the hamburger/nav toggle and re-check.
        const navToggle = await pickVisible(page, [
          page.getByRole('button', { name: /menu|open menu|navigation/i }),
          page.locator('[aria-label*="menu" i]').first(),
          page.locator('header button').first(),
        ]);
        if (await navToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
          await navToggle.click();
          await page.waitForTimeout(400);
          signIn = await pickVisible(page, signInCandidates);
        }
      }

      await expect(signIn).toBeVisible({ timeout: 30000 });

      const myBag = await pickVisible(page, [
        page.getByTestId('MyBagButton'),
        page.getByRole('button', { name: /my bag|bag|cart/i }),
        page.getByRole('link', { name: /my bag|bag|cart/i }),
        page.getByLabel(/bag|cart/i).first(),
      ]);
      await expect(myBag).toBeVisible({ timeout: 30000 });

      const locationHeader = await pickVisible(page, [
        page.getByTestId('AddressBarAddressName'),
        // fallback: a common pattern is an address/location area in header
        page.locator('header').getByText(/deliver to|delivery to|address|location/i).first(),
        page.locator('header').locator('text=/[A-Za-z].*/').first(),
      ]);
      await expect(locationHeader).toBeVisible({ timeout: 30000 });

      const locationText = (await locationHeader.innerText()).trim();
      expect(locationText.length).toBeGreaterThan(0);
      expect(locationText).toMatch(/[A-Za-z]/);
    });

    await test.step('Verify category bubble rail is visible (Fresh grocery when present)', async () => {
      await page.goto(FRESH_CATEGORY_URL, { waitUntil: 'domcontentloaded' });
      await dismissGuestOverlays(page);

      // The category rail renders differently across viewports and content
      // experiments: sometimes a "Fresh grocery" bubble, sometimes a plain
      // <nav> of category links. Assert that *some* rail rendered, retrying the
      // whole candidate set in one web-first assertion (no single-shot probe).
      const categoryRail = page
        .getByTestId('BubbleCarousel')
        .or(page.getByTestId('Bubble'))
        .or(page.locator('[data-testid*="bubble" i]'))
        .or(page.getByRole('tab', { name: /fresh/i }))
        .or(page.getByRole('navigation').getByRole('link'))
        // UK category pages render no bubble rail / <nav> landmark. The category
        // structure surfaces as shelf section headings + "N items" subcategory links.
        .or(page.getByRole('link', { name: /\d+\s+items/i }))
        .or(page.getByRole('heading', { level: 2 }));

      await expect(categoryRail.first()).toBeVisible({ timeout: 30000 });
    });

    await test.step('Click a product tile and land on PDP with a purchasable CTA', async () => {
      await dismissGuestOverlays(page);

      const inStockTiles = page
        .getByTestId('ProductTile')
        .filter({ hasNot: page.getByTestId('ProductTileOutOfStock') });
      await inStockTiles.first().waitFor({ state: 'visible', timeout: 30000 });

      const count = await inStockTiles.count();
      const hrefs: string[] = [];
      for (let i = 0; i < Math.min(count, 10); i++) {
        const href = await inStockTiles.nth(i)
          .getByTestId('ProductLink')
          .getAttribute('href').catch(() => null);
        if (href) hrefs.push(href);
      }

      if (hrefs.length === 0) throw new Error('No in-stock product tiles found on category page');

      for (const href of hrefs) {
        await page.goto(href, { waitUntil: 'domcontentloaded' });
        await dismissGuestOverlays(page);
        try { await waitForPdp(page); } catch { continue; }

        // Skip product-not-found error pages quickly before waiting for a CTA.
        const isErrorState = await page.getByText(/we can.t find what you.re looking for/i)
          .isVisible({ timeout: 500 }).catch(() => false);
        if (isErrorState) continue;

        // waitForPdp resolves on the PDP shell; wait for the CTA to render after
        // product-availability data loads (isVisible would fire too early).
        const hasCta =
          await page.getByTestId('AddToBag_Add').waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false) ||
          await page.getByTestId('CTA.addToBagButton').waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false) ||
          await page.getByTestId('CheckAvailabilityButton').waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false);
        if (hasCta) return;
      }

      throw new Error(`No PDP showed a purchasable CTA in first ${hrefs.length} tiles`);
    });

    await test.step('Verify PDP CTA and optionally exercise Check Availability modal', async () => {
      const checkAvailability = page.getByTestId('CheckAvailabilityButton');
      const addToBag = page.getByTestId('AddToBag_Add');
      const ctaButton = page.getByTestId('CTA.addToBagButton');

      const cta = await pickVisibleOrThrow(
        page,
        'PDP CTA (AddToBag_Add, CTA.addToBagButton, or CheckAvailabilityButton)',
        [addToBag, ctaButton, checkAvailability],
        300,
        30000
      );

      const isCheckAvail = await checkAvailability.isVisible().catch(() => false);
      if (isCheckAvail) {
        await checkAvailability.click();
        await expect(page.getByTestId('AddressInputWeb')).toBeVisible({ timeout: 20000 });
        await page.getByTestId('DialogHeaderCloseButton').click();
        await expect(page.getByTestId('AddressInputWeb')).toBeHidden({ timeout: 20000 });
      }
    });

    if ((process.env.MARKET ?? 'us').toLowerCase() !== 'uk') {
      await test.step(`Verify "Talos's got you covered" promo placement (generic location)`, async () => {
        await expect(page.getByText(/talos's got you covered/i).first()).toBeVisible({ timeout: 20000 });

        const pdp = page.getByTestId('ProductDetailPage');
        await expect(pdp).toBeVisible({ timeout: 20000 });

        await expect(pdp).toContainText(/fastest delivery\./i);
        await expect(pdp).toContainText(/arrives in as fast as/i);
        await expect(pdp).toContainText(/we do it all\./i);
      });
    }
  });
});

async function waitForPdp(page: Page) {
  const pdp = page.getByTestId('ProductDetailPage');
  const checkAvailability = page.getByTestId('CheckAvailabilityButton');

  await Promise.race([
    pdp.waitFor({ state: 'visible', timeout: 30000 }),
    checkAvailability.waitFor({ state: 'visible', timeout: 30000 }),
  ]);

  // Guard against accidental navigation to another category page
  await expect(page).not.toHaveURL(/\/c\//i, { timeout: 15000 });
}

