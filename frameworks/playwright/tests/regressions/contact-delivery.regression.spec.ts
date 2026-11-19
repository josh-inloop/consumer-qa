import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/authTest';
import { setLocationCookie } from '../helpers/setLocationCookie';
import { clearBag } from '../helpers/clearBag';
import { gotoWithRetry } from '../helpers/gotoWithRetry';
import { suppressBlockingModals } from '../helpers/suppressBlockingModals';
import { robustTap } from '../helpers/robustTap';

// Guards TALOS-121581: the drop-off default (Contact vs Non-Contact Delivery)
// is a per-cart server signal (defaultToNCD), forced to Contact when the
// cart has fresh-food/age-restricted items — that part is working as
// designed (NonContactDeliveryInit.tsx). The reported regression was that
// the manual override never persisted across carts; fixed in 12.17.0. These
// specs lock in the current default/toggle behavior so a future break to
// that logic is caught here rather than by a customer.

test.setTimeout(120_000);

const BASE = new URL(process.env.BASE_URL ?? 'https://www.talos.app').origin;

const PLAIN_PDP_URL = `${BASE}/p/basically-purified-water-24ct-16-9oz/p48913`;
const FRESH_FOOD_PDP_URL = `${BASE}/p/caramel-frappuccino-blended-beverage/p105833`;
const ALCOHOL_PDP_URL = `${BASE}/p/glen-grant-12-yr-single-malt-whiskey-750ml/p16882`;

const NON_CONTACT_RADIO = 'DeliveryOptionsNonContact';
const CONTACT_RADIO = 'DeliveryOptionsContact';

const addToBagAndGoToCheckout = async (page: Page, pdpUrl: string) => {
  await gotoWithRetry(page, pdpUrl);
  await suppressBlockingModals(page);

  // Match by visible text, not testID — mirrors ddz.regression.spec.ts's
  // addOrUpdateBag: the underlying component/testID differs between simple
  // products (AddToBag_Add) and customizable ones (e.g. the Frappuccino's
  // Starbucks-style milk/flavor/topping flow), but the button copy stays
  // consistent ("Add to Bag" / "Update Bag") across both.
  const addToBag = page.getByText(/^(add|update).*(bag)$/i).first();
  await addToBag.waitFor({ state: 'visible', timeout: 20_000 });
  await addToBag.click({ timeout: 15_000 });
  await suppressBlockingModals(page);

  const myBag = page.getByTestId('AddToBag_QuantityTool').first().getByTestId('MyBagButton');
  await expect(myBag).toBeVisible({ timeout: 15_000 });
  await myBag.click({ timeout: 15_000 });
  await suppressBlockingModals(page);

  // Bag -> Checkout, tolerating the "THE CHECKOUT AISLE." interstitial and the
  // Checkout_Button's transient "VALIDATING" state (mirrors checkout.p1.sanity's
  // goToCheckout — a second click during validation clears the cart).
  for (let i = 0; i < 3; i++) {
    const isCheckoutReady = async () =>
      /\/checkout(\b|\/|\?)/.test(page.url()) ||
      (await page.getByTestId('DeliveryOptionsContact').isVisible().catch(() => false)) ||
      (await page.getByTestId('DeliveryOptionsNonContact').isVisible().catch(() => false)) ||
      (await page.getByTestId('PlaceOrderButton').isVisible().catch(() => false));

    if (await isCheckoutReady()) break;

    await suppressBlockingModals(page);

    // The SPA can finish navigating to checkout while this wait is still
    // polling — Checkout_Button stays in the DOM as visibility:hidden once
    // the cart page is torn down, so a bare toBeVisible() assertion has no
    // way to notice checkout was already reached and times out instead of
    // retrying. Race it against the same ready signals as isCheckoutReady().
    const checkout = page.getByTestId('Checkout_Button');
    await Promise.race(
      [
        checkout.waitFor({ state: 'visible', timeout: 45_000 }),
        page.getByTestId('DeliveryOptionsContact').waitFor({ state: 'visible', timeout: 45_000 }),
        page.getByTestId('DeliveryOptionsNonContact').waitFor({ state: 'visible', timeout: 45_000 }),
        page.getByTestId('PlaceOrderButton').waitFor({ state: 'visible', timeout: 45_000 }),
        page.waitForURL(/\/checkout(\b|\/|\?)/, { timeout: 45_000 }),
      ].map((p) => p.catch(() => {}))
    );

    if (await isCheckoutReady()) break;
    if (!(await checkout.isVisible().catch(() => false))) continue;

    const isValidating = await checkout
      .evaluate((el) => (el as HTMLElement).textContent?.toLowerCase().includes('validating') ?? false)
      .catch(() => false);

    if (isValidating) {
      await page.waitForFunction(
        () => {
          const btn = document.querySelector('[data-testid="Checkout_Button"]');
          return !btn?.textContent?.toLowerCase().includes('validating');
        },
        { timeout: 15_000 }
      ).catch(() => {});
    } else {
      await checkout.click({ trial: true, timeout: 10_000 }).catch(() => {});
      await checkout.click({ timeout: 10_000 }).catch(() => {});
    }

    await suppressBlockingModals(page);

    const charlotte = page.getByTestId('CharlottePrimaryButton').first();
    if (await charlotte.isVisible().catch(() => false)) {
      await charlotte.click({ timeout: 10_000 }).catch(() => {});
    }

    await Promise.race([
      page.waitForURL(/\/checkout(\b|\/|\?)/, { timeout: 20_000 }).catch(() => {}),
      page.getByTestId('DeliveryOptionsContact').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
      page.getByTestId('DeliveryOptionsNonContact').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
      page.getByTestId('PlaceOrderButton').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
    ]);
  }
};

