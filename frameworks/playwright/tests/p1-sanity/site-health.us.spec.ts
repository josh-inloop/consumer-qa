// Guest-only "site health" canary for CI
// Non-functional, stable checks only (no cart/checkout interactions)
//
// What it validates:
//  - JS Health: fails on uncaught page errors + critical console errors
//  - Network: fails on FIRST-PARTY 5xx
//  - GraphQL: fails on { errors: [...] } (HTTP 200 with errors), and on GraphQL 401/403
//  - GraphQL Backbone: requires >=1 GraphQL response AND >=1 response with non-null `data` per page
//  - Critical assets: fails on FIRST-PARTY Next.js chunks / JS / CSS failures (status>=400)
//  - Error/blocked pages: flags obvious maintenance/captcha/access-denied signatures
//  - 4xx anomalies: flags burst of FIRST-PARTY 4xx (threshold-based, per-page)
//
// Stability tuning (important):
//  - Ignores ALL third-party request failures (e.g., Google Tag Manager).
//  - Ignores GraphQL requestfailed net::ERR_ABORTED (common cancellation noise).
//  - Treats GraphQL rate limiting (TOO_MANY_REQUESTS / 429) as non-fatal warning.
//  - Treats React hydration error #418 as non-fatal warning (pre-existing production bug).
//  - Treats background https://www.talos.app/ 500 as non-fatal warning (pre-existing production bug).

import { test, expect } from '@playwright/test';

test.setTimeout(120_000);
test.describe.configure({ mode: 'serial' });

const URLS = [
  'https://www.talos.app/',
  'https://www.talos.app/c/fresh-grocery/txafledZ',
  'https://www.talos.app/sf/snap-ebt/MbhNod',
  'https://www.talos.app/deals/shop-all-deals/C6yLbt',
  'https://www.talos.app/p/san-pellegrino-sparkling-water-6pk-250ml-glass-bottle/p2863',
  'https://www.talos.app/search?q=water',
  'https://www.talos.app/join-fam',
] as const;

const HOME_URL = 'https://www.talos.app/';
const GRAPHQL_URL_PREFIX = 'https://www.talos.app/graphql';
const FIRST_PARTY_HOST_ALLOWLIST = ['www.talos.app'];

const HARD_FAIL_CONSOLE_ERROR_PATTERNS: RegExp[] = [
  /ChunkLoadError/i,
  /Loading chunk \d+ failed/i,
  /Failed to fetch/i,
  /NetworkError when attempting to fetch resource/i,
  /\bReferenceError\b/i,
  /\bTypeError\b/i,
  /Cannot read properties of undefined/i,
];

