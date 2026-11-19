import dotenv from 'dotenv';
import path from 'path';

const market = process.env.MARKET?.toLowerCase() || 'us';
// Only load .env files locally — in CI all env vars come from the workflow
if (!process.env.GITHUB_ACTIONS) {
  dotenv.config({ path: path.resolve(__dirname, `../../.env.${market}`) });
}
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const CONFIG_DIR = __dirname;
const REPO_ROOT = path.resolve(CONFIG_DIR, '../..');

const ARTIFACTS_DIR = path.resolve(CONFIG_DIR, '../../artifacts');
const TEST_RESULTS_DIR = path.join(ARTIFACTS_DIR, 'playwright', 'test-results');
const HTML_REPORT_DIR = path.join(ARTIFACTS_DIR, 'playwright-report');

const IPHONE = devices['iPhone 14 Plus'];

// Real CI detection only (prevents VS Code CI=true from flipping behavior)
const isCI =
  !!process.env.GITHUB_ACTIONS ||
  !!process.env.BUILDKITE ||
  !!process.env.CIRCLECI ||
  !!process.env.GITLAB_CI ||
  !!process.env.JENKINS_URL ||
  !!process.env.TEAMCITY_VERSION;
const runAuthInCI = /^(1|true|yes)$/i.test((process.env.PW_RUN_AUTH_IN_CI ?? '').trim());

const baseUrlHost = (() => {
  try {
    return new URL(process.env.BASE_URL || 'https://www.talos.app').hostname.toLowerCase();
  } catch {
    return 'www.talos.app';
  }
})();

const LOCAL_TEST_MATCH = [
  // frameworks tests
  'frameworks/**/*.spec.ts',
  'frameworks/**/*.test.ts',
];

const CI_TEST_MATCH = [
  // CI is limited to this tree only
  'frameworks/playwright/tests/**/*.spec.ts',
  'frameworks/playwright/tests/**/*.test.ts',
];

const config: PlaywrightTestConfig = defineConfig({
  testDir: REPO_ROOT,

  testMatch: isCI ? CI_TEST_MATCH : LOCAL_TEST_MATCH,

  testIgnore: [
    // never treat helper scripts as tests
    '**/*.setup.ts',

    // Market-specific exclusions: skip tests that only apply to the other market
    ...(market === 'uk'
      ? [
          '**/site-health.us.spec.ts',
          '**/promo.surfaces.p2.coverage.spec.ts',
        ]
      : [
          '**/site-health.uk.spec.ts',
        ]),

    ...(isCI
      ? [
          // CI must never run these (keep explicit CI exclusions)
          'frameworks/playwright/tests/**/setup/**',
          'frameworks/playwright/tests/**/auth/**',
        ]
      : []),
  ],

  // CI runs the guest suite by default; auth specs are excluded and run separately in Phase 1.
  grepInvert: isCI && !runAuthInCI ? /@auth/ : undefined,

  forbidOnly: isCI,
  fullyParallel: !isCI,

  timeout: isCI ? 120_000 : 60_000,
  expect: { timeout: isCI ? 30_000 : 20_000 },

  // Keep your existing behavior
  retries: 0,
  workers: isCI ? 1 : undefined,

  outputDir: TEST_RESULTS_DIR,

  use: {
    browserName: 'chromium',
    headless: isCI,

    viewport: { width: 1280, height: 800 },
    baseURL: process.env.BASE_URL?.trim() || 'https://www.talos.app',

    // Pre-inject location cookies so every context (including plain `page` fixtures)
    // starts with the correct market. Auth tests override this via their own storageState,
    // which already includes these cookies from generate-auth.setup.ts.
    ...(process.env.LOCATION_COOKIE_VALUE && {
      storageState: {
        cookies: [
          {
            name: 'talos_hp_address',
            value: process.env.LOCATION_COOKIE_VALUE,
            domain: `.${baseUrlHost.replace(/^www\./, '')}`,
            path: '/',
            secure: true,
            sameSite: 'Lax' as const,
            expires: -1,
            httpOnly: false,
          },
          {
            name: 'gpPos',
            value: process.env.GP_POS ?? '%22US%22',
            domain: `.${baseUrlHost.replace(/^www\./, '')}`,
            path: '/',
            secure: true,
            sameSite: 'Lax' as const,
            expires: -1,
            httpOnly: false,
          },
        ],
        origins: [],
      },
    }),

    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    navigationTimeout: isCI ? 60_000 : 30_000,
    actionTimeout: isCI ? 30_000 : 15_000,
  },

  projects: isCI
    ? [
        { name: 'chromium-headless', use: { browserName: 'chromium', headless: true, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36' } },
        { name: 'mobile-webkit-headless', use: { ...IPHONE, browserName: 'webkit', headless: true } },
      ]
    : [
        { name: 'chrome-headed', use: { browserName: 'chromium', channel: 'chrome', headless: false } },
        { name: 'chromium-headless', use: { browserName: 'chromium', headless: true, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36' } },
        { name: 'mobile-webkit-headed', use: { ...IPHONE, browserName: 'webkit', headless: false } },
        { name: 'mobile-webkit-headless', use: { ...IPHONE, browserName: 'webkit', headless: true } },
      ],

  reporter: [['list'], ['html', { open: 'never', outputFolder: HTML_REPORT_DIR }]],
});

export default config;
