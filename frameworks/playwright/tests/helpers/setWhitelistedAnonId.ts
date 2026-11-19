import type { BrowserContext } from '@playwright/test';
import { URL } from 'url';

const DEFAULT_TESTING_ANON_ID = '00000000-0000-0000-0000-000000000000';

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test((value ?? '').trim());
}

function resolveCookieDomain(baseURL: string | undefined): string {
  const configured = process.env.E2E_WHITELISTED_ANON_DOMAIN?.trim();
  if (configured) return configured;

  try {
    const url = new URL(baseURL?.trim() || 'https://www.talos.app');
    const hostname = url.hostname.toLowerCase();

    if (hostname === 'talos.app' || hostname.endsWith('.talos.app')) {
      return '.talos.app';
    }

    return hostname;
  } catch {
    return '.talos.app';
  }
}

/**
 * Optionally pins a known anonId for test traffic.
 * Enabled only when E2E_FORCE_WHITELISTED_ANON_ID is truthy.
 */
export async function setWhitelistedAnonId(
  context: BrowserContext,
  baseURL?: string
): Promise<void> {
  if (!isTruthy(process.env.E2E_FORCE_WHITELISTED_ANON_ID)) return;

  const anonId = process.env.E2E_WHITELISTED_ANON_ID?.trim() || DEFAULT_TESTING_ANON_ID;
  const cookieName = process.env.E2E_WHITELISTED_ANON_COOKIE_NAME?.trim() || 'ajs_anonymous_id';
  const domain = resolveCookieDomain(baseURL);

  await context.addCookies([
    {
      name: cookieName,
      value: anonId,
      domain,
      path: '/',
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}
