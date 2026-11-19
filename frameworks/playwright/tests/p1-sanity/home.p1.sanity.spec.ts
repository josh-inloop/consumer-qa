import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { cleanSession } from '../helpers/cleanSession';

/**
 * 1) Start gated and verify gated chrome
 * 2) While gated, assert Account entry exists
 * 3) Set delivery location (Manley)
 * 4) Verify location + re-verify gated chrome + unlocked invariants + persistence on reload
 */

/** -----------------------------
 * Address helpers
 * ------------------------------ */

async function firstVisible(locators: Locator[], timeoutMs = 20_000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const loc of locators) {
      try {
        if ((await loc.count()) > 0 && (await loc.first().isVisible())) return loc.first();
      } catch {
        // ignore transient detach
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Last attempt: return first locator so the error is meaningful
  return locators[0].first();
}

async function getAddressTextbox(scope: Page | Locator): Promise<Locator> {
  return firstVisible(
    [
      scope.getByRole('textbox', { name: /enter your address/i }),
      scope.getByRole('textbox', { name: /address/i }),
      scope.getByPlaceholder(/address/i),
      scope
        .getByTestId('AddressInputWeb')
        .locator('input, textarea, [contenteditable="true"], [role="textbox"]'),
      // Fallback: any text input inside a dialog (covers the /add-new-address modal
      // which uses a floating label rather than a native placeholder attribute)
      scope.locator('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])'),
      scope.locator('input[type="text"], input:not([type])'),
    ],
    20_000
  );
}

async function typeAddressLikeUser(
  page: Page,
  addressBox: Locator,
  value: string,
  testInfo: TestInfo
) {
  await expect(addressBox).toBeVisible({ timeout: 20_000 });
  await expect(addressBox).toBeEnabled({ timeout: 20_000 });

  const isMobile = !!testInfo.project.use?.isMobile;

  // Tap to focus on mobile (touch event); click on desktop
  isMobile ? await addressBox.tap({ force: true }) : await addressBox.click();

  // Clear whatever is there
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');

  // Slow typing everywhere; slower on mobile.
  const delay = isMobile ? 160 : 90;

  // Prefer locator.type (targets element); fallback to page keyboard
  try {
    await addressBox.type(value, { delay });
  } catch {
    await page.keyboard.type(value, { delay });
  }
}

async function selectSuggestionFromSuggestionsInScope(
  scope: Page | Locator,
  match: RegExp
) {
  const suggestions = scope.getByTestId('Suggestions');
  await expect(suggestions).toBeVisible({ timeout: 20_000 });

  const button = suggestions.getByRole('button').filter({ hasText: match }).first();
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.dispatchEvent('click');
}

async function waitForAddressUiToOpen(page: Page) {
  // dialog is kept for waitForAddressUiToClose; addressDialog is the one that
  // actually wraps AddressInputWeb — avoids misidentifying an unrelated modal
  // (cookie consent, promo overlay) as the address entry container.
  const dialog = page.getByRole('dialog').first();
  const addressDialog = page.getByRole('dialog').filter({ has: page.getByTestId('AddressInputWeb') }).first();
  const addressWrapper = page.getByTestId('AddressInputWeb').first();
  const addressTextbox = page.getByRole('textbox', { name: /enter your address/i }).first();
  const addressTextboxBroad = page.getByRole('textbox', { name: /address/i }).first();
  const addressPlaceholder = page.getByPlaceholder(/address/i).first();
  // Broad fallback: any text input inside a dialog — covers the /add-new-address
  // modal which uses a floating label rather than a native placeholder attribute.
  const dialogTextInput = page
    .locator('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])')
    .first();

  // Poll until the actual address input is visible — not just the dialog shell,
  // which renders before the form is injected asynchronously.
  await expect
    .poll(
      async () => {
        const wrapperVisible =
          (await addressWrapper.count()) > 0 &&
          (await addressWrapper.isVisible().catch(() => false));
        const textboxVisible =
          (await addressTextbox.count()) > 0 &&
          (await addressTextbox.isVisible().catch(() => false));
        const broadVisible =
          (await addressTextboxBroad.count()) > 0 &&
          (await addressTextboxBroad.isVisible().catch(() => false));
        const placeholderVisible =
          (await addressPlaceholder.count()) > 0 &&
          (await addressPlaceholder.isVisible().catch(() => false));
        const dialogInputVisible =
          (await dialogTextInput.count()) > 0 &&
          (await dialogTextInput.isVisible().catch(() => false));

        return wrapperVisible || textboxVisible || broadVisible || placeholderVisible || dialogInputVisible;
      },
      { timeout: 45_000 }
    )
    .toBeTruthy();

  const isAddressInDialog =
    (await addressDialog.count()) > 0 && (await addressDialog.isVisible().catch(() => false));

  // Wait for CSS entrance animations to finish so elements inside are stable (WebKit strict stability)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="AddressInputWeb"]') ?? document.querySelector('[role="dialog"]');
    if (!el) return Promise.resolve();
    const running = el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running');
    return running.length ? Promise.allSettled(running.map((a) => a.finished)).then(() => {}) : Promise.resolve();
  });

  return {
    dialog,
    scope: isAddressInDialog ? (addressDialog as Locator) : (page as Page),
  };
}