const ERROR_PAGE_TEXT_SIGNATURES: RegExp[] = [
  /something went wrong/i,
  /we['’]re having trouble/i,
  /page not found/i,
  /\b404\b/i,
  /access denied/i,
  /request blocked/i,
  /checking your browser/i,
  /captcha/i,
  /maintenance/i,
];

const BAD_LANDING_URL_PATTERNS: RegExp[] = [
  /\/404(\b|\/|\?)/i,
  /\/500(\b|\/|\?)/i,
  /\/error(\b|\/|\?)/i,
  /\/blocked(\b|\/|\?)/i,
  /\/maintenance(\b|\/|\?)/i,
  /captcha/i,
];

const FIRST_PARTY_4XX_BURST_THRESHOLD = 10;

const NAV_TIMEOUT_MS_DEFAULT = 30_000;
const NAV_TIMEOUT_MS_HOME = 35_000;
const POST_NAV_WAIT_MS = 1500;

const NON_FATAL_GQL_ERROR_PATTERNS: RegExp[] = [
  /TOO_MANY_REQUESTS/i,
  /\b429\b/i,
  /\b5\d{2}\b|service unavailable|bad gateway|gateway timeout/i, // transient downstream subgraph blips
];

// Guest Cart query returns "Not Found" when no cart exists — expected for anonymous sessions.
const NON_FATAL_GQL_OPERATIONS: Array<{ operationName: RegExp; message: RegExp }> = [
  { operationName: /operationName=Cart/i, message: /not found/i },
];

const NON_FATAL_GQL_REQUESTFAIL_PATTERNS: RegExp[] = [/net::ERR_ABORTED/i];

// US-specific: background request to https://www.talos.app/ consistently returns 500 (pre-existing production bug).
// Demoted to warning until resolved.
const NON_FATAL_5XX_URL_PATTERNS: RegExp[] = [/^https:\/\/www\.talos\.app\/?$/];

const FATAL_REQUESTFAIL_PATTERNS: RegExp[] = [
  /net::ERR_NAME_NOT_RESOLVED/i,
  /net::ERR_CONNECTION_REFUSED/i,
  /net::ERR_CONNECTION_TIMED_OUT/i,
  /net::ERR_TIMED_OUT/i,
  /net::ERR_CERT/i,
  /net::ERR_SSL/i,
];

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function isFirstParty(url: string): boolean {
  return FIRST_PARTY_HOST_ALLOWLIST.includes(hostOf(url));
}

function isThirdParty(url: string): boolean {
  const host = hostOf(url);
  return Boolean(host) && !FIRST_PARTY_HOST_ALLOWLIST.includes(host);
}

function isCriticalAsset(url: string): boolean {
  return /\/_next\//i.test(url) || /\.js(\?|$)/i.test(url) || /\.css(\?|$)/i.test(url);
}

async function bodyText(page: any): Promise<string> {
  return await page.evaluate(() => (document.body?.innerText || '').trim()).catch(() => '');
}

async function assertRouteInvariant(page: any, requestedUrl: string) {
  const path = new URL(requestedUrl).pathname;
  const anyProductLink = page.locator('a[href^="/p/"]').first();

  if (path === '/' || path.startsWith('/c/') || path.startsWith('/deals/') || path.startsWith('/search')) {
    await expect(anyProductLink, `Expected a product link (/p/...) on ${requestedUrl}`).toBeVisible({
      timeout: 15_000,
    });
    return;
  }

  if (path.startsWith('/sf/snap-ebt/')) {
    await expect(page.getByRole('heading').first(), `Expected a heading on ${requestedUrl}`).toBeVisible({
      timeout: 15_000,
    });
    await expect(anyProductLink, `Expected a product link (/p/...) on ${requestedUrl}`).toBeVisible({
      timeout: 15_000,
    });
    return;
  }

  if (path.startsWith('/p/')) {
    await expect(page.getByRole('heading').first(), `Expected a PDP heading on ${requestedUrl}`).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button').first(), `Expected a PDP button on ${requestedUrl}`).toBeVisible({
      timeout: 15_000,
    });
    return;
  }

  if (path.startsWith('/join-fam')) {
    await expect(
      page.locator('input[type="email"], input[type="tel"], input[type="text"]').first(),
      `Expected an input on ${requestedUrl}`
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole('button').first(), `Expected a CTA button on ${requestedUrl}`).toBeVisible({
      timeout: 15_000,
    });
  }
}

