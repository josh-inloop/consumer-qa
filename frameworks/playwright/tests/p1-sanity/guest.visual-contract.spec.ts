import { test, expect, Page, Locator } from '@playwright/test';
import { dismissGuestOverlays } from '../helpers/dismissGuestOverlays';
import { pickVisibleOrThrow } from '../helpers/pickVisible';

type PageKind = 'home' | 'grid';

const BASE = (process.env.BASE_URL ?? 'https://www.talos.app').replace(/\/$/, '');

const PAGES: { name: string; url: string; kind: PageKind }[] = [
  { name: 'home', url: `${BASE}/`, kind: 'home' },
  { name: 'category', url: `${BASE}${process.env.URL_CATEGORY ?? '/c/fresh-grocery/txafledZ'}`, kind: 'grid' },
  { name: 'deals-shop-all', url: `${BASE}${process.env.URL_DEALS ?? '/deals/shop-all-deals/C6yLbt'}`, kind: 'grid' },
  { name: 'search-water', url: `${BASE}${process.env.URL_SEARCH_RESULTS ?? '/search?q=water'}`, kind: 'grid' },
];

test.describe('Sanity (Visual Contract): Guest pages', () => {
  test.beforeEach(async ({ page }) => {
    // Reduce jitter from animations/transitions
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.innerHTML = `
        *, *::before, *::after { transition: none !important; animation: none !important; }
        html { scroll-behavior: auto !important; }
      `;
      document.head.appendChild(style);
    });
  });

  for (const { name, url, kind } of PAGES) {
    test(name, async ({ page }, testInfo) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await settleAfterNavigation(page);

      await dismissGuestOverlays(page);
      await settleAfterNavigation(page);

      // Fonts can shift layout; wait so bounding boxes are meaningful.
      await safeEvaluate(page, async () => {
        // @ts-ignore
        if (document.fonts?.ready) await document.fonts.ready;
      });

      // Always start at top; retry once if navigation races.
      await safeEvaluate(page, () => window.scrollTo(0, 0));
      await page.waitForTimeout(150);

      const projectName = testInfo.project.name;

      if (kind === 'home') {
        await assertHomeMinimal(page);
        return;
      }

      await assertGridVisualContract(page, projectName);
    });
  }
});

/**
 * HOME (minimal, non-brittle)
 * - page renders
 * - sign-in affordance exists
 * - page not blank
 *
 * We intentionally do NOT assert "search" on home due to UI variability.
 */
async function assertHomeMinimal(page: Page) {
  const root = await pickVisibleOrThrow(page, 'Home root', [
    page.getByTestId('HomePage'),
    page.locator('main').first(),
    page.locator('#__next').first(),
    page.locator('body').first(),
  ]);
  await expect(root).toBeVisible({ timeout: 30000 });

  // navigation chrome may be header, nav, or role="banner" depending on market/viewport
  // Wait for at least one nav element to appear — page may still be in skeleton state
  await expect(page.locator('header, nav, [role="banner"], [role="navigation"]').first()).toBeVisible({ timeout: 15000 });
  const navChrome = await page.locator('header, nav, [role="banner"], [role="navigation"]').count();
  expect(navChrome).toBeGreaterThan(0);

  const signIn = await pickVisibleOrThrow(page, 'Sign in affordance', [
    page.getByTestId('CharlotteSecondaryButton'),
    page.getByRole('button', { name: /sign in|log in|login/i }),
    page.getByRole('link', { name: /sign in|log in|login/i }),
    page.getByText(/sign in|log in|login/i).first(),
  ]);
  await expect(signIn).toBeVisible({ timeout: 30000 });

  const bodyHeight = await safeEvaluate(page, () => document.body.scrollHeight);
  expect(bodyHeight).toBeGreaterThan(600);
}

/**
 * GRID PAGES (Category / Deals / Search results with results)
 */
async function assertGridVisualContract(page: Page, projectName: string) {
  const tiles = page.getByTestId('ProductTileImage');
  const firstTile = tiles.first();

  await expect(firstTile).toBeVisible({ timeout: 30000 });
  await expectCountGreaterThan(tiles, 4);

  const firstBox = await mustHaveBoundingBox(firstTile);
  expect(firstBox.width).toBeGreaterThan(40);
  expect(firstBox.height).toBeGreaterThan(40);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  // First tile shouldn't be far below the fold
  expect(firstBox.y).toBeLessThan(viewport!.height * 0.9);

  // Desktop: avoid "everything became a single full-width column"
  if (projectName.includes('chromium-headless')) {
    expect(firstBox.width).toBeLessThan(viewport!.width * 0.92);
  }

  // Header overlap heuristic (only if header is visible)
  const header = page.locator('header').first();
  if (await header.isVisible().catch(() => false)) {
    const headerBox = await header.boundingBox();
    if (headerBox) {
      expect(firstBox.y).toBeGreaterThan(headerBox.height - 5);
    }
  }
}

/** ---------- Helpers ---------- */

async function settleAfterNavigation(page: Page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(100);
}

async function safeEvaluate<T>(page: Page, fn: () => T | Promise<T>, retries = 1): Promise<T> {
  try {
    return await page.evaluate(fn);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (retries > 0 && msg.includes('Execution context was destroyed')) {
      await settleAfterNavigation(page);
      return await safeEvaluate(page, fn, retries - 1);
    }
    throw e;
  }
}

async function mustHaveBoundingBox(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, 'Expected element to have a bounding box (not detached/hidden)').not.toBeNull();
  return box!;
}

async function expectCountGreaterThan(locator: Locator, n: number) {
  const count = await locator.count();
  expect(count, `Expected locator count > ${n} but got ${count}`).toBeGreaterThan(n);
}

