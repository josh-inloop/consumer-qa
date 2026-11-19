import { test, expect } from "@playwright/test";
import { dismissGuestOverlays } from '../helpers/dismissGuestOverlays';

const URL =
  "/p/san-pellegrino-sparkling-water-6pk-250ml-glass-bottle/p2863";

/**
 * Many lines are prefixed with icon glyphs (private-use Unicode chars).
 * This regex allows those without hard-coding them.
 */
function lineRegex(text: string) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^[\\uE000-\\uF8FF]{0,3}\\s*${escaped}$`, "i");
}

test.describe('P2 coverage: Promo surfaces (PDP)', () => {
  test("Why Talos module: copy", async ({ page }) => {
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await dismissGuestOverlays(page);

    // Optional anchor: scroll to title if present
    const title = page.getByText(/^Why talos\?$/i).first();
    if (await title.isVisible().catch(() => false)) {
      await title.scrollIntoViewIfNeeded();
    }

    // Section headings
    for (const heading of ["Speed", "Ownership", "Value", "Reliability"]) {
      await expect(
        page.locator("div").filter({ hasText: new RegExp(`^${heading}$`) }).first(),
        `Missing Why Talos heading: "${heading}"`
      ).toBeVisible();
    }

    // Exact copy lines (glyph-tolerant)
    const exactLines = [
      "Delivered directly to you in as fast as 15 minutes.",
      "45 min. - 1 hour+ average delivery time",
      "Multi-Hour delivery windows",

      "We own, pack and deliver 5000+ products.",
      "Dependent on third parties",

      "Lower than in-store prices. No markups or service fees.",
      "The average customer markup is 20-30%",

      "What you order is what you get; <1% substitution rate.",
      "30%+ order substitution rate",
    ];

    for (const text of exactLines) {
      await expect(
        page.getByText(lineRegex(text)).first(),
        `Missing expected copy line: "${text}"`
      ).toBeVisible();
    }

    // Mobile-safe closing line (can be split across nodes)
    await expect(
      page.getByText(/talos is instant delivery/i).first(),
      'Missing expected closing copy token: "Talos is instant delivery"'
    ).toBeVisible();

    await expect(
      page.getByText(/built different/i).first(),
      'Missing expected closing copy token: "built different"'
    ).toBeVisible();
  });
});