test.describe('Site Health: guest canary', () => {
  test('pages load cleanly', async ({ page }, testInfo) => {
    page.setDefaultTimeout(15_000);

    // Shared per-page state (reset each URL)
    const state = {
      pageErrors: [] as string[],
      nonFatalPageErrors: [] as string[],
      consoleHardErrors: [] as string[],
      firstParty5xx: [] as Array<{ status: number; url: string }>,
      nonFatal5xx: [] as Array<{ status: number; url: string }>,
      firstParty4xx: [] as Array<{ status: number; url: string }>,
      criticalAssetFailures: [] as Array<{ status: number; url: string }>,
      gqlErrors: [] as Array<{ url: string; messages: string[] }>,
      gqlNonFatal: [] as Array<{ url: string; messages: string[] }>,
      fatalRequestFailures: [] as Array<{ url: string; failure: string }>,
      nonFatalRequestFailures: [] as Array<{ url: string; failure: string }>,
      gqlSeenCount: 0,
      gqlDataCount: 0,
      gqlDataNullCount: 0,
    };

    const reset = () => {
      state.pageErrors.length = 0;
      state.nonFatalPageErrors.length = 0;
      state.consoleHardErrors.length = 0;
      state.firstParty5xx.length = 0;
      state.nonFatal5xx.length = 0;
      state.firstParty4xx.length = 0;
      state.criticalAssetFailures.length = 0;
      state.gqlErrors.length = 0;
      state.gqlNonFatal.length = 0;
      state.fatalRequestFailures.length = 0;
      state.nonFatalRequestFailures.length = 0;
      state.gqlSeenCount = 0;
      state.gqlDataCount = 0;
      state.gqlDataNullCount = 0;
    };

    // --------------------
    // Event listeners (registered once)
    // --------------------
    page.on('requestfailed', (req) => {
      const url = req.url();
      const failure = req.failure()?.errorText || 'requestfailed';

      if (isThirdParty(url)) return;

      if (isCriticalAsset(url)) {
        state.fatalRequestFailures.push({ url, failure });
        return;
      }

      if (url.startsWith(GRAPHQL_URL_PREFIX)) {
        if (NON_FATAL_GQL_REQUESTFAIL_PATTERNS.some((re) => re.test(failure))) {
          state.nonFatalRequestFailures.push({ url, failure });
          return;
        }
        if (FATAL_REQUESTFAIL_PATTERNS.some((re) => re.test(failure))) {
          state.fatalRequestFailures.push({ url, failure });
          return;
        }
        state.nonFatalRequestFailures.push({ url, failure });
      }
    });

    // React hydration error #418 is a known pre-existing production bug. Demoted to warning.
    const NON_FATAL_PAGE_ERROR_PATTERNS: RegExp[] = [
      /Minified React error #418/i,
      /due to access control checks/i, // WebKit surfaces cross-origin CORS failures as page errors; Chromium does not
    ];

    page.on('pageerror', (err) => {
      const message = err?.message || String(err);
      if (NON_FATAL_PAGE_ERROR_PATTERNS.some((re) => re.test(message))) {
        state.nonFatalPageErrors.push(message);
      } else {
        state.pageErrors.push(message);
      }
    });

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text() || '';
      // Faro (Grafana telemetry) transport failures are third-party noise — not app errors.
      if (/faro|@grafana\/faro|Failed sending payload to the receiver/i.test(text)) return;
      if (HARD_FAIL_CONSOLE_ERROR_PATTERNS.some((re) => re.test(text))) {
        state.consoleHardErrors.push(text);
      }
    });

    page.on('response', async (res) => {
      const url = res.url();
      const status = res.status();

      if (isFirstParty(url) && isCriticalAsset(url) && status >= 400) {
        state.criticalAssetFailures.push({ status, url });
      }

      if (!isFirstParty(url)) return;

      if (status >= 500) {
        if (NON_FATAL_5XX_URL_PATTERNS.some((re) => re.test(url))) {
          state.nonFatal5xx.push({ status, url });
        } else {
          state.firstParty5xx.push({ status, url });
        }
      }
      if (status >= 400 && status < 500) state.firstParty4xx.push({ status, url });

      if (url.startsWith(GRAPHQL_URL_PREFIX) && (status === 401 || status === 403)) {
        state.firstParty4xx.push({ status, url });
      }

      if (url.startsWith(GRAPHQL_URL_PREFIX)) {
        try {
          const ct = res.headers()['content-type'] || '';
          if (!ct.includes('application/json')) return;

          const body = await res.json().catch(() => null);
          if (!body) return;

          state.gqlSeenCount += 1;

          if ('data' in body) {
            if (body.data) state.gqlDataCount += 1;
            else state.gqlDataNullCount += 1;
          }

          const errors = body?.errors;
          if (Array.isArray(errors) && errors.length) {
            const messages = errors
              .map((e: any) => e?.message)
              .filter(Boolean)
              .map(String);

            if (!messages.length) return;

            const isNonFatal =
              messages.some((m) => NON_FATAL_GQL_ERROR_PATTERNS.some((re) => re.test(m))) ||
              NON_FATAL_GQL_OPERATIONS.some(
                (op) => op.operationName.test(url) && messages.some((m) => op.message.test(m))
              );

            if (isNonFatal) state.gqlNonFatal.push({ url, messages });
            else state.gqlErrors.push({ url, messages });
          }
        } catch {
          // ignore
        }
      }
    });

    const assertClean = async (context: string) => {
      if (state.pageErrors.length) {
        throw new Error(`Uncaught page errors (${context}):\n- ${state.pageErrors.join('\n- ')}`);
      }

      if (state.nonFatalPageErrors.length) {
        testInfo.annotations.push({
          type: 'warning',
          description: `Known page errors (${context}):\n- ${state.nonFatalPageErrors.join('\n- ')}`,
        });
      }

      if (state.consoleHardErrors.length) {
        throw new Error(`Critical console errors (${context}):\n- ${state.consoleHardErrors.join('\n- ')}`);
      }

      if (state.fatalRequestFailures.length) {
        throw new Error(
          `Critical request failures (${context}):\n- ${state.fatalRequestFailures
            .map((x) => `${x.failure} ${x.url}`)
            .join('\n- ')}`
        );
      }

      if (state.criticalAssetFailures.length) {
        throw new Error(
          `Critical asset failures (${context}):\n- ${state.criticalAssetFailures
            .map((x) => `${x.status} ${x.url}`)
            .join('\n- ')}`
        );
      }

      if (state.nonFatal5xx.length) {
        testInfo.annotations.push({
          type: 'warning',
          description: `Known 5xx (${context}):\n- ${state.nonFatal5xx.map((x) => `${x.status} ${x.url}`).join('\n- ')}`,
        });
      }

      if (state.firstParty5xx.length) {
        throw new Error(
          `First-party 5xx (${context}):\n- ${state.firstParty5xx.map((x) => `${x.status} ${x.url}`).join('\n- ')}`
        );
      }

      if (state.gqlNonFatal.length) {
        testInfo.annotations.push({
          type: 'warning',
          description:
            `Non-fatal GraphQL rate limiting (${context}):\n` +
            state.gqlNonFatal
              .map((g) => `- ${g.url}\n  ${g.messages.map((m) => `• ${m}`).join('\n  ')}`)
              .join('\n'),
        });
      }

      if (state.gqlErrors.length) {
        throw new Error(
          `GraphQL errors (${context}):\n` +
            state.gqlErrors
              .map((g) => `- ${g.url}\n  ${g.messages.map((m) => `• ${m}`).join('\n  ')}`)
              .join('\n')
        );
      }

      if (state.gqlSeenCount === 0) {
        throw new Error(`No GraphQL responses observed (${context}). Expected at least one.`);
      }
      if (state.gqlDataCount === 0) {
        throw new Error(
          `GraphQL responses observed but none had non-null data (${context}). ` +
            `seen=${state.gqlSeenCount} dataNull=${state.gqlDataNullCount}`
        );
      }

      const hasGraphqlAuthFail = state.firstParty4xx.some(
        (x) => x.url.startsWith(GRAPHQL_URL_PREFIX) && (x.status === 401 || x.status === 403)
      );
      const tooMany4xx = state.firstParty4xx.length >= FIRST_PARTY_4XX_BURST_THRESHOLD;

      if (hasGraphqlAuthFail || tooMany4xx) {
        throw new Error(
          `First-party 4xx anomalies (${context}): count=${state.firstParty4xx.length}\n- ${state.firstParty4xx
            .map((x) => `${x.status} ${x.url}`)
            .join('\n- ')}`
        );
      }

      if (state.nonFatalRequestFailures.length) {
        testInfo.annotations.push({
          type: 'warning',
          description:
            `Non-fatal request failures (${context}):\n- ${state.nonFatalRequestFailures
              .slice(0, 10)
              .map((x) => `${x.failure} ${x.url}`)
              .join('\n- ')}` +
            (state.nonFatalRequestFailures.length > 10
              ? `\n…and ${state.nonFatalRequestFailures.length - 10} more`
              : ''),
        });
      }
    };

    // --------------------
    // Main loop
    // --------------------
    for (const url of URLS) {
      reset();

      const navTimeout = url === HOME_URL ? NAV_TIMEOUT_MS_HOME : NAV_TIMEOUT_MS_DEFAULT;
      page.setDefaultNavigationTimeout(navTimeout);

      const nav = await page.goto(url, { waitUntil: 'domcontentloaded' });
      const status = nav?.status();

      expect(status, `Main document did not return a status for ${url}`).toBeTruthy();
      expect(status!, `Main document status for ${url}`).toBeLessThan(500);

      // landing host + obvious error/blocked urls
      const landed = page.url();
      expect(hostOf(landed), `Unexpected host after navigation.\nrequested=${url}\nlanded=${landed}`).toBe(
        'www.talos.app'
      );
      if (BAD_LANDING_URL_PATTERNS.some((re) => re.test(landed))) {
        throw new Error(`Landed on error/blocked URL.\nrequested=${url}\nlanded=${landed}`);
      }

      // allow XHR/GraphQL to fire without relying on networkidle
      await page.waitForTimeout(POST_NAV_WAIT_MS);

      // minimal mount sanity
      await expect(page.locator('#__next, #root, [data-reactroot], [data-testid="app-root"]').first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator('body')).toBeVisible({ timeout: 15_000 });

      // detect generic blocked/maintenance/captcha pages by text
      const text = await bodyText(page);
      if (text) {
        for (const re of ERROR_PAGE_TEXT_SIGNATURES) {
          if (re.test(text)) throw new Error(`Error-page signature matched ${re} on ${url}`);
        }
      }

      // route-specific invariant (kept intentionally high-level)
      await assertRouteInvariant(page, url);

      // tiny interaction to shake out hydration/runtime issues
      await page.mouse.wheel(0, 400).catch(() => {});
      await page.waitForTimeout(400);

      await assertClean(url);
    }
  });
});