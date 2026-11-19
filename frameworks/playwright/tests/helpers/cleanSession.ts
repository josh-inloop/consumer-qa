import type { BrowserContext, Page } from '@playwright/test';

/**
 * Hard-resets client-side session state.
 *
 * Use ONLY for P0 critical flows that depend on identity,
 * auth, or delivery context.
 *
 * Do NOT use in P1/P2 sanity tests.
 */
export async function cleanSession(
    context: BrowserContext,
    page: Page
) {
    // Clear all cookies for the context
    await context.clearCookies();

    // Clear client-side storage before app code runs
    await page.addInitScript(() => {
        localStorage.clear();
        sessionStorage.clear();

        // Defensive: IndexedDB can hold delivery context in some apps
        if ('indexedDB' in window && indexedDB.databases) {
            indexedDB.databases().then((dbs) => {
                dbs.forEach((db) => {
                    if (db.name) {
                        indexedDB.deleteDatabase(db.name);
                    }
                });
            });
        }
    });
}