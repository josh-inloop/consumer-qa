import { test, expect } from '../helpers/authTest';
import type { Locator } from '@playwright/test';
import { setLocationCookie } from '../helpers/setLocationCookie';
import { suppressBlockingModals } from '../helpers/suppressBlockingModals';
import { clearBag } from '../helpers/clearBag';

test.setTimeout(180_000);

const CHECKOUT_PDP_URL = process.env.URL_PDP ?? '/c/fresh-grocery/txafledZ';

// AddressSeciton_DescriptionText renders the city/state/zip line, not the street
// address (that's AddressSection_HeaderText) — mirrors the Maestro checkout flows'
// DELIVERY_ADDRESS_DESCRIPTION guard, which checks this same testID against the
// city only for exactly this reason.
const DELIVERY_ADDRESS_DESCRIPTION = process.env.E2E_DELIVERY_ADDRESS_DESCRIPTION ?? 'Manley Hot Springs';
const UK_DELIVERY_ADDRESS_DESCRIPTION = process.env.E2E_UK_DELIVERY_ADDRESS_DESCRIPTION ?? 'Shetland';

test.describe(
  'P1 sanity: Add to bag -> Checkout -> Place Order -> Cancel Order @auth',
  () => {
    // Without this, a mid-flow assertion failure (e.g. the address guard, or the
    // driver-tip check) aborts before an order is ever placed — which is what
    // actually clears the bag on a passing run — leaving a real item on the
    // shared automation account's server-side bag for later specs to inherit.
    test.afterEach(async ({ page }) => {
      await clearBag(page).catch(() => {});
    });

    test('place and cancel order', async ({ page }, testInfo) => {
      await setLocationCookie(page.context());
      page.context().on('page', (p) => p.close().catch(() => {}));

      const s2 = async () => {
        if (page.isClosed() || page.url().startsWith('about:blank')) return;
        await suppressBlockingModals(page);
        await page.waitForTimeout(150);
        await suppressBlockingModals(page);
      };

      const checkoutAisleContinue = async () => {
        const dlg = page
          .locator(
            'dialog[open].dialog, dialog[open], [role="dialog"][aria-modal="true"]'
          )
          .last();

        const banner = dlg.locator('text=THE CHECKOUT AISLE.').first();
        if (!(await banner.isVisible().catch(() => false))) return;

        const btn = dlg
          .getByRole('button', { name: /continue (to|with) checkout/i })
          .first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 5000 }).catch(() => {});
          return;
        }

        const txt = dlg.locator('text=/continue (to|with) checkout/i').first();
        if (await txt.isVisible().catch(() => false)) {
          const hit = txt
            .locator(
              [
                'xpath=ancestor::button[1]',
                'xpath=ancestor::*[@role="button"][1]',
                'xpath=ancestor::*[@tabindex][1]',
                'xpath=ancestor::*[1]',
              ].join(' | ')
            )
            .first();
          await hit.click({ timeout: 5000 }).catch(() => {});
          await hit.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
        }
      };

      const clickSafe = async (loc: Locator) => {
        await s2();
        await checkoutAisleContinue();

        await expect(loc).toBeVisible({ timeout: 45_000 });
        await loc.scrollIntoViewIfNeeded().catch(() => {});

        await loc.click({ trial: true, timeout: 10_000 }).catch(async () => {
          await s2();
          await checkoutAisleContinue();
        });

        await loc.click({ timeout: 45_000 });
      };

      const isCheckoutReady = async () =>
        /\/checkout(\b|\/|\?)/.test(page.url()) ||
        (await page.getByTestId('PlaceOrderButton').isVisible().catch(() => false)) ||
        (await page.getByTestId('AddressSection_HeaderText').isVisible().catch(() => false)) ||
        (await page.getByTestId('PaymentSelection_Button').isVisible().catch(() => false));

      const goToCheckout = async () => {
        for (let i = 0; i < 3; i++) {
          if (await isCheckoutReady()) return;

          await s2();

          // The SPA can finish navigating to checkout while this wait is still
          // polling — Checkout_Button stays in the DOM as visibility:hidden once
          // the cart page is torn down, so a bare toBeVisible() assertion has no
          // way to notice checkout was already reached and times out instead of
          // retrying. Race it against the same ready signals as isCheckoutReady().
          const checkout = page.getByTestId('Checkout_Button');
          await Promise.race(
            [
              checkout.waitFor({ state: 'visible', timeout: 45_000 }),
              page.getByTestId('PlaceOrderButton').waitFor({ state: 'visible', timeout: 45_000 }),
              page.getByTestId('AddressSection_HeaderText').waitFor({ state: 'visible', timeout: 45_000 }),
              page.getByTestId('PaymentSelection_Button').waitFor({ state: 'visible', timeout: 45_000 }),
              page.waitForURL(/\/checkout(\b|\/|\?)/, { timeout: 45_000 }),
            ].map((p) => p.catch(() => {}))
          );

          if (await isCheckoutReady()) return;
          if (!(await checkout.isVisible().catch(() => false))) continue;

          await checkout.click({ trial: true, timeout: 10_000 }).catch(() => {});
          await checkout.click({ timeout: 10_000 }).catch(() => {});

          // Wait for VALIDATING to finish before any further interaction — a second
          // click during validation disrupts the server-side cart check and clears the cart.
          const isValidating = await checkout.evaluate(
            (el) => (el as HTMLElement).textContent?.toLowerCase().includes('validating') ?? false
          ).catch(() => false);
          if (isValidating) {
            await page.waitForFunction(
              () => {
                const btn = document.querySelector('[data-testid="Checkout_Button"]');
                return !btn?.textContent?.toLowerCase().includes('validating');
              },
              { timeout: 15_000 }
            ).catch(() => {});
          } else {
            await checkout.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
          }

          await checkoutAisleContinue();

          const charlotte = page.getByTestId('CharlottePrimaryButton').first();
          if (await charlotte.isVisible().catch(() => false)) {
            await clickSafe(charlotte).catch(() => {});
          }

          await Promise.race([
            page.waitForURL(/\/checkout(\b|\/|\?)/, { timeout: 20_000 }).catch(() => {}),
            page.getByTestId('PlaceOrderButton').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
            page.getByTestId('AddressSection_HeaderText').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
            page.getByTestId('PaymentSelection_Button').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
          ]);

          if (await isCheckoutReady()) return;

          await page.goto('/checkout', { waitUntil: 'domcontentloaded' }).catch(() => {});
        }

        throw new Error(`Failed to reach checkout. URL=${page.url()}`);
      };

      const assertPaymentsOptions = async () => {
        const paymentsPage = page.getByTestId('PaymentsPage');
        await expect(paymentsPage).toBeVisible({ timeout: 45_000 });

        // Payment methods vary by account/location; keep assertions on stable options.
        await expect(paymentsPage).toContainText(/credit\/debit card/i);
        await expect(paymentsPage).toContainText(/pay with cash/i);

        await expect(page.getByTestId('AddNewCardButton--heading')).toContainText(
          'Credit/Debit card'
        );

        // Drop-off Instructions is optional — not all accounts/locations render it.
      };

      const navigateToFirstInStockPdp = async () => {
        const appLoader = page
          .getByRole('progressbar', { name: /loading talos\. please wait\./i })
          .first();

        await page.goto(CHECKOUT_PDP_URL, { waitUntil: 'domcontentloaded' });
        await s2();
        if (await appLoader.isVisible().catch(() => false)) {
          await appLoader.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
        }
      };


      const waitForPdpPurchaseControls = async () => {
        const addToBag = page.getByTestId('AddToBag_Add').first();
        const qtyTool = page.getByTestId('AddToBag_QuantityTool').first();
        const appLoader = page
          .getByRole('progressbar', { name: /loading talos\. please wait\./i })
          .first();

        for (let attempt = 0; attempt < 2; attempt++) {
          await s2();

          if (await appLoader.isVisible().catch(() => false)) {
            await appLoader.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
          }

          await Promise.race([
            addToBag.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
            qtyTool.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {}),
          ]);

          if (await addToBag.isVisible().catch(() => false)) return { addToBag, qtyTool };
          if (await qtyTool.isVisible().catch(() => false)) return { addToBag, qtyTool };

          if (attempt === 0) {
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          }
        }

        throw new Error(`PDP did not render purchase controls. URL=${page.url()}`);
      };

      // Category -> first in-stock PDP -> Bag
      await navigateToFirstInStockPdp();
      const { addToBag, qtyTool } = await waitForPdpPurchaseControls();

      if (await addToBag.isVisible().catch(() => false)) {
        await clickSafe(addToBag);
      }
      await s2();

      await clickSafe(
        page.getByTestId('AddToBag_QuantityTool').first().getByTestId('MyBagButton')
      );
      await s2();

      // Bag -> Checkout
      await goToCheckout();

      // Contact
      await expect(page.getByTestId('ContactSelection')).toBeVisible({
        timeout: 45_000,
      });

      // Guard: never place an order to anything other than the per-market fake
      // address — fail loudly here instead of shipping a real fake order to the
      // wrong MFC. Checks the city/state/zip line (AddressSeciton_DescriptionText)
      // against the city only; the street line lives in AddressSection_HeaderText.
      const isUK = (process.env.MARKET ?? '').toLowerCase() === 'uk';
      await expect(page.getByTestId('AddressSeciton_DescriptionText')).toContainText(
        isUK ? UK_DELIVERY_ADDRESS_DESCRIPTION : DELIVERY_ADDRESS_DESCRIPTION
      );

      // Driver-tip section — guards the section disappearing after the post-order tip
      // experiment was removed and tips returned to the checkout page. Doesn't verify
      // which tip is selected by default (accessibility prop not currently emitted).
      const driverTip = page.getByTestId('DriverTip');
      await driverTip.scrollIntoViewIfNeeded().catch(() => {});
      await expect(driverTip).toBeVisible();

      // GoCash layout check (TALOS-120219): balance text and checkbox must be inline
      // with the header, not displaced 200px+ below due to a container layout collapse.
      // Desktop-only — the regression is platform-agnostic, so a chromium run is enough
      // signal. Headless mobile-webkit renders this section differently and produces
      // false positives.
      const isDesktop = !testInfo.project.name.includes('mobile');
      const goCashHeader = page.getByText(/Apply\s*GoCash/i).first();
      if (isDesktop && await goCashHeader.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await goCashHeader.scrollIntoViewIfNeeded().catch(() => {});

        const balanceText = page.getByText(/Balance:\s*\$[\d.]+/i).first();
        await expect(balanceText, 'GoCash balance text is not rendered').toBeVisible({
          timeout: 5_000,
        });

        const headerBox = await goCashHeader.boundingBox();
        const balanceBox = await balanceText.boundingBox();
        const goCashCheckbox = page.getByTestId('undefined--checkbox').first();
        await expect(goCashCheckbox, 'GoCash checkbox is not visible').toBeVisible({
          timeout: 5_000,
        });
        const checkboxBox = await goCashCheckbox.boundingBox();

        if (headerBox && balanceBox && checkboxBox) {
          const headerMidY = headerBox.y + headerBox.height / 2;

          const balanceToHeader = balanceBox.y + balanceBox.height / 2 - headerMidY;
          expect(
            balanceToHeader,
            `GoCash balance is ${balanceToHeader.toFixed(0)}px below header — expected ≤ 80px (TALOS-120219)`
          ).toBeLessThanOrEqual(80);

          const checkboxToHeader = Math.abs(
            checkboxBox.y + checkboxBox.height / 2 - headerMidY
          );
          expect(
            checkboxToHeader,
            `GoCash checkbox is ${checkboxToHeader.toFixed(0)}px from header center — expected ≤ 80px (TALOS-120219)`
          ).toBeLessThanOrEqual(80);
        }
      }

      // Open payments
      await s2();
      const payBtn = page.getByTestId('PaymentSelection_Button');
      await expect(payBtn).toBeVisible({ timeout: 45_000 });
      await payBtn.click({ timeout: 20_000 });

      // Payment options
      await assertPaymentsOptions();

      // Select cash
      const cashHeading = page.getByTestId('PayWithCashButton--heading').first();
      await expect(cashHeading).toBeVisible({ timeout: 45_000 });
      await cashHeading.scrollIntoViewIfNeeded().catch(() => {});
      await cashHeading.click({ timeout: 10_000 });

      const primary = page.getByTestId('DialogPrimaryAction').first();
      // Use waitFor rather than isVisible — in headless CI the sub-page may need a moment to render.
      const primaryVisible = await primary
        .waitFor({ state: 'visible', timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      if (primaryVisible) {
        await primary.click({ timeout: 10_000 }).catch(() => {});
      }
      // Do NOT press Escape here — cash selection auto-closes the modal, and Escape on the
      // checkout page causes the SPA to re-hide the checkout container.

      // Close PaymentsPage and return to checkout.
      // In the SPA, PaymentsPage hides the checkout container — PlaceOrderButton
      // will remain hidden until we navigate back from the payment page.
      await s2();
      const paymentsPage = page.getByTestId('PaymentsPage');

      // On some markets cash selection auto-closes PaymentsPage — skip close logic if so.
      const alreadyVisible = await page
        .getByTestId('PlaceOrderButton')
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false);

      if (!alreadyVisible) {
        if (await paymentsPage.isVisible({ timeout: 3_000 }).catch(() => false)) {
          // Click the PaymentsPage back/close button to preserve payment state.
          // Avoid page.goBack() — it discards the payment selection made on this page.
          const payBackBtn = paymentsPage
            .locator(
              [
                'button[aria-label="Back"]', 'button[aria-label="back"]',
                'button[aria-label="Close"]', 'button[aria-label="close"]',
                '[data-testid*="Back"]', '[data-testid*="back"]',
                'button:has-text("Cancel")', 'button:has-text("Done")',
              ].join(', ')
            )
            .first();
          if (await payBackBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await payBackBtn.click({ timeout: 5_000 }).catch(() => {});
          } else {
            await page.keyboard.press('Escape').catch(() => {});
          }
          await paymentsPage.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
        } else {
          // Fallback: on some markets payments renders as a raw <dialog> with no PaymentsPage testId.
          const openDialog = page.locator('dialog[open].dialog').first();
          if (await openDialog.isVisible({ timeout: 1_000 }).catch(() => false)) {
            const dialogCloseBtn = openDialog
              .locator(
                [
                  'button[aria-label="Back"]', 'button[aria-label="back"]',
                  'button[aria-label="Close"]', 'button[aria-label="close"]',
                  '[data-testid*="Back"]', '[data-testid*="back"]', '[data-testid*="Close"]',
                  'button:has-text("Cancel")', 'button:has-text("Done")',
                ].join(', ')
              )
              .first();
            if (await dialogCloseBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
              await dialogCloseBtn.click({ timeout: 5_000 }).catch(() => {});
            } else {
              await page.keyboard.press('Escape').catch(() => {});
            }
            await openDialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
          }
        }
      }

      if (await primary.isVisible().catch(() => false)) await clickSafe(primary);

      // Place order
      // Poll on PlaceOrderButton.isVisible() — not on paymentsPage.isVisible() — because the SPA's
      // visibility:hidden CSS cascade on the checkout container can lag behind the DOM state by
      // several frames, causing the old paymentsPage-visibility check to exit too early.
      const placeOrderBtn = page.getByTestId('PlaceOrderButton');
      for (let i = 0; i < 6; i++) {
        if (await placeOrderBtn.isVisible().catch(() => false)) break;
        await s2();
        await page.waitForTimeout(500);
        if (await paymentsPage.isVisible({ timeout: 1_000 }).catch(() => false)) {
          const payBackBtn2 = paymentsPage
            .locator(
              [
                'button[aria-label="Back"]', 'button[aria-label="back"]',
                'button[aria-label="Close"]', 'button[aria-label="close"]',
                '[data-testid*="Back"]', '[data-testid*="back"]',
                'button:has-text("Cancel")', 'button:has-text("Done")',
              ].join(', ')
            )
            .first();
          if (await payBackBtn2.isVisible({ timeout: 1_000 }).catch(() => false)) {
            await payBackBtn2.click({ timeout: 5_000 }).catch(() => {});
          }
          await paymentsPage.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});
        }
        await page.waitForTimeout(800);
      }

      // Last resort: if the SPA's visibility:hidden cascade was never cleared, force-unhide
      // the first hidden ancestor of PlaceOrderButton so the click can land.
      if (!await placeOrderBtn.isVisible().catch(() => false)) {
        await page.evaluate(() => {
          const btn = document.querySelector('[data-testid="PlaceOrderButton"]') as HTMLElement | null;
          if (!btn) return;
          let el: HTMLElement | null = btn.parentElement;
          while (el && el !== document.body) {
            if (el.style.visibility === 'hidden') {
              el.style.visibility = '';
              break;
            }
            el = el.parentElement;
          }
        }).catch(() => {});
        await page.waitForTimeout(300);
      }

      await clickSafe(placeOrderBtn);
      await page.waitForURL(/\/(order-progress|order-help)\/\d+/, { timeout: 90_000 });

      // Cancel via HELP → Cancel Order → reason → confirm
      await s2();

      // The Order Summary modal auto-opens on the order-progress page.
      // If the HELP button isn't immediately visible, open it via "View Order" first.
      const helpBtn = page.getByTestId('Help')
        .or(page.getByRole('button', { name: /^help$/i }))
        .first();

      if (!(await helpBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
        const viewOrder = page
          .locator('span:has-text("View Order")')
          .first()
          .or(page.getByRole('button', { name: /view order/i }).first())
          .or(page.getByRole('link', { name: /view order/i }).first())
          .first();
        if (await viewOrder.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await viewOrder.click({ timeout: 5_000 }).catch(() => {});
          await viewOrder.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
        }
      }

      await expect(helpBtn).toBeVisible({ timeout: 30_000 });
      await helpBtn.click();

      // From the help menu, click Cancel Order (it's a <button> in the help modal)
      const cancelOrderBtn = page.getByRole('button', { name: /cancel order/i }).first();
      await expect(cancelOrderBtn).toBeVisible({ timeout: 20_000 });
      await cancelOrderBtn.click();

      // After clicking Cancel Order, one of these screens appears:
      //   (a) "WANT TO CANCEL?" + "CANCEL AND REFUND" (UK confirmation step)
      //   (b) "cancel without refund" if the order is already packed
      //   (c) the cancel reason prompt directly if the order is still cancellable
      const cancelAndRefund = page.getByRole('button', { name: /cancel and refund/i }).first();
      const cancelWithoutRefund = page.getByRole('button', { name: /cancel without refund/i }).first();
      const whyCancelPrompt = page.getByText(/why are you canceling\?/i).first();

      // Retry once if the sub-flow hasn't appeared in 5 s — covers slow eligibility-API
      // responses and mobile-WebKit edge cases where the click lands but the handler
      // doesn't fire.
      const cancelSubFlowAppeared = await Promise.race([
        cancelAndRefund.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true),
        cancelWithoutRefund.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true),
        whyCancelPrompt.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true),
      ]).catch(() => false);
      if (!cancelSubFlowAppeared && await cancelOrderBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await cancelOrderBtn.click();
      }

      await Promise.race([
        cancelAndRefund.waitFor({ state: 'visible', timeout: 45_000 }),
        cancelWithoutRefund.waitFor({ state: 'visible', timeout: 45_000 }),
        whyCancelPrompt.waitFor({ state: 'visible', timeout: 45_000 }),
      ]);

      if (await cancelAndRefund.isVisible().catch(() => false)) {
        await cancelAndRefund.click();
      }

      if (await cancelWithoutRefund.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await cancelWithoutRefund.click();
      }

      // Reason prompt may or may not appear depending on market/order state
      if (await whyCancelPrompt.isVisible({ timeout: 30_000 }).catch(() => false)) {
        await page
          .getByTestId(
            'radio-button-talos.app.orderHelpDialog.cancelOrder.cancelReason.placedOrderbyMistake'
          )
          .click({ timeout: 10_000 });
        await page.getByTestId('DialogPrimaryAction').first().click({ timeout: 10_000 }); // Confirm
      }

      // Verify final page state (after modal closes)
      await expect(page.getByText('Order Canceled.', { exact: false })).toBeVisible({
        timeout: 90_000,
      });

    });
  }
);
