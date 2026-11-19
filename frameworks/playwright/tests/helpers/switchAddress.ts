import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Real account-level address change via the UI address picker — the
 * account's saved address only actually updates through this flow. A
 * cookie-only reset (setLocationCookie) does not change it, and previously
 * left the shared automation account stranded on an unintended address
 * across several CI runs when a restore step silently failed instead of
 * using this same picker.
 */
export const switchAddress = async (page: Page, matcher: RegExp) => {
  await page.getByTestId('AddressBarAddressName').click();
  await expect(page.getByTestId('AddNewAddressButton')).toBeVisible({ timeout: 15_000 });

  // Guard against a duplicate saved address silently breaking selection (a recurring
  // bug where two saved addresses end up with the same recipient name): fail loudly
  // here instead of clicking whichever match .first() happens to hit. Each saved address renders as
  // exactly one button (its full text is the accessible name), unlike getByText(matcher)
  // below which also matches the heading and subheading as separate nodes per address.
  const matches = page.getByRole('button', { name: matcher });
  await expect(matches).toHaveCount(1, { timeout: 8_000 });

  // The address list appears to re-render mid-selection (observed:
  // "element was detached from the DOM, retrying"), so retry the click
  // itself rather than letting one race kill the whole test.
  //
  // The re-render that detaches the element can happen *because* the click
  // already reached the backend and the address switch is underway — in
  // that case Playwright's click() throws even though the selection
  // succeeded, and retrying re-fires the same address-select action against
  // an address that's already active. That's a real suspect for the
  // recurring duplicate-address bug: re-selecting an already-active address
  // isn't necessarily a no-op server-side. Check whether the switch already landed before
  // retrying the click, so a slow-but-successful first attempt can't be
  // double-submitted.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await matches.first().click({ timeout: 8_000 });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      const alreadySwitched = await page
        .getByTestId('AddressBarAddressName')
        .textContent()
        .then((text) => matcher.test(text ?? ''))
        .catch(() => false);
      if (alreadySwitched) break;
      await page.waitForTimeout(500);
    }
  }

  await expect(page.getByTestId('AddressBarAddressName')).toContainText(matcher, {
    timeout: 15_000,
  });
};
