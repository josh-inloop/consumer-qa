import type { Page, Locator } from '@playwright/test';

/**
 * Best-effort: dismiss/neutralize common blocking modals/overlays that can intercept taps/clicks.
 * Safe to call repeatedly.
 *
 * Goals:
 * - Reliably dismiss Join FAM (“No Thanks” span) and Checkout Aisle (“Continue to checkout”)
 * - Avoid turning the *main* page into about:blank by accidentally clicking <a href="about:blank">
 * - Keep generic sweeping conservative so we don’t close critical in-flow modals (e.g. View Order)
 */
export async function suppressBlockingModals(page: Page): Promise<void> {
  if (page.isClosed()) return;
  if (page.url().startsWith('about:blank')) return;

  // Targeted handlers first (most reliable, least risky)
  await maybeDismissJoinFAM(page);
  await maybeHandleCheckoutAisle(page);
  await maybeDismissInviteFriendsBanner(page);

  // Conservative generic closes (avoid generic CTA texts like “Not now”, “No thanks”, “Continue”, etc.)
  const closeSelectors = [
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
    '[aria-label="Dismiss"]',
    '[aria-label="dismiss"]',
    '[data-testid*="Close"]',
    '[data-testid*="close"]',
    'button:has-text("Close")',
  ];

  for (const sel of closeSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 1000 }).catch(() => {});
    }
  }

  // Remove pointer interception from obvious full-screen overlays (best-effort).
  await page
    .evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          [
            '[role="dialog"]',
            '[role="alertdialog"]',
            '[aria-modal="true"]',
            '[data-testid*="Modal"]',
            '[data-testid*="modal"]',
            '[data-testid*="Overlay"]',
            '[data-testid*="overlay"]',
          ].join(',')
        )
      );

      for (const el of candidates) {
        const style = window.getComputedStyle(el);
        const isFixed =
          style.position === 'fixed' || style.position === 'sticky' || style.position === 'absolute';
        const coversViewport =
          el.offsetWidth >= window.innerWidth * 0.9 && el.offsetHeight >= window.innerHeight * 0.5;

        if (isFixed && coversViewport) el.style.pointerEvents = 'none';
      }
    })
    .catch(() => {});

  // Fallback: if body is locked from scrolling due to a modal, unlock it.
  await page
    .evaluate(() => {
      const body = document.body as HTMLElement | null;
      if (!body) return;
      const style = window.getComputedStyle(body);
      if (style.overflow === 'hidden') body.style.overflow = 'auto';
    })
    .catch(() => {});
}

/* ---------------- targeted handlers ---------------- */

async function maybeDismissJoinFAM(page: Page): Promise<void> {
  // Provided DOM: <span ...>No Thanks</span>
  const noThanksText = page.locator('span:has-text("No Thanks")').first();
  if (!(await noThanksText.isVisible().catch(() => false))) return;

  // Prefer safe click targets; only allow anchors that are NOT about:*
  const target = noThanksText
    .locator(
      [
        'xpath=ancestor::button[1]',
        'xpath=ancestor::*[@role="button"][1]',
        'xpath=ancestor::*[@tabindex][1]',
        'xpath=ancestor::a[1][not(starts-with(@href,"about:"))]',
        'xpath=ancestor::*[1]',
      ].join(' | ')
    )
    .first();

  await clickTightNoThrow(page, target, 4);
}

async function maybeHandleCheckoutAisle(page: Page): Promise<void> {
  // Provided screenshot: “THE CHECKOUT AISLE.” with “CONTINUE TO CHECKOUT”
  const headline = page.locator('text=THE CHECKOUT AISLE.').first();
  if (!(await headline.isVisible().catch(() => false))) return;

  // Prefer real button
  const btn = page.getByRole('button', { name: /continue to checkout/i }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click({ timeout: 1500 }).catch(() => {});
    return;
  }

  // If the CTA is an anchor, avoid about:* hrefs
  const ctaText = page.locator('text=/continue to checkout/i').first();
  if (await ctaText.isVisible().catch(() => false)) {
    const safeCta = ctaText
      .locator(
        [
          'xpath=ancestor::button[1]',
          'xpath=ancestor::*[@role="button"][1]',
          'xpath=ancestor::*[@tabindex][1]',
          'xpath=ancestor::a[1][not(starts-with(@href,"about:"))]',
          'xpath=ancestor::*[1]',
        ].join(' | ')
      )
      .first();
    await clickTightNoThrow(page, safeCta, 3);
    return;
  }

  // Close (fallback)
  const closeBtn = page.locator('button[aria-label="Close"], button[aria-label="close"]').first();
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click({ timeout: 1500 }).catch(() => {});
  }
}

async function maybeDismissInviteFriendsBanner(page: Page): Promise<void> {
  // Walk up from the "Invite friends" text node to the first positioned ancestor
  // (fixed/absolute/sticky) and disable its pointer events so it no longer
  // intercepts clicks on elements behind it.
  await page
    .evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.includes('Invite friends')) continue;
        let el: HTMLElement | null = node.parentElement;
        while (el && el !== document.body) {
          const pos = window.getComputedStyle(el).position;
          if (pos === 'fixed' || pos === 'absolute' || pos === 'sticky') {
            el.style.pointerEvents = 'none';
            return;
          }
          el = el.parentElement;
        }
        break;
      }
    })
    .catch(() => {});
}

/* ---------------- small click util ---------------- */

async function clickTightNoThrow(page: Page, loc: Locator, tries = 3): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      if (!(await loc.isVisible({ timeout: 300 }))) return;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 1000, trial: true });
      await loc.click({ timeout: 1000 });
      return;
    } catch {
      await loc.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
      await page.waitForTimeout(150).catch(() => {});
    }
  }
}