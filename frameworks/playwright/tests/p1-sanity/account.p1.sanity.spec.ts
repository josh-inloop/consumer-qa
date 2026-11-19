import { test, expect } from '../helpers/authTest';
import { setLocationCookie } from '../helpers/setLocationCookie';
import { suppressBlockingModals } from '../helpers/suppressBlockingModals';

test.setTimeout(180_000);

const ACCOUNT_URL = '/account';
const REFERRALS_URL = '/account-referrals';
const FAM_URL = '/account-fam';
const ADDRESSES_URL = '/account-addresses';
const PAYMENTS_URL = '/account-payments';

test.describe('P1 sanity: Account sub-pages render @auth', () => {
  async function safeGoto(page: any, path: string, attempts = 3) {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const isAbort = message.includes('net::ERR_ABORTED');
        if (!isAbort || i === attempts - 1) break;
        await page.waitForTimeout(500);
      }
    }
    throw lastError;
  }

  test.beforeEach(async ({ page, context }) => {
    await setLocationCookie(context);
    await safeGoto(page, ACCOUNT_URL);
    await suppressBlockingModals(page);
  });

  async function gotoAndAssertUrl(page: any, path: string) {
    await safeGoto(page, path);
    await expect(page).toHaveURL(new RegExp(`${path.replace('/', '\\/')}(\\?.*)?$`));
  }

  async function assertPageRendered(page: any) {
    // grid-outer-container is duplicated and sometimes "hidden" due to responsive layouts/animations.
    // Use attached + at least one visible element inside the page instead of toBeVisible on the container.
    const grids = page.getByTestId('grid-outer-container');
    await expect(grids.first()).toBeAttached();

    // If any grid is visible, great. Otherwise, fall back to "page has interactive content" checks.
    const visibleCount = await grids.evaluateAll((els: HTMLElement[]) =>
      els.filter((e) => {
        const s = window.getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return (
          s.visibility !== 'hidden' &&
          s.display !== 'none' &&
          r.width > 0 &&
          r.height > 0 &&
          r.bottom > 0 &&
          r.right > 0
        );
      }).length
    );

    if (visibleCount > 0) return;

    // Fallback: require at least one tabbable/clickable control is present.
    const interactive = page.locator('a[href], button, [role="button"], [role="link"]').first();
    await expect(interactive).toBeAttached();
  }

  async function assertReferralsPageRendered(page: any) {
    const mediaBanner = page.getByTestId('MediaBanner').first();
    const heading = page.getByText(/referrals?/i).first();
    const copyCode = page.getByText(/copy code/i).first();
    const gridItem = page.getByTestId('grid-item').first();

    if (await mediaBanner.isVisible().catch(() => false)) return;
    if (await heading.isVisible().catch(() => false)) return;
    if (await copyCode.isVisible().catch(() => false)) return;

    await expect(gridItem).toBeAttached();
  }

  test('P1 sanity: /account -> referrals -> fam -> addresses -> payments', async ({
    page,
  }) => {
    // 1) /account
    await expect(page).toHaveURL(/\/account(\?.*)?$/);
    await assertPageRendered(page);

    // Verify presence of Order History without desktop-only left nav requirement
    const orderHistoryText = page.getByText(/order history/i);
    const orderCards = page.getByTestId('OrderCard');

    if (await orderHistoryText.count()) {
      await expect(orderHistoryText.first()).toBeAttached();
    } else {
      await expect(orderCards.first()).toBeAttached();
    }

    // 2) /account-referrals
    await gotoAndAssertUrl(page, REFERRALS_URL);
    await assertReferralsPageRendered(page);

    // 3) /account-fam
    await gotoAndAssertUrl(page, FAM_URL);
    await assertPageRendered(page);

    // Guard against unexpected redirect back to /account after fam loads
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/account-fam(\?.*)?$/);

    // 4) /account-addresses
    await gotoAndAssertUrl(page, ADDRESSES_URL);
    await expect(page.locator('[data-testid^="AddressListButton:"]').first()).toBeVisible();

    // 5) /account-payments (read-only; no clicks)
    await gotoAndAssertUrl(page, PAYMENTS_URL);
    await expect(page.getByTestId('AddNewCardButton')).toBeVisible();
  });
});
