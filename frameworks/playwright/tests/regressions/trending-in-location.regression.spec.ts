import { test, expect } from '@playwright/test';
import { setLocationCookie } from '../helpers/setLocationCookie';
import { suppressBlockingModals } from '../helpers/suppressBlockingModals';

// The "Trending in {city}" carousel title is resolved client-side from
// shared backend data, shared across web/iOS/Android (ProductCollection.tsx):
//   title ?? data.name.replace('{city}', dzName || 'your city')
// A content/template migration dropped the "{city}" token from data.name, so
// there was nothing to replace and every platform rendered the raw fallback
// name, "Trending in Location", regardless of delivery zone
// (Slack thread p1792786903716099). Guards against that token disappearing
// again; this is a shared-data regression, not a platform-specific one, so a
// single Chromium check against production content covers all platforms.
//
// Checked on the bag page, not home: home's feed is virtualized and
// personalized, so the carousel's presence and mount timing there are
// unreliable (it renders, unmounts on scroll, or doesn't appear at all
// depending on session content — see runs 40090740471, 40090779387,
// 40091731372). The bag page renders this carousel unconditionally and
// unscrolled on load, making it a stable place to check the same title logic.
//
// US-only: asserts against the Manley Hot Springs fixture address. UK's
// talos.app/gb homepage doesn't render this carousel at all (see run
// https://github.com/owner/app-repo/actions/runs/40077817725);
// not re-verified on UK's bag page, so this stays US-only for now.

const BASE = new URL(process.env.BASE_URL ?? 'https://www.talos.app').origin;
const EXPECTED_CITY = /manley hot springs/i;

test.describe('Bag "Trending in {city}" carousel @us', () => {
  test('carousel title interpolates the real delivery-zone city, not the literal fallback', async ({
    context,
    page,
  }) => {
    await setLocationCookie(context);
    await page.goto(`${BASE}/bag`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load').catch(() => {});
    await suppressBlockingModals(page);

    // Rendered as a heading; testID coverage on this element varies between
    // the legacy and homepage-redesign render paths, so the accessible role
    // is the more stable selector. Unlike home, this carousel is mounted
    // unscrolled on load, so a plain toBeVisible (no scroll loop) is enough.
    const trendingTitle = page.getByRole('heading', { name: /^trending in/i }).first();
    await expect(trendingTitle).toBeVisible({ timeout: 20_000 });

    const titleText = (await trendingTitle.textContent())?.trim() ?? '';

    // Regression signature: the unresolved "{city}" token falls back to this
    // literal content-service node name.
    expect(titleText).not.toMatch(/^trending in location\.?$/i);
    expect(titleText).not.toContain('{city}');

    expect(titleText).toMatch(EXPECTED_CITY);
  });
});
