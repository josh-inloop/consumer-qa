import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/authTest';
import { setLocationCookie } from '../helpers/setLocationCookie';
import { clearBag } from '../helpers/clearBag';
import { suppressBlockingModals } from '../helpers/suppressBlockingModals';
import { switchAddress } from '../helpers/switchAddress';
import { gotoWithRetry } from '../helpers/gotoWithRetry';

// Origin: replaces frameworks/maestro/{ios,android}/subflows/ddz-regression.yml,
// removed from the Maestro suites in commit d23d875 (CI instability + runtime
// cost). Reproduces the same scenario: switch to a DDZ address, add a
// zone-restricted item then a cross-zone item, assert the "You can get this,
// but..." conflict dialog fires on the second add, accept it, and restore
// the shared automation account to Manley.

test.setTimeout(120_000);

const BASE = new URL(process.env.BASE_URL ?? 'https://www.talos.app').origin;

const DDZ_ADDRESS_MATCH = /5000 S Broad/i;
const RESTORE_ADDRESS_MATCH = /12 Manley/i;

// Was Marlboro (p76698) — delisted/out of stock as of 2026-10-25, swapped to
// Newport (confirmed live and in stock) as the zone-restricted item.
const ZONE_RESTRICTED_PDP = `${BASE}/p/newport-cigarettes-20ct-box-1pk/p102439`;
// Was Horchata Frappuccino (p453723) — delisted (404s on prod) as of
// 2026-10-30, swapped to the sausage/cheddar/egg sandwich (confirmed live,
// in stock, and triggers the DDZ dialog) as the cross-zone item.
const CROSS_ZONE_PDP = `${BASE}/p/sausage-cheddar-egg-sandwich/p108077`;

// Match by visible text, not testID — mirrors the native Maestro flow exactly
// (text: "(?i)^(add|update).*(bag)$"), because the underlying component/testID
// differs between simple products (AddToBag_Add) and customizable ones
// (size/milk/topping flows), but the button copy stays consistent across
// both ("Add to Bag" / "Update Bag").
const addOrUpdateBag = async (page: Page) => {
  // getByRole intermittently fails to find this button — its ARIA role/name
  // isn't reliably exposed. getByText matches rendered text directly and
  // has been consistent across both simple and customizable product pages.
  // The DDZ conflict flow itself still works on prod but with real
  // latency, so give the button render more room than a typical PDP wait.
  const btn = page.getByText(/^(add|update).*(bag)$/i).first();
  await btn.waitFor({ state: 'visible', timeout: 25_000 });
  await btn.click();
};

test.describe('DDZ conflict dialog @auth', () => {
  // Safety net: restore the shared automation account to Manley regardless of
  // whether the test passed, failed, or skipped partway through. Tries the
  // real UI address-picker first (the only thing that actually changes the
  // account's saved address), falling back to the cookie if the picker
  // itself can't complete — so cleanup still does *something* even if the
  // flow under test is what's broken.
  test.afterEach(async ({ page }) => {
    let restored = false;
    for (let attempt = 1; attempt <= 3 && !restored; attempt++) {
      try {
        await switchAddress(page, RESTORE_ADDRESS_MATCH);
        restored = true;
      } catch {
        // A stale dialog/backdrop from the interrupted main flow can block
        // the address picker — reload before the next attempt to clear it.
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }

    await setLocationCookie(page.context()).catch(() => {});
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});

    // The cookie reset above does not change the account's real saved
    // address — only the UI flow above does. Swallowing a failed restore
    // here previously left the shared account stranded on the DDZ address
    // across several straight CI runs because nothing flagged it, so fail
    // loudly instead.
    if (!restored) {
      throw new Error(
        'Failed to restore shared automation account to Manley — account may be stranded on the DDZ address for subsequent @auth specs.'
      );
    }
  });

  test('switching zones via two adds triggers the DDZ dialog', async ({ page }) => {
    // Start from the account's default state (Manley), same as every other auth spec.
    await setLocationCookie(page.context());
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await suppressBlockingModals(page);

    // Shared automation account — leftover items from a prior run corrupt the
    // zone-conflict check (mirrors frameworks/maestro/*/subflows/clear-bag.yml).
    await clearBag(page);

    // /bag doesn't render the standard header (no AddressBarAddressName there) —
    // back to the homepage before anything that depends on it.
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

    // ---------- 1. Switch to the DDZ address ----------
    await switchAddress(page, DDZ_ADDRESS_MATCH);

    // ---------- 2. Add the zone-restricted item (Newport) ----------
    await gotoWithRetry(page, ZONE_RESTRICTED_PDP);

    // This PDP intermittently shows UNAVAILABLE_AT_LOCATION at this address
    // (confirmed via CI trace 2026-07-02 — real inventory at the fulfilling
    // MFC, not a coded time/schedule gate; ruled out by searching app-repo for
    // tobacco-specific sale-hours logic). Race both possible outcomes rather
    // than checking isVisible() once up front — isVisible() doesn't poll, so
    // a single check right after navigation can fire before the page has
    // resolved its real availability state and always read "not visible yet".
    const addOrUpdateBtn = page.getByText(/^(add|update).*(bag)$/i).first();
    const unavailableBtn = page.getByText(/unavailable at location/i).first();
    const outcome = await Promise.race([
      addOrUpdateBtn.waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'available' as const),
      unavailableBtn.waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'unavailable' as const),
    ]).catch(() => 'timeout' as const);

    test.skip(
      outcome === 'unavailable',
      'Cigarettes unavailable at DDZ address today — real inventory, not a bug'
    );
    if (outcome === 'timeout') {
      throw new Error(
        'Neither "Add/Update Bag" nor "Unavailable at Location" appeared for the cigarettes PDP'
      );
    }

    await addOrUpdateBtn.click();
    await expect(
      page.getByTestId('AddToBag_QuantityTool').first().getByTestId('MyBagButton')
    ).toBeVisible({ timeout: 15_000 });
    // Give the add-to-bag mutation time to settle server-side before adding
    // the cross-zone item — otherwise the zone-conflict check runs against a
    // stale cart and the dialog never fires.
    await page.waitForTimeout(4_000);

    // ---------- 3. Add the cross-zone item — this is the trigger ----------
    await gotoWithRetry(page, CROSS_ZONE_PDP);
    await addOrUpdateBag(page);

    // ---------- 4. Assert the DDZ conflict dialog fires ----------
    // Still fires reliably on prod but with a noticeable delay after the
    // cross-zone add — 20s was cutting it close.
    await expect(page.getByText('You can get this, but...')).toBeVisible({ timeout: 30_000 });

    // ---------- 5. Accept the zone change ----------
    await page.getByTestId('DialogPrimaryAction').first().click();
    await expect(page.getByText('You can get this, but...')).not.toBeVisible({ timeout: 20_000 });

    // ---------- 6. Clean up — mirrors native removing the cross-zone item post-accept ----------
    // (Restoring to Manley is now afterEach's job, so it always runs even on
    // early skip/failure, not just this success path.)
    await clearBag(page);
  });
});