async function waitForAddressUiToClose(page: Page, dialog: Locator) {
  const wrapper = page.getByTestId('AddressInputWeb').first();
  const textbox = page.getByRole('textbox', { name: /enter your address/i }).first();

  await expect
    .poll(
      async () => {
        const dialogVisible =
          (await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false));
        const wrapperVisible =
          (await wrapper.count()) > 0 && (await wrapper.isVisible().catch(() => false));
        const textboxVisible =
          (await textbox.count()) > 0 && (await textbox.isVisible().catch(() => false));

        // closed when none are visible
        return !(dialogVisible || wrapperVisible || textboxVisible);
      },
      { timeout: 30_000 }
    )
    .toBeTruthy();
}

/** -----------------------------
 * Assertions
 * ------------------------------ */

async function assertGatedChrome(page: Page) {
  const headerView = page.getByTestId('persistent-header-view');
  await expect(headerView).toBeVisible({ timeout: 20_000 });

  const persistentHeader = page.getByTestId('persistent-header');
  await expect(persistentHeader).toBeAttached({ timeout: 20_000 });

  const hamburger = page.getByTestId('Hamburger');
  await expect(hamburger).toBeVisible({ timeout: 20_000 });
  await expect(hamburger).toBeEnabled({ timeout: 20_000 });
}

async function assertAccountEntryExistsWhileGated(page: Page) {
  const persistentHeader = page.getByTestId('persistent-header');
  await expect(persistentHeader).toBeAttached({ timeout: 20_000 });

  const accountEntry = await firstVisible(
    [
      // Mobile often renders SIGN IN outside persistent-header and/or as a button
      page.getByRole('button', { name: /sign in|log in|account|start shopping/i }),
      page.getByRole('link', { name: /sign in|log in|account|start shopping/i }),

      // Keep the old header-scoped ones as additional candidates
      persistentHeader.getByRole('button', { name: /sign in|log in|account|start shopping/i }),
      persistentHeader.getByRole('link', { name: /sign in|log in|account|start shopping/i }),
    ],
    12_000
  );

  await expect(accountEntry).toBeVisible({ timeout: 12_000 });
}

async function assertUnlocked(page: Page) {
  const header = page.getByTestId('persistent-header');
  await expect(header).toBeAttached({ timeout: 25_000 });

  const searchBox = header
    .locator('input[placeholder*="search" i], input[type="search"], [role="searchbox"]')
    .first();
  await expect(searchBox).toBeVisible({ timeout: 30_000 });

  const cartEntry = header
    .getByTestId(/cart/i)
    .or(page.getByTestId(/cart/i))
    .or(header.locator('a[href*="cart" i]'))
    .or(header.locator('[aria-label*="cart" i], [aria-label*="bag" i]'))
    .first();
  await expect(cartEntry).toBeVisible({ timeout: 30_000 });

  const browseSurface = page
    .locator(
      [
        '[data-testid*="category" i]',
        '[data-testid*="department" i]',
        '[data-testid*="aisle" i]',
        '[data-testid*="product" i]',
        '[data-testid*="product-card" i]',
        '[data-testid*="ProductCard" i]',
        'main:has([role="list"])',
        'main:has([role="grid"])',
      ].join(', ')
    )
    .first();
  await expect(browseSurface).toBeVisible({ timeout: 30_000 });
}

/** -----------------------------
 * Test
 * ------------------------------ */

