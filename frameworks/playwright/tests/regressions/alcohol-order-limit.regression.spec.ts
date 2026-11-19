import type { Locator } from '@playwright/test';
import { test, expect } from '../helpers/authTest';
import { setLocationCookie } from '../helpers/setLocationCookie';
import { clearBag } from '../helpers/clearBag';
import { suppressBlockingModals } from '../helpers/suppressBlockingModals';

// Mirrors the cross-platform Maestro spec "Alcohol Order Limit - Exceeds
// Order Limit Warning Displays in Bag": PA alcohol delivery is capped at
// 192oz per order (OUNCES_MAX cart error). Web renders this as a per-item
// "EXCEEDS ORDER LIMIT" label (BagProductImage_Subtitle) plus an order-level
// disclaimer banner (PersistentCriticalBanner, driven by BagError.tsx).

test.setTimeout(150_000);

const BASE = new URL(process.env.BASE_URL ?? 'https://www.talos.app').origin;

// Direct PDP link rather than search — web's search ranking doesn't reliably
// surface the same product first that the mobile app does.
const PDP_URL = `${BASE}/p/glen-grant-12-yr-single-malt-whiskey-750ml/p16882`;
const TARGET_QUANTITY = 8;
const DISCLAIMER_MATCH =
  /Due to Pennsylvania law, no more than 192 ounces of alcohol may be delivered from this location in a single order/i;

// The stepper's "+" occasionally drops a click (button stays enabled, no
// dialog) — retry the click itself rather than failing on the first miss.
// Reused on both the PDP and the bag page: the PDP's `ProductQuantityTool`
// only reflects local/optimistic state, so a drop there doesn't surface
// until the bag page's fresh, server-confirmed load — that's the case this
// helper being called a second time (to top up) exists to catch.
async function incrementQuantityTo(quantityTool: Locator, target: number) {
  const increment = quantityTool.getByTestId('ProductQuantityTool_Increment');
  const quantityText = quantityTool.getByTestId('ProductQuantityTool_Quantity');
  const start = Number((await quantityText.textContent())?.trim());

  for (let qty = start + 1; qty <= target; qty++) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await increment.click();
      try {
        await expect(quantityText).toHaveText(String(qty), { timeout: 3_000 });
        break;
      } catch (err) {
        if (attempt === 5) throw err;
      }
    }
  }
}

test.describe('Alcohol order limit @auth', () => {
  test.afterEach(async ({ page }) => {
    await clearBag(page).catch(() => {});
  });

  test('exceeding the alcohol ounce limit shows the bag warning and PA disclaimer', async ({
    context,
    page,
  }) => {
    // Add to Bag is disabled storefront-wide for alcohol at this location on
    // Sundays. Test can't pass regardless of product choice or rerun.
    test.skip(new Date().getDay() === 0, 'Alcohol sales are unavailable at this location on Sundays');

    await setLocationCookie(context);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await suppressBlockingModals(page);

    // Shared automation account — start from an empty bag so the tap count
    // below maps 1:1 to the resulting cart quantity.
    await clearBag(page);

    await page.goto(PDP_URL, { waitUntil: 'domcontentloaded' });
    await suppressBlockingModals(page);

    const addToBag = page.getByTestId('AddToBag_Add').first();
    await expect(addToBag).toBeVisible({ timeout: 20_000 });
    await addToBag.click();

    const quantityTool = page.getByTestId('AddToBag_QuantityTool').first();
    await expect(quantityTool).toBeVisible({ timeout: 15_000 });
    await expect(quantityTool.getByTestId('ProductQuantityTool_Quantity')).toHaveText('1', {
      timeout: 10_000,
    });

    // AddToBag_Add covers tap 1 (qty 0 -> 1); the remaining 7 taps land on
    // the stepper's "+" that replaces it, matching the mobile spec's 8 taps.
    await incrementQuantityTo(quantityTool, TARGET_QUANTITY);

    await page.goto(`${BASE}/bag`, { waitUntil: 'domcontentloaded' });

    // /bag is a fresh, server-confirmed load, unlike the PDP stepper above —
    // if a click there was dropped without the retry loop catching it, the
    // bag will be short. Verify and top it up here before asserting the
    // limit banner, rather than trusting the PDP's local quantity text.
    const bagQuantityTool = page.getByTestId('ProductQuantityTool').first();
    await expect(bagQuantityTool.getByTestId('ProductQuantityTool_Quantity')).toBeVisible({
      timeout: 15_000,
    });
    await incrementQuantityTo(bagQuantityTool, TARGET_QUANTITY);

    await expect(page.getByText('EXCEEDS ORDER LIMIT')).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByTestId('PersistentCriticalBanner').getByText(DISCLAIMER_MATCH)
    ).toBeVisible({ timeout: 20_000 });

    await clearBag(page);
  });
});