// aria-selected is the reliable web signal for this design system's Radio —
// accessibilityState={{checked}} never reaches the DOM via react-native-web
// (only discrete aria-checked/accessibilityChecked props are forwarded), so
// aria-checked is not written for this component. Confirmed against
// DSBorderedControl.tsx's Pressable, which does forward aria-selected.
const expectRadioSelected = async (radio: Locator, selected: boolean) => {
  await expect(radio).toHaveAttribute('aria-selected', String(selected), { timeout: 20_000 });
};

test.describe('Contact / Non-Contact Delivery selection @auth', () => {
  test.beforeEach(async ({ context }) => {
    await setLocationCookie(context);
  });

  test.afterEach(async ({ page }) => {
    await clearBag(page).catch(() => {});
  });

  test('plain cart defaults to Non-Contact Delivery at checkout', async ({ page }) => {
    await clearBag(page);
    await addToBagAndGoToCheckout(page, PLAIN_PDP_URL);

    const nonContact = page.getByTestId(NON_CONTACT_RADIO);
    const contact = page.getByTestId(CONTACT_RADIO);
    await expect(nonContact).toBeVisible({ timeout: 30_000 });

    await expectRadioSelected(nonContact, true);
    await expectRadioSelected(contact, false);
  });

  test('fresh-food cart forces Contact Delivery as the default at checkout', async ({ page }) => {
    await clearBag(page);
    await addToBagAndGoToCheckout(page, FRESH_FOOD_PDP_URL);

    const nonContact = page.getByTestId(NON_CONTACT_RADIO);
    const contact = page.getByTestId(CONTACT_RADIO);
    await expect(contact).toBeVisible({ timeout: 30_000 });

    await expectRadioSelected(contact, true);
    await expectRadioSelected(nonContact, false);
  });

  test('manually selecting Non-Contact Delivery updates the selected radio', async ({ page }) => {
    // Fresh-food cart guarantees a deterministic starting state (Contact selected).
    await clearBag(page);
    await addToBagAndGoToCheckout(page, FRESH_FOOD_PDP_URL);

    const nonContact = page.getByTestId(NON_CONTACT_RADIO);
    const contact = page.getByTestId(CONTACT_RADIO);
    await expect(contact).toBeVisible({ timeout: 30_000 });
    await expectRadioSelected(contact, true);

    await nonContact.click({ timeout: 10_000 });

    await expectRadioSelected(nonContact, true);
    await expectRadioSelected(contact, false);
  });

  test('age-restricted cart forces Contact Delivery as the default at checkout', async ({ page }) => {
    // Add to Bag is disabled storefront-wide for alcohol at this location on
    // Sundays (mirrors alcohol-order-limit.regression) — skip rather than fail.
    test.skip(new Date().getDay() === 0, 'Alcohol sales are unavailable at this location on Sundays');

    await clearBag(page);
    await addToBagAndGoToCheckout(page, ALCOHOL_PDP_URL);

    const nonContact = page.getByTestId(NON_CONTACT_RADIO);
    const contact = page.getByTestId(CONTACT_RADIO);
    await expect(contact).toBeVisible({ timeout: 30_000 });

    await expectRadioSelected(contact, true);
    await expectRadioSelected(nonContact, false);
  });

  test('non-contact preference persists across a new cart at checkout (TALOS-121581)', async ({ page }) => {
    // First cart: fresh-food forces Contact by default; manually override to
    // Non-Contact. This is the exact regression TALOS-121581 fixed — the
    // persisted-preference read was previously dropped, so the override never
    // survived past the cart it was made in.
    await clearBag(page);
    await addToBagAndGoToCheckout(page, FRESH_FOOD_PDP_URL);

    const contact = page.getByTestId(CONTACT_RADIO);
    const nonContact = page.getByTestId(NON_CONTACT_RADIO);
    await expect(contact).toBeVisible({ timeout: 30_000 });
    await expectRadioSelected(contact, true);

    await nonContact.click({ timeout: 10_000 });
    await expectRadioSelected(nonContact, true);

    // Second, independent cart with the same fresh-food default: the
    // persisted preference from the first cart must win at checkout init
    // (resolveNCDPreference in useIsNonContactDelivery.tsx).
    await clearBag(page);
    await addToBagAndGoToCheckout(page, FRESH_FOOD_PDP_URL);

    const nonContact2 = page.getByTestId(NON_CONTACT_RADIO);
    const contact2 = page.getByTestId(CONTACT_RADIO);
    await expect(nonContact2).toBeVisible({ timeout: 30_000 });

    await expectRadioSelected(nonContact2, true);
    await expectRadioSelected(contact2, false);
  });

  const DIALOG_SELECTOR = 'dialog[open].dialog, dialog[open], [role="dialog"][aria-modal="true"]';

  // Neither automation account can reach a real handshake-required state
  // anymore: both are permanently exempted from the fraud-suspect check.
  // This mocks GetHandshakeRequired (packages/post-order/gql/documents/queries/
  // getHandshakeRequired.graphql) to force whatever state is needed instead.
  const mockHandshakeRequired = async (page: Page, cause: string) => {
    await page.route('**/graphql*', async (route) => {
      const request = route.request();
      const isHandshakeQuery =
        request.method() === 'POST'
          ? (request.postData() || '').includes('GetHandshakeRequired')
          : request.url().includes('GetHandshakeRequired');

      if (!isHandshakeQuery) {
        await route.continue();
        return;
      }

      await route.fulfill({
        body: JSON.stringify({
          data: {
            getHandshakeRequired: {
              __typename: 'GetHandshakeRequiredResponse',
              cause,
              handshakeRequired: true,
            },
          },
        }),
        contentType: 'application/json',
      });
    });
  };

  test('fraud-forced PIN handshake blocks Non-Contact with no opt-out available', async ({ page }) => {
    // cause: DNR_MODEL is a real fraud-model decision, not a user preference.
    // useHandshakeBannerLogic.ts's shouldHideOptOut = !isHandshakeRequired ||
    // !isOrderHandshakeOptedIn is true here, so the info dialog offers no way
    // out — confirmed live: only a "Close" button renders, matching
    // useDeliveryInstructionsSelection.ts forcing Contact with no bypass.
    await mockHandshakeRequired(page, 'DNR_MODEL');
    await clearBag(page);
    await addToBagAndGoToCheckout(page, PLAIN_PDP_URL);

    const nonContact = page.getByTestId(NON_CONTACT_RADIO);
    const banner = page.getByTestId('CheckoutHandshakeBanner');

    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(nonContact).toHaveAttribute('aria-disabled', 'true');

    await banner.click({ timeout: 10_000 });

    const infoDialog = page.locator(DIALOG_SELECTOR).last();
    await expect(infoDialog).toBeVisible({ timeout: 15_000 });
    await expect(infoDialog.getByText(/opt-out of pin verification/i)).toHaveCount(0);

    await expect(nonContact).toHaveAttribute('aria-disabled', 'true');
  });

  test('user-opted-in PIN preference does not block Non-Contact and can be turned off', async ({ page }) => {
    // cause: OPTED_IN means the customer previously chose PIN verification as
    // a personal safety preference, not a fraud gate — per the client-gating
    // formula from TALOS-121581 (isNotFraud = !isHandshakeRequired ||
    // isOrderHandshakeOptedIn), that preference must NOT force Contact the
    // way a real fraud cause does. Fresh-food guarantees a deterministic
    // Contact-selected starting point (see the fresh-food test above), so the
    // banner (which only shows when Contact is selected) is visible to open.
    await mockHandshakeRequired(page, 'OPTED_IN');
    await clearBag(page);
    await addToBagAndGoToCheckout(page, FRESH_FOOD_PDP_URL);

    const nonContact = page.getByTestId(NON_CONTACT_RADIO);
    const banner = page.getByTestId('CheckoutHandshakeBanner');

    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(nonContact).not.toHaveAttribute('aria-disabled', 'true');

    await banner.click({ timeout: 10_000 });

    const infoDialog = page.locator(DIALOG_SELECTOR).last();
    await expect(infoDialog).toBeVisible({ timeout: 15_000 });

    const optOutTrigger = infoDialog.getByText(/opt-out of pin verification/i).first();
    await expect(optOutTrigger).toBeVisible({ timeout: 10_000 });
    await optOutTrigger.click({ timeout: 10_000 });

    const optOutDialog = page.locator(DIALOG_SELECTOR).last();
    const confirmOptOut = optOutDialog.getByText(/^yes, opt-out$/i).first();
    await expect(confirmOptOut).toBeVisible({ timeout: 10_000 });
    await confirmOptOut.click({ timeout: 10_000 });

    await expect(banner).toHaveCount(0);
  });

  test('drop-off instructions note saves without error', async ({ page }) => {
    await clearBag(page);
    await addToBagAndGoToCheckout(page, PLAIN_PDP_URL);

    // No stable testID on this trigger in the Charlotte checkout variant
    // (CharlotteDeliveryInstructionsSelection.tsx) — match on visible text
    // instead, same as addToBagAndGoToCheckout's add-to-bag button. The note
    // persists at the account/address level, so the trigger reads
    // "Add drop-off instructions" only when empty and "Drop-off Options
    // <existing note>" once one has ever been saved — match both. The empty
    // state renders as CharlotteTypographyInlineLink (role "link"); the
    // saved-note state renders as a LineItem (role "button") — match either.
    const openDialog = page
      .getByRole('button', { name: /drop-off/i })
      .or(page.getByRole('link', { name: /drop-off/i }))
      .first();
    // Sits at the bottom of the page below banners (weather-fee, spend-more)
    // that can still be settling into place; robustTap re-scrolls and
    // hit-tests immediately before interacting instead of a single click.
    await expect(openDialog).toBeVisible({ timeout: 30_000 });
    await robustTap(openDialog);

    const dialog = page.locator('dialog[open].dialog, dialog[open], [role="dialog"][aria-modal="true"]').last();
    const note = dialog.getByTestId('DeliveryNote');
    await expect(note).toBeVisible({ timeout: 15_000 });

    await note.fill(`QA automation note ${Date.now()}`);

    const confirmBtn = dialog.getByRole('button', { name: /^confirm$/i }).first();
    await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
    await confirmBtn.click({ timeout: 10_000 });

    // Confirm clears the dialog (success path) rather than surfacing the
    // generic delivery-note error toast (DeliveryInstructionsDialog.tsx).
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(/an error occurred while trying to update delivery note/i)).toHaveCount(0);
  });
});
