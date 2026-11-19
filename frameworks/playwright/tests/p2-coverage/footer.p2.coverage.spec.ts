import { test, expect, Page, Locator } from "@playwright/test";

const BASE = (process.env.BASE_URL ?? 'https://www.talos.app').replace(/\/$/, '');
const HOME_URL = `${BASE}/`;
const CATEGORY_URL = `${BASE}${process.env.URL_CATEGORY ?? '/c/fresh-grocery/txafledZ'}`;
const PDP_URL = `${BASE}${process.env.URL_PDP ?? '/p/san-pellegrino-sparkling-water-6pk-250ml-glass-bottle/p2863'}`;

/**
 * P2-stable footer check:
 * - Footer exists and is visible
 * - Footer contains multiple links (sanity that it rendered)
 * - At least one expected “global” link is present (light assertion)
 * - 404 routing sanity: invalid route does not result in a blank/broken page
 *
 * Notes:
 * - Avoids clicking links (less flaky, avoids navigation/geo gating surprises)
 * - Uses role-based selectors first, then fallback to <footer>
 * - 404 check is included here to keep P2 test count capped (no standalone routing test)
 */
async function getFooter(page: Page): Promise<Locator> {
    const roleFooter = page.getByRole("contentinfo").first();
    if (await roleFooter.isVisible().catch(() => false)) return roleFooter;

    const tagFooter = page.locator("footer").first();
    await expect(tagFooter, "Footer not found (no contentinfo role and no <footer> tag)").toBeVisible({
        timeout: 20_000,
    });
    return tagFooter;
}

function escapeCssId(id: string): string {
    // Node runtime may not expose global CSS.escape.
    return id.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

async function assertFooter(page: Page) {
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });

    let footer = await getFooter(page);
    await footer.scrollIntoViewIfNeeded().catch(async () => {
        // DOM re-rendered during hydration — re-query before continuing
        footer = await getFooter(page);
        await footer.scrollIntoViewIfNeeded().catch(() => {});
    });
    await expect(footer, "Footer not visible").toBeVisible({ timeout: 20_000 });

    // Sanity: footer should eventually render links (mobile/footer content can stream in).
    const links = footer.locator("a[href]").filter({ hasText: /\S/ });
    await expect
        .poll(async () => await links.count(), { timeout: 20_000, message: "Footer rendered but has no links" })
        .toBeGreaterThan(0);

    // Light “anchor” assertions: at least one expected global link is present.
    // Keep flexible to avoid copy/experiment flakes.
    const expectedAny = [/privacy/i, /terms/i, /help|support/i, /careers/i, /about/i, /contact/i];

    let found = 0;
    for (const re of expectedAny) {
        if ((await footer.locator("a[href]").filter({ hasText: re }).count().catch(() => 0)) > 0) found++;
    }
    expect(found, "Footer links present, but none of the expected global links were found").toBeGreaterThan(0);
}

async function assert404Routing(page: Page) {
    // P2 routing sanity: invalid routes should not produce a blank or broken page.
    await page.goto("/__p2_invalid_route__", { waitUntil: "domcontentloaded" });

    // Accept either a 404/not-found experience OR a safe redirect to a valid surface.
    const notFoundText = page.getByText(/404|not found|page not found/i);
    const someContent = page.locator("main").filter({ hasText: /\S/ }).first();

    await expect(
        notFoundText.or(someContent),
        "Expected 404 messaging or a valid rendered page, but got a blank/broken experience"
    ).toBeVisible({ timeout: 10_000 });
}

async function assertFaqAccordion(page: Page) {
    await page.waitForLoadState("domcontentloaded");

    const faqHeading = page.getByText(/\bFAQ\b|frequently asked/i).first();
    await expect(faqHeading, "FAQ heading/text not found").toBeVisible({ timeout: 20_000 });
    await faqHeading.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);

    const faqContainer = faqHeading.locator("xpath=ancestor::*[self::section or self::main or self::div][1]/..");
    await expect(faqContainer, "FAQ container not visible").toBeVisible({ timeout: 15_000 });

    const toggle = faqContainer
        .locator(['[aria-expanded="true"]', '[aria-expanded="false"]', "button", '[role="button"]', "summary"].join(","))
        .filter({ hasText: /\S/ })
        .first();

    await expect(toggle, "No FAQ toggle found").toBeVisible({ timeout: 15_000 });

    const controlsId = await toggle.getAttribute("aria-controls").catch(() => null);
    const panel: Locator = controlsId
        ? page.locator(`#${escapeCssId(controlsId)}`)
        : toggle
            .locator("xpath=ancestor::*[self::div or self::section][1]")
            .locator('[data-testid^="AccordionChildren-"]')
            .first();

    await expect(panel, "FAQ panel not found").toHaveCount(1);

    for (let attempts = 0; attempts < 2; attempts++) {
        if (await panel.isVisible().catch(() => false)) break;
        await toggle.click();
        await page.waitForTimeout(150);
    }

    await expect(panel, "FAQ panel exists but never became visible").toBeVisible({ timeout: 10_000 });
    await expect(panel, "FAQ panel visible but empty").toContainText(/\S+/);
}

test.describe("P2 coverage: Footer + FAQ checks", () => {
    test("Footer, 404 routing, and FAQ accordion checks", async ({ page }) => {
        await assertFooter(page);
        await assert404Routing(page);
        // UK category pages do not have an FAQ section; UK PDPs do
        if ((process.env.MARKET ?? 'us').toLowerCase() !== 'uk') {
            await page.goto(CATEGORY_URL, { waitUntil: "domcontentloaded" });
            await assertFaqAccordion(page);
        }

        await page.goto(PDP_URL, { waitUntil: "domcontentloaded" });
        await assertFaqAccordion(page);
    });
});
