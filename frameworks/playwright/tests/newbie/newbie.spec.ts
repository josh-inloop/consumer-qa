import { test, expect } from '../helpers/newbieAuthTest';

const BASE = (process.env.BASE_URL ?? 'https://www.talos.app').replace(/\/$/, '');

test.describe('Newbie regressions @us @auth', () => {
  test('newbie promo banner is visible', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/\$0 delivery.*first 3 orders/i).first()).toBeVisible({ timeout: 30_000 });
  });

  test('category bubble rail does not include Smoke Shop', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

    const carousel = page.getByTestId('BubbleCarousel').first();
    await carousel.waitFor({ state: 'visible', timeout: 30_000 });

    // Scroll carousel to its rightmost position to expose all bubbles
    await carousel.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await page.waitForTimeout(400);

    const allTexts = await carousel.getByTestId('Bubble').allInnerTexts();
    for (const text of allTexts) {
      expect(text.trim()).not.toMatch(/smoke shop/i);
    }
  });
});
