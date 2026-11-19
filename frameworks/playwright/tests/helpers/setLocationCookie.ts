import type { BrowserContext } from '@playwright/test';

function resolveCookieDomains(): string[] {
    const raw = process.env.BASE_URL?.trim() || 'https://www.talos.app';
    let hostname: string;
    try {
        hostname = new URL(raw).hostname.toLowerCase();
    } catch {
        hostname = 'www.talos.app';
    }
    const apex = hostname.replace(/^www\./, '');
    return [`.${apex}`, hostname];
}

/**
 * Sets a delivery location via cookies, scoped to BASE_URL's domain.
 * Requires LOCATION_COOKIE_VALUE (URL-encoded geocode JSON) via env var.
 * GP_POS defaults to %22US%22; set to %22GB%22 for UK workflows.
 */
export async function setLocationCookie(context: BrowserContext) {
    const value = process.env.LOCATION_COOKIE_VALUE;

    if (!value) {
        throw new Error(
            'Missing LOCATION_COOKIE_VALUE. Set it in IntelliJ env vars or CI secrets.'
        );
    }

    const gpPos = process.env.GP_POS ?? '%22US%22';

    const cookieDefs = (domain: string) => [
        { name: 'talos_hp_address', value, domain, path: '/', secure: true, sameSite: 'Lax' as const },
        { name: 'gpPos', value: gpPos, domain, path: '/', secure: true, sameSite: 'Lax' as const },
    ];

    // Set on both the apex (.domain) and full host so that the more-specific
    // host-only cookie (which the server writes during login with the
    // account's saved address) is overwritten.
    await context.addCookies(resolveCookieDomains().flatMap(cookieDefs));
}