test.describe('P1 sanity: Home — gated → set location → verify + persist', () => {
  test.beforeEach(async ({ context, page }) => {
    await cleanSession(context, page);
    // cleanSession wipes all cookies including gpPos. For markets served under a
    // sub-path (e.g. /gb), talos uses gpPos to route requests — without it the
    // server redirects to the US homepage. Re-inject only when BASE_URL has a
    // non-root path; the default US market works fine without it.
    const baseURL = (process.env.BASE_URL ?? '').trim();
    const hasMarketPath = baseURL.length > 0 && new URL(baseURL).pathname !== '/';
    if (hasMarketPath) {
      const gpPos = process.env.GP_POS;
      if (gpPos) {
        await context.addCookies([{
          name: 'gpPos',
          value: gpPos,
          domain: '.talos.app',
          path: '/',
          secure: true,
          sameSite: 'Lax' as const,
          expires: -1,
          httpOnly: false,
        }]);
      }
    }
  });

  test('gated; account entry exists', async ({ page }) => {
    // 1) Start gated and verify gated chrome
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await assertGatedChrome(page);

    // 2) While gated, ensure Account entry exists (unique assertion from navigation.gated)
    await assertAccountEntryExistsWhileGated(page);
  });

  test('set delivery; verify location + chrome; unlocked; reload persists', async ({ page }, testInfo) => {
    if (testInfo.project.use?.isMobile) test.slow();

    // 1) Start gated
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // 2) Set delivery location — follow the known-working path exactly
    const openAddress = page.getByTestId('MediaBanner_Button');
    await expect(openAddress).toBeVisible({ timeout: 20_000 });
    await expect(openAddress).toBeEnabled({ timeout: 20_000 });

    // Desktop Chromium can swallow the first click: the button is visible+enabled in
    // the DOM before React attaches its handler (hydration race), so a single click is
    // lost and the address UI never opens. Retry the click until AddressInputWeb appears.
    // (Mobile WebKit wins this race and opens on the first click.)
    const addressInputProbe = page.getByTestId('AddressInputWeb').first();
    let addressUiOpened = false;
    for (let attempt = 0; attempt < 6 && !addressUiOpened; attempt++) {
      await openAddress.click().catch(() => {});
      addressUiOpened = await addressInputProbe
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
    }

    const { dialog, scope } = await waitForAddressUiToOpen(page);

    const addressBox = await getAddressTextbox(scope);
    await typeAddressLikeUser(page, addressBox, '12 Manley Hot Springs', testInfo);

    const isMobile = !!testInfo.project.use?.isMobile;
    await selectSuggestionFromSuggestionsInScope(scope, /manley\s+hot\s+springs/i);

    const confirm = scope.getByTestId('Confirm');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await expect(confirm).toBeEnabled({ timeout: 20_000 });
    isMobile ? await confirm.dispatchEvent('click') : await confirm.click();

    // Some markets show a second map-confirmation step ("ADD NEW ADDRESS" / "SAVE AND FINISH")
    const saveAndFinish = page.getByRole('button', { name: /save and finish/i }).first();
    if (await saveAndFinish.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false)) {
      // The sheet can auto-advance and detach itself between the waitFor above and
      // this dispatch (the address gets confirmed without the click), which hangs
      // dispatchEvent for its full retry timeout waiting on a button that's gone.
      // dispatchEvent bypasses viewport constraints on mobile WebKit where the button
      // sits in a bottom sheet that Playwright cannot scroll into view
      await saveAndFinish.dispatchEvent('click', {}, { timeout: 5_000 }).catch(() => {});
    }

    await waitForAddressUiToClose(page, dialog);

    // 4) Verify location + re-verify chrome + unlocked + persistence
    const locationText = page.getByText(/manley\s+hot\s+springs/i).first();
    const locationTimeout = testInfo.project.use?.isMobile ? 60_000 : 45_000;

    await expect
      .poll(
        async () =>
          (await locationText.count()) > 0 && (await locationText.isVisible().catch(() => false)),
        { timeout: locationTimeout }
      )
      .toBeTruthy();

    await assertGatedChrome(page);
    await assertUnlocked(page);

    // Wait for any post-location-set navigation to settle before reloading.
    // On mobile WebKit, test.slow() triples the test timeout but not navigationTimeout;
    // pass an explicit timeout so the reload gets the same leniency as the rest of the test.
    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
    const reloadTimeout = testInfo.project.use?.isMobile ? 120_000 : 60_000;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: reloadTimeout });

    await expect
      .poll(
        async () =>
          (await locationText.count()) > 0 && (await locationText.isVisible().catch(() => false)),
        { timeout: locationTimeout }
      )
      .toBeTruthy();

    await assertGatedChrome(page);
    await assertUnlocked(page);
  });
});