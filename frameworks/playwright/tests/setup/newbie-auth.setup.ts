import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

const market = process.env.MARKET?.toLowerCase() || 'us';
dotenv.config({ path: path.resolve(__dirname, `../../../../.env.${market}`) });
import { chromium } from 'playwright';
import { setWhitelistedAnonId } from '../helpers/setWhitelistedAnonId';
import { setLocationCookie } from '../helpers/setLocationCookie';

function digitsOnly(value: string) {
  return value.replace(/\D/g, '');
}

async function main() {
  const phoneRaw = process.env.E2E_PHONE_NEWBIE;
  const otpRaw = process.env.E2E_OTP;

  if (!phoneRaw || !otpRaw) {
    throw new Error(
      'E2E_PHONE_NEWBIE and E2E_OTP must be set to generate newbie storageState.'
    );
  }

  const phone = digitsOnly(phoneRaw);
  const otp = otpRaw.trim();

  const repoRoot = process.cwd();
  const authDir = path.resolve(repoRoot, 'tests/.auth');
  const authPath = path.resolve(authDir, 'newbie-auth.json');
  fs.mkdirSync(authDir, { recursive: true });

  const isCI = /^(1|true|yes)$/i.test((process.env.CI ?? '').trim());
  const browser = await chromium.launch({ headless: isCI });
  const context = await browser.newContext();
  await setLocationCookie(context);
  const baseURL = (process.env.BASE_URL ?? 'https://www.talos.app').replace(/\/$/, '');
  await setWhitelistedAnonId(context, baseURL);
  const page = await context.newPage();

  await page.goto(`${baseURL}/user-registration`, { waitUntil: 'domcontentloaded' });

  await page.getByTestId('SignUpButton').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('SignUpButton').click();

  await page.getByTestId('phoneInput').fill(phone);
  await page.getByTestId('Next').click();

  const codeInput = page.getByTestId('codeInput');
  await codeInput.waitFor({ state: 'visible', timeout: 30_000 });
  await codeInput.click();
  await codeInput.fill('');
  await codeInput.type(otp, { delay: 25 });

  await Promise.race([
    codeInput.waitFor({ state: 'detached', timeout: 30_000 }),
    codeInput.waitFor({ state: 'hidden', timeout: 30_000 }),
    page.waitForURL((url) => !url.toString().includes('/user-registration'), { timeout: 30_000 }),
  ]);

  await page.goto(`${baseURL}/account`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);

  const postAuthUrl = page.url();
  if (postAuthUrl.includes('/user-registration') || postAuthUrl.includes('/login')) {
    throw new Error(`Auth did not persist. Landed on: ${postAuthUrl}`);
  }
  if (!/\/account(\?.*)?$/.test(postAuthUrl)) {
    throw new Error(`Expected to land on /account after auth. Landed on: ${postAuthUrl}`);
  }

  const signInLink = page.getByRole('link', { name: /sign in/i }).first();
  const signInVisible = await signInLink.isVisible().catch(() => false);
  if (signInVisible) {
    throw new Error('Auth did not persist. "Sign In" link is still visible on /account.');
  }

  await context.storageState({ path: authPath, indexedDB: true });

  await browser.close();
  // eslint-disable-next-line no-console
  console.log(`✅ Wrote storageState to: ${authPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('❌ Failed to generate newbie storageState:', err);
    process.exit(1);
  });
}
