import { test, expect } from '@playwright/test';
import { suppressBlockingModals } from '../helpers/suppressBlockingModals';

// Shipped-to-prod bug: the "Similar Products" carousel's right nav arrow
// (ScrollArrowOverlay_right) is deliberately positioned partially outside the
// carousel component (right: -21 in the Charlotte layout), but its
// HorizontalProductCollection ancestor clips with overflow-x: hidden, cutting
// off roughly half the arrow so it's not fully visible to desktop users.
// Reproduced live on https://www.talos.app/p/fancy-feast-gems-tuna-mousse-4oz/p288657.
// US-catalog product ID — origin only (drop any /gb-style market path), so
// this still targets the same PDP under the UK job as it always has.
const BASE = new URL(process.env.BASE_URL ?? 'https://www.talos.app').origin;
const PDP_URL = `${BASE}/p/fancy-feast-gems-tuna-mousse-4oz/p288657`;

test.describe('PDP regressions', () => {
  test('Similar Products carousel right arrow is not clipped by its scroll container', async ({
    page,
  }, testInfo) => {
    // Nav arrows only render on hover for non-touch desktop web (isMobileTouchScreen gates
    // them out entirely), so headless mobile-webkit never renders ScrollArrowOverlay at all.
    test.skip(
      testInfo.project.name.includes('mobile'),
      'Carousel nav arrows only render on non-touch desktop web'
    );
    test.fail(true, 'TALOS-121474: Similar Products right arrow clipped by scroll container, fix pending');

    await page.goto(PDP_URL, { waitUntil: 'domcontentloaded' });
    await suppressBlockingModals(page);

    const heading = page.getByRole('heading', { name: /similar products/i });
    await expect(heading).toBeVisible({ timeout: 20_000 });

    const section = page
      .locator('[data-testid="HorizontalProductCollection"]')
      .filter({ has: heading });
    await section.scrollIntoViewIfNeeded();
    await section.hover();

    const arrow = section.getByTestId('ScrollArrowOverlay_right');
    await expect(arrow).toBeVisible({ timeout: 10_000 });

    const [arrowBox, sectionBox] = await Promise.all([arrow.boundingBox(), section.boundingBox()]);

    expect(arrowBox, 'right arrow bounding box missing').not.toBeNull();
    expect(sectionBox, 'carousel scroll container bounding box missing').not.toBeNull();

    expect(
      arrowBox!.x + arrowBox!.width,
      `Right arrow right edge (${arrowBox!.x + arrowBox!.width}) extends past its scroll ` +
        `container's right edge (${sectionBox!.x + sectionBox!.width}) and is visually clipped`
    ).toBeLessThanOrEqual(sectionBox!.x + sectionBox!.width);
  });
});
