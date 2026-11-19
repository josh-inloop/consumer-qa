import { test, expect, chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { setLocationCookie } from '../helpers/setLocationCookie';
import { setWhitelistedAnonId } from '../helpers/setWhitelistedAnonId';

const AUTH_STATE_PATH = path.resolve(process.cwd(), 'tests/.auth/auth.json');
const isCI = /^(1|true|yes)$/i.test((process.env.CI ?? '').trim());
const runAuthInCI = /^(1|true|yes)$/i.test((process.env.PW_RUN_AUTH_IN_CI ?? '').trim());
const forceFreshAuth = isCI && runAuthInCI;

// Local convenience: treat existing auth as "fresh enough" to avoid burning OTP.
// You can bump this up if auth sessions last longer for you.
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const USER_REG_PATH = '/user-registration';
const ACCOUNT_PATH = '/account';

function digitsOnly(value: string) {
  return value.replace(/\D/g, '');
}

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isFresh(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs < MAX_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Validates that an existing storageState can access an auth-gated route.
 * This prevents unnecessary OTP attempts when cookies are still valid but file mtime is old.
 */
async function existingAuthStillWorks(base: string): Promise<boolean> {
  if (!exists(AUTH_STATE_PATH)) return false;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: AUTH_STATE_PATH });
  const page = await ctx.newPage();

  try {
    const accountUrl = new URL(ACCOUNT_PATH, `${base}/`).toString();
    await page.goto(accountUrl, { waitUntil: 'domcontentloaded' });

    // Guard against transient /account before client redirects to auth.
    await page.waitForTimeout(1500);
    const url = page.url();
    if (url.includes('/user-registration') || url.includes('/login')) return false;
    if (!/\/account(\?.*)?$/.test(url)) return false;

    // Logged-out headers commonly expose "Sign In" entry points.
    const signInLink = page.getByRole('link', { name: /sign in/i }).first();
    if (await signInLink.isVisible().catch(() => false)) return false;

    return true;
  } catch {
    return false;
  } finally {
    await browser.close();
  }
}

async function persistedAuthStillWorks(page: import('@playwright/test').Page, base: string): Promise<boolean> {
  const browser = page.context().browser();
  if (!browser) return false;

  const ctx = await browser.newContext({ storageState: AUTH_STATE_PATH });
  await setWhitelistedAnonId(ctx, base);
  const p = await ctx.newPage();
  try {
    const accountUrl = new URL(ACCOUNT_PATH, `${base}/`).toString();
    await p.goto(accountUrl, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    const url = p.url();
    if (url.includes('/user-registration') || url.includes('/login')) return false;
    if (!/\/account(\?.*)?$/.test(url)) return false;

    const signInLink = p.getByRole('link', { name: /sign in/i }).first();
    if (await signInLink.isVisible().catch(() => false)) return false;

    return true;
  } catch {
    return false;
  } finally {
    await ctx.close();
  }
}

test('auth: generate storageState (local)', async ({ page, context, baseURL }) => {
  const phoneRaw = process.env.E2E_PHONE;
  const otpRaw = process.env.E2E_OTP;

  if (!phoneRaw || !otpRaw) {
    throw new Error(
      'E2E_PHONE and E2E_OTP must be set to generate storageState.\n' +
        'Set them in your local .env (dotenv/config is already loaded by config) and re-run.'
    );
  }

  const phone = digitsOnly(phoneRaw);
  const otp = otpRaw.trim();

  const resolvedBaseURL = (baseURL?.trim() || 'https://www.talos.app').replace(/\/+$/, '');

  // Ensure delivery location context exists for consistent auth + PDP behavior
  await setLocationCookie(context);
  await setWhitelistedAnonId(context, resolvedBaseURL);

  // 1) Fast path: reuse fresh auth.json (local only)
  if (!forceFreshAuth && isFresh(AUTH_STATE_PATH)) {
    test.skip(true, 'Reusing existing storageState (fresh)');
  }

  // 2) Smart reuse: validate existing auth.json before burning OTP (local only)
  if (!forceFreshAuth && (await existingAuthStillWorks(resolvedBaseURL))) {
    test.skip(true, 'Reusing existing storageState (validated)');
  }

  // At this point we truly need to generate a new auth.json
  fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });

  const signInUrl = new URL(USER_REG_PATH, `${resolvedBaseURL}/`).toString();
  await page.goto(signInUrl, { waitUntil: 'domcontentloaded' });

  // Start sign-in flow
  await expect(page.getByTestId('SignUpButton')).toBeVisible({ timeout: 45_000 });
  await page.getByTestId('SignUpButton').click();

  await expect(page.getByTestId('phoneInput')).toBeVisible({ timeout: 45_000 });
  const isUK = (process.env.MARKET ?? '').toUpperCase() === 'UK';
  if (isUK) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByTestId('phoneInput').click();
    await page.evaluate((num) => navigator.clipboard.writeText(num), phone);
    await page.keyboard.press('Control+V');
  } else {
    await page.getByTestId('phoneInput').fill(phone);
  }

  const nextBtn = page.getByTestId('Next');
  await expect(nextBtn).toBeVisible({ timeout: 45_000 });
  await expect(nextBtn).toBeEnabled({ timeout: 45_000 });
  await nextBtn.click();

  const tooManyAttempts = page.getByText(/too many attempts/i);
  const codeInput = page.getByTestId('codeInput');

  // Wait for either OTP input OR rate-limit message
  await Promise.race([
    codeInput.waitFor({ state: 'visible', timeout: 60_000 }),
    tooManyAttempts.waitFor({ state: 'visible', timeout: 60_000 }).then(() => {
      // Local-friendly behavior: if we have any prior auth.json, allow reuse.
      if (exists(AUTH_STATE_PATH)) {
        test.skip(true, 'Auth setup rate-limited; reusing existing auth.json');
      }
      throw new Error(
        'Auth setup rate-limited and no auth.json exists.\n' +
          'Wait for rate limit to clear, then rerun auth.setup.\n' +
          `Expected local storageState at: ${AUTH_STATE_PATH}`
      );
    }),
  ]);

  await codeInput.fill(otp);

  // Submit OTP: Enter is generally safe; some variants also require Next.
  await codeInput.press('Enter').catch(() => {});

  const nextAfterOtp = page.getByTestId('Next');
  if (await nextAfterOtp.isVisible().catch(() => false)) {
    await expect(nextAfterOtp).toBeEnabled({ timeout: 45_000 }).catch(() => {});
    await nextAfterOtp.click().catch(() => {});
  }

  // Prove auth sticks by forcing an auth-gated route.
  const accountUrl = new URL(ACCOUNT_PATH, `${resolvedBaseURL}/`).toString();
  await page.goto(accountUrl, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/account(\?.*)?$/);
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/account(\?.*)?$/);
  await expect(page.getByRole('link', { name: /sign in/i })).toHaveCount(0);

  // Save storageState for local authenticated tests
  await page.context().storageState({ path: AUTH_STATE_PATH, indexedDB: true });

  if (!(await persistedAuthStillWorks(page, resolvedBaseURL))) {
    throw new Error(
      'Saved storageState is not reusable in a fresh browser context.\n' +
        `Generated path: ${AUTH_STATE_PATH}`
    );
  }
